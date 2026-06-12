#!/usr/bin/env node
/**
 * lex.bg feeder — runs OUTSIDE Cloudflare, on any machine whose IP lex.bg
 * accepts (home connection, VPS, ...). Discovers law documents, fetches their
 * HTML and posts it to the worker's /ingest endpoint, where extraction,
 * hash-based change detection, chunking, embedding and Vectorize indexing
 * happen. Unchanged documents are skipped server-side, so running this daily
 * re-embeds only amendments.
 *
 * Usage:
 *   WORKER_URL=https://bulgarian-legal-scraper.<subdomain>.workers.dev \
 *   API_TOKEN=<token> \
 *   node scripts/local-crawl.mjs [--trees laws,code] [--limit N] [--force] [--delay 500]
 *
 * Cron example (daily at 03:00, on a VPS):
 *   0 3 * * * cd /opt/bulgarian-legal-scraper && WORKER_URL=... API_TOKEN=... node scripts/local-crawl.mjs >> /var/log/legal-crawl.log 2>&1
 *
 * Requires Node 18+ (built-in fetch). No npm dependencies.
 */

const WORKER_URL = (process.env.WORKER_URL ?? argValue('--worker') ?? '').replace(/\/$/, '');
const API_TOKEN = process.env.API_TOKEN ?? argValue('--token');
const TREES = (argValue('--trees') ?? 'laws,code').split(',').map((t) => t.trim());
const LIMIT = Number(argValue('--limit') ?? '0') || Infinity;
const FORCE = process.argv.includes('--force');
const DELAY_MS = Number(argValue('--delay') ?? '500') || 500;

if (!WORKER_URL || !API_TOKEN) {
  console.error('Set WORKER_URL and API_TOKEN (env vars or --worker/--token flags).');
  process.exit(1);
}

const LEX_BASE = 'https://lex.bg';
const TREE_PATHS = {
  laws: '/laws/tree/laws',
  code: '/laws/tree/code',
  ords: '/laws/tree/ords',
  regs: '/laws/tree/regs',
  reg_laws: '/laws/tree/reg_laws',
};
const CONSTITUTION_ID = '521957377';
const LDOC_HREF = /\/(?:bg\/)?(?:mobile\/)?laws\/ldoc\/(\d+)/;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.5',
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  console.log(`[${new Date().toISOString()}] feeder start — trees: ${TREES.join(',')}`);

  // 1. Discover document ids from the tree pages (+ the constitution).
  const ids = new Set([CONSTITUTION_ID]);
  for (const tree of TREES) {
    const path = TREE_PATHS[tree];
    if (!path) {
      console.warn(`unknown tree "${tree}" — skipped`);
      continue;
    }
    const html = await fetchPage(`${LEX_BASE}${path}`);
    let count = 0;
    for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)) {
      const doc = LDOC_HREF.exec(m[1]);
      if (doc?.[1] && !ids.has(doc[1])) {
        ids.add(doc[1]);
        count++;
      }
    }
    console.log(`tree ${tree}: ${count} documents`);
    if (count === 0) console.warn(`tree ${tree} yielded 0 links — markup change or block page?`);
  }

  // 2. Fetch each document and push it to the worker.
  const stats = { indexed: 0, unchanged: 0, empty: 0, failed: 0 };
  let processed = 0;
  for (const id of ids) {
    if (processed >= LIMIT) break;
    processed++;
    const url = `${LEX_BASE}/laws/ldoc/${id}`;
    try {
      const html = await fetchPage(url);
      const res = await fetch(`${WORKER_URL}/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source: 'lexbg', url, html, force: FORCE }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`ingest HTTP ${res.status}: ${JSON.stringify(body)}`);
      stats[body.result] = (stats[body.result] ?? 0) + 1;
      console.log(`[${processed}/${Math.min(ids.size, LIMIT)}] ${body.docId}: ${body.result}`);
    } catch (err) {
      stats.failed++;
      console.error(`[${processed}] ${url} FAILED: ${err}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`[${new Date().toISOString()}] feeder done —`, stats);
  if (stats.failed > 0) process.exitCode = 2;
}

async function fetchPage(url, attempt = 0) {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const buf = await res.arrayBuffer();
    const text = decodeBody(buf, res.headers.get('content-type'));
    if (/<title>\s*Just a moment/i.test(text)) {
      throw new Error(`Cloudflare challenge page from ${url} — this IP is being blocked`);
    }
    return text;
  } catch (err) {
    if (attempt >= 3) throw err;
    await sleep(1000 * 3 ** attempt);
    return fetchPage(url, attempt + 1);
  }
}

/** lex.bg historically serves windows-1251; trust header/meta charset. */
function decodeBody(buf, contentType) {
  const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    /content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
