import { embedQuery } from './lib/embed';
import { probeUrl } from './lib/fetch';
import { indexExtracted, kickOff } from './pipeline';
import { ALL_SOURCES, enabledSources, getAdapter } from './sources';
import type { CrawlMode, Env, SourceId } from './types';

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/' && req.method === 'GET') {
    return json({
      name: 'bulgarian-legal-scraper',
      endpoints: {
        'GET /search?q=...&topK=8&source=lexbg|vks': 'semantic search over indexed laws and cases',
        'GET /status': 'index statistics',
        'POST /admin/scrape {source?, mode?, force?}': 'kick off a crawl (mode: full|incremental)',
        'POST /admin/index-url {source, docId, url}': 'index a single document by URL',
      },
    });
  }

  if (!authorized(req, env)) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (url.pathname === '/search' && req.method === 'GET') {
    return search(url, env);
  }
  if (url.pathname === '/status' && req.method === 'GET') {
    return status(env);
  }
  if (url.pathname === '/admin/scrape' && req.method === 'POST') {
    return adminScrape(req, env);
  }
  if (url.pathname === '/admin/index-url' && req.method === 'POST') {
    return adminIndexUrl(req, env);
  }
  if (url.pathname === '/admin/test-fetch' && req.method === 'GET') {
    return adminTestFetch(url);
  }
  if (url.pathname === '/ingest' && req.method === 'POST') {
    return ingest(req, env);
  }

  return json({ error: 'not found' }, 404);
}

function authorized(req: Request, env: Env): boolean {
  // No token configured (local dev) → open access.
  if (!env.API_TOKEN) return true;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${env.API_TOKEN}`;
}

async function search(url: URL, env: Env): Promise<Response> {
  const q = url.searchParams.get('q')?.trim();
  if (!q) return json({ error: 'missing query parameter q' }, 400);

  const topK = Math.min(Number(url.searchParams.get('topK') ?? '8') || 8, 20);
  const source = url.searchParams.get('source');
  if (source && !ALL_SOURCES.includes(source as SourceId)) {
    return json({ error: `unknown source; expected one of ${ALL_SOURCES.join(', ')}` }, 400);
  }

  const vector = await embedQuery(env, q);
  const result = await env.VECTORS.query(vector, {
    topK,
    returnValues: false,
    returnMetadata: 'all',
    ...(source ? { filter: { source } } : {}),
  });

  return json({
    query: q,
    matches: result.matches.map((m) => ({
      score: m.score,
      docId: m.metadata?.docId,
      title: m.metadata?.title,
      url: m.metadata?.url,
      article: m.metadata?.article || undefined,
      text: m.metadata?.text,
    })),
  });
}

async function status(env: Env): Promise<Response> {
  const bySource = await env.DB.prepare(
    `SELECT source, status, COUNT(*) AS n, SUM(chunk_count) AS chunks, MAX(last_indexed_at) AS last_indexed
     FROM documents GROUP BY source, status`,
  ).all();
  const recentLog = await env.DB.prepare(
    'SELECT ts, source, event, detail FROM crawl_log ORDER BY id DESC LIMIT 20',
  ).all();
  return json({ documents: bySource.results, recentActivity: recentLog.results });
}

async function adminScrape(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ source?: SourceId; mode?: CrawlMode; force?: boolean; override?: boolean }>(req);
  // An explicit source always works (e.g. a deliberate VKS run); the default
  // covers only the sources enabled via ENABLED_SOURCES.
  const sources = body.source ? [body.source] : enabledSources(env);
  if (body.source && !ALL_SOURCES.includes(body.source)) {
    return json({ error: `unknown source; expected one of ${ALL_SOURCES.join(', ')}` }, 400);
  }
  if ((env.SCRAPE_MODE ?? 'worker') === 'push' && !body.override) {
    return json(
      {
        error:
          'SCRAPE_MODE=push: the worker cannot fetch lex.bg directly (datacenter IPs are challenged). ' +
          'Run scripts/local-crawl.mjs from an allowed network, or pass {"override": true} to force queue crawling.',
      },
      409,
    );
  }
  const mode: CrawlMode = body.mode === 'full' ? 'full' : 'incremental';
  const queued = await kickOff(env, mode, sources, body.force ?? false);
  return json({ ok: true, mode, sources, discoveryJobsQueued: queued });
}

async function adminIndexUrl(req: Request, env: Env): Promise<Response> {  const body = await readJson<{ source?: SourceId; docId?: string; url?: string; force?: boolean }>(req);
  if (!body.source || !body.url || !ALL_SOURCES.includes(body.source)) {
    return json({ error: 'required: source (lexbg|vks), url; optional: docId, force' }, 400);
  }
  const docId = body.docId ?? `${body.source}:${body.url.replace(/[^\w]+/g, '_').slice(-64)}`;
  await env.CRAWL_QUEUE.send({
    type: 'doc',
    source: body.source,
    docId,
    url: body.url,
    force: body.force ?? true,
  });
  return json({ ok: true, queued: docId });
}

/**
 * Push path: an external feeder (scripts/local-crawl.mjs) fetches pages from
 * a network lex.bg accepts and posts the raw HTML here; the worker extracts,
 * hash-checks, chunks, embeds and indexes it.
 */
async function ingest(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    source?: SourceId;
    docId?: string;
    url?: string;
    title?: string;
    html?: string;
    text?: string;
    force?: boolean;
  }>(req);
  if (!body.source || !ALL_SOURCES.includes(body.source) || !body.url || (!body.html && !body.text)) {
    return json(
      { error: 'required: source (lexbg|vks), url, and html or text; optional: docId, title, force' },
      400,
    );
  }
  const adapter = getAdapter(body.source);
  const docId = body.docId ?? adapter.docIdForUrl(body.url);
  if (!docId) {
    return json({ error: `cannot derive docId from url; pass docId explicitly` }, 400);
  }
  // Pre-extracted plain text bypasses HTML extraction (e.g. bulk-loading an
  // existing scrape dump); raw HTML goes through the source adapter.
  const doc = body.text
    ? { title: body.title ?? docId, text: body.text }
    : await adapter.extract(env, body.url, body.html!);
  const result = await indexExtracted(
    env,
    { source: body.source, docId, url: body.url, title: body.title, force: body.force },
    doc,
  );
  return json({ ok: true, docId, result });
}

/** Try several header profiles against a scrape-target URL; diagnostics for 403s. */
async function adminTestFetch(url: URL): Promise<Response> {
  const target = url.searchParams.get('url') ?? 'https://lex.bg/laws/tree/laws';
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    return json({ error: 'invalid url' }, 400);
  }
  // Not an open proxy: only the sites this worker scrapes.
  if (!/(^|\.)(lex\.bg|vks\.bg)$/.test(host)) {
    return json({ error: 'url must be on lex.bg or vks.bg' }, 400);
  }
  return json({ target, results: await probeUrl(target) });
}

async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
