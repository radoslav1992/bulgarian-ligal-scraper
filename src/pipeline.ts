import { chunkLegalText } from './lib/chunk';
import { embedTexts } from './lib/embed';
import { sha256Hex } from './lib/hash';
import { enabledSources, getAdapter } from './sources';
import type { CrawlJob, CrawlMode, Env, SourceId } from './types';

/** Vectorize metadata values are capped at 10KiB per vector; stay well under. */
const METADATA_TEXT_LIMIT = 1800;
const TITLE_LIMIT = 300;

const VECTORIZE_UPSERT_BATCH = 500;
const QUEUE_SEND_BATCH = 100;

/** Enqueue discovery jobs for a crawl run. Returns the number of jobs queued. */
export async function kickOff(
  env: Env,
  mode: CrawlMode,
  sources?: SourceId[],
  force = false,
): Promise<number> {
  sources ??= enabledSources(env);
  const jobs: CrawlJob[] = [];
  for (const sourceId of sources) {
    const adapter = getAdapter(sourceId);
    for (const cursor of adapter.initialCursors(env, mode)) {
      jobs.push({ type: 'discover', source: sourceId, mode: force ? 'full' : mode, cursor });
    }
  }
  await sendJobs(env, jobs);
  await logEvent(env, sources.join('+'), 'kickoff', `mode=${mode} jobs=${jobs.length}`);
  return jobs.length;
}

export async function handleDiscover(env: Env, job: Extract<CrawlJob, { type: 'discover' }>): Promise<void> {
  const adapter = getAdapter(job.source);

  // A "doc:" cursor is a direct document reference, not a listing page.
  const docs = await adapter.discover(env, job.cursor);
  await logEvent(env, job.source, 'discover', `cursor=${job.cursor} found=${docs.length}`);
  if (docs.length === 0) return;

  const force = job.mode === 'full';
  await sendJobs(
    env,
    docs.map((d) => ({
      type: 'doc' as const,
      source: job.source,
      docId: d.docId,
      url: d.url,
      title: d.title,
      force,
    })),
  );
}

export type DocResult = 'indexed' | 'unchanged' | 'empty';

export interface DocRef {
  source: SourceId;
  docId: string;
  url: string;
  title?: string;
  force?: boolean;
}

export async function handleDoc(env: Env, job: Extract<CrawlJob, { type: 'doc' }>): Promise<DocResult> {
  const adapter = getAdapter(job.source);
  const doc = await adapter.fetchDocument(env, job.url);
  return indexExtracted(env, job, doc);
}

/** Hash-check, chunk, embed and upsert an already-extracted document. */
export async function indexExtracted(
  env: Env,
  job: DocRef,
  doc: { title: string; text: string } | null,
): Promise<DocResult> {
  const now = new Date().toISOString();

  if (!doc) {
    await env.DB.prepare(
      `INSERT INTO documents (doc_id, source, url, title, status, error, last_checked_at)
       VALUES (?1, ?2, ?3, ?4, 'error', 'no usable content', ?5)
       ON CONFLICT(doc_id) DO UPDATE SET status='error', error='no usable content', last_checked_at=?5`,
    )
      .bind(job.docId, job.source, job.url, job.title ?? null, now)
      .run();
    return 'empty';
  }

  const hash = await sha256Hex(doc.text);
  const existing = await env.DB.prepare(
    'SELECT content_hash, chunk_count FROM documents WHERE doc_id = ?1',
  )
    .bind(job.docId)
    .first<{ content_hash: string | null; chunk_count: number }>();

  if (existing?.content_hash === hash && !job.force) {
    await env.DB.prepare('UPDATE documents SET last_checked_at = ?2, status = ?3 WHERE doc_id = ?1')
      .bind(job.docId, now, 'indexed')
      .run();
    return 'unchanged';
  }

  const title = (doc.title || job.title || job.docId).slice(0, TITLE_LIMIT);
  const chunks = chunkLegalText(doc.text);

  // Prefix the title so each embedded chunk carries the document context.
  const vectors = await embedTexts(
    env,
    chunks.map((c) => `${title}\n${c.text}`),
  );

  const toUpsert: VectorizeVector[] = chunks.map((chunk, i) => ({
    id: `${job.docId}#${i}`,
    values: vectors[i]!,
    metadata: {
      docId: job.docId,
      source: job.source,
      url: job.url,
      title,
      article: chunk.article ?? '',
      idx: i,
      text: chunk.text.slice(0, METADATA_TEXT_LIMIT),
    },
  }));

  for (let i = 0; i < toUpsert.length; i += VECTORIZE_UPSERT_BATCH) {
    await env.VECTORS.upsert(toUpsert.slice(i, i + VECTORIZE_UPSERT_BATCH));
  }

  // Drop leftover vectors when the document shrank.
  const oldCount = existing?.chunk_count ?? 0;
  if (oldCount > chunks.length) {
    const stale: string[] = [];
    for (let i = chunks.length; i < oldCount; i++) stale.push(`${job.docId}#${i}`);
    await env.VECTORS.deleteByIds(stale);
  }

  await env.DB.prepare(
    `INSERT INTO documents (doc_id, source, url, title, content_hash, chunk_count, status, error, last_checked_at, last_indexed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'indexed', NULL, ?7, ?7)
     ON CONFLICT(doc_id) DO UPDATE SET
       url=?3, title=?4, content_hash=?5, chunk_count=?6, status='indexed', error=NULL,
       last_checked_at=?7, last_indexed_at=?7`,
  )
    .bind(job.docId, job.source, job.url, title, hash, chunks.length, now)
    .run();

  return 'indexed';
}

async function sendJobs(env: Env, jobs: CrawlJob[]): Promise<void> {
  for (let i = 0; i < jobs.length; i += QUEUE_SEND_BATCH) {
    await env.CRAWL_QUEUE.sendBatch(
      jobs.slice(i, i + QUEUE_SEND_BATCH).map((body) => ({ body })),
    );
  }
}

export async function logEvent(env: Env, source: string, event: string, detail: string): Promise<void> {
  await env.DB.prepare('INSERT INTO crawl_log (source, event, detail) VALUES (?1, ?2, ?3)')
    .bind(source, event, detail)
    .run();
}
