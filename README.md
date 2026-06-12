# Bulgarian Legal Scraper

A Cloudflare Worker that scrapes Bulgarian legislation from [lex.bg](https://lex.bg) and court case law from the Supreme Court of Cassation ([vks.bg](https://www.vks.bg)), embeds everything with the multilingual **BGE-M3** model on Workers AI, and indexes it into **Cloudflare Vectorize** so your agents can run semantic search over it. A daily cron re-checks every document and re-indexes only what actually changed.

## Architecture

```
                ┌────────────── daily cron (03:00 UTC) ──────────────┐
                ▼                                                    │
POST /admin/scrape ──► kickOff ──► Queue: discover jobs              │
                                      │ (one per lex.bg tree page /  │
                                      │  VKS month or date window)   │
                                      ▼                              │
                               Queue: doc jobs (one per document)    │
                                      ▼                              │
                     fetch page ► extract text ► sha256 hash         │
                                      │                              │
                        hash unchanged? ──► update last_checked ─────┘
                                      │ changed/new
                                      ▼
                 chunk (article-aware) ► embed (BGE-M3) ► Vectorize upsert
                                      ▼
                              D1 registry update

GET /search?q=... ──► embed query ──► Vectorize topK ──► JSON for your agents
```

| Piece | Cloudflare product | Purpose |
|---|---|---|
| Crawl pipeline | Queues | fan-out, retries, pacing (1 concurrent consumer, configurable delay) |
| Change detection | D1 | `documents` table with sha256 content hash per document |
| Embeddings | Workers AI `@cf/baai/bge-m3` | multilingual, 1024-dim, strong on Bulgarian |
| Vector store | Vectorize | cosine index, chunk text stored in metadata |
| Freshness | Cron trigger | daily incremental sweep |

**Plan requirement:** Queues require the Workers Paid plan ($5/mo). Vectorize, D1 and Workers AI are included (usage-priced beyond the free allowances).

## Data sources

| Source | What | How |
|---|---|---|
| `lexbg` | Constitution, codes (кодекси), laws (закони); optionally ordinances/regulations | Listing pages `lex.bg/laws/tree/{laws,code,ords,regs,reg_laws}` → documents `lex.bg/laws/ldoc/<id>`. Title from `#DocumentTitle`, body from `div.boxi.boxinb`. |
| `vks` | Supreme Court of Cassation acts (public since 1 Oct 2008) | Search results `vks.bg/spisak-aktove.jsp` (by date range) → acts `vks.bg/pregled-akt.jsp?type=ot-spisak&id=<id>`. |

Both sites reject non-browser clients with 403, so the worker sends a regular desktop-browser profile and decodes `windows-1251` responses where needed.

> **⚠ One-time VKS verification needed.** The result-page and act-page URLs above are confirmed, but the *query parameter names* that `search.html` submits to `spisak-aktove.jsp` could not be verified offline. Before the first VKS crawl: open <https://www.vks.bg/search.html>, run a date-range search with browser dev tools open (Network tab), and copy the real parameter names into `SEARCH_PARAMS` (and `formatDate` if the format differs) in [`src/sources/vks.ts`](src/sources/vks.ts). The `crawl_log` table records how many acts each discovery finds — a persistent `found=0` means the parameters still need adjusting.
>
> Alternative case-law source: [legalacts.justice.bg](https://legalacts.justice.bg) (the central register covering *all* courts). It is ASP.NET WebForms with viewstate, which is much more painful from a Worker — VKS was chosen as the highest-value, most scrape-friendly source. A `legalacts` adapter can be added later behind the same `SourceAdapter` interface.

## Setup

### Deploy via GitHub (recommended)

Every push to `main` runs typecheck + tests, provisions any missing Cloudflare resources, and deploys ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)). One-time setup:

1. In Cloudflare dashboard → **My Profile → API Tokens → Create Token**, create a token with these account permissions: **Workers Scripts: Edit**, **D1: Edit**, **Vectorize: Edit**, **Queues: Edit**.
2. In the GitHub repo → **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN` — the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` — from dashboard → Workers & Pages (right sidebar)
   - `WORKER_API_TOKEN` *(optional but recommended)* — any long random string; uploaded as the worker's `API_TOKEN` secret, which your agents send as a Bearer token
3. Push to `main`. The first deploy creates the Vectorize index (1024 dims, cosine, with `source`/`docId` metadata indexes), the D1 database (id is resolved and patched into `wrangler.jsonc` automatically at deploy time), both queues, and applies migrations.

### Manual deploy (alternative)

```bash
npm install
npx wrangler login
npm run provision    # same idempotent script CI uses: Vectorize + D1 + queues + migrations
npx wrangler secret put API_TOKEN   # any long random string for your agents
npm run deploy
```

### Initial backfill

```bash
# All laws + codes + constitution from lex.bg (a few thousand documents)
curl -X POST https://<your-worker>.workers.dev/admin/scrape \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"source": "lexbg", "mode": "full"}'

# VKS case backfill — only after verifying SEARCH_PARAMS (see warning above)
curl -X POST .../admin/scrape -H "Authorization: Bearer $API_TOKEN" \
  -d '{"source": "vks", "mode": "full"}'
```

The queue works through documents at ~1–2 pages/second (tunable via `CRAWL_DELAY_MS`). Watch progress with:

```bash
curl https://<your-worker>.workers.dev/status -H "Authorization: Bearer $API_TOKEN"
```

### Daily updates

The cron trigger (`0 3 * * *`) re-lists all sources every day, fetches each document, and compares its sha256 hash against D1. Unchanged documents cost one page fetch and a D1 update; only new or amended acts are re-chunked, re-embedded and re-upserted. Newly published laws appear automatically because discovery re-reads the listing pages each run.

## API (for your agents)

All endpoints except `/` require `Authorization: Bearer <API_TOKEN>`.

### `GET /search?q=<query>&topK=8&source=lexbg|vks`

```json
{
  "query": "давностен срок за вземания",
  "matches": [
    {
      "score": 0.78,
      "docId": "lexbg:2121934337",
      "title": "Закон за задълженията и договорите",
      "url": "https://lex.bg/laws/ldoc/2121934337",
      "article": "Чл. 110",
      "text": "Чл. 110. С изтичане на петгодишна давност се погасяват..."
    }
  ]
}
```

Plug this straight into an agent as a retrieval tool — e.g. a tool definition like *"search_bulgarian_law(query): returns relevant statutes and case excerpts with citations"* that GETs this endpoint. Each match carries the source URL and article number, so the agent can cite precisely.

### Other endpoints

| Endpoint | Purpose |
|---|---|
| `GET /status` | document counts per source/status, last index times, recent crawl log |
| `POST /admin/scrape` `{source?, mode?, force?}` | kick off a crawl; `force: true` re-embeds even unchanged docs |
| `POST /admin/index-url` `{source, url, docId?}` | index one specific document (useful for testing or seeding individual VKS acts) |

## Development

```bash
npm run typecheck
npm test            # chunking + URL pattern tests
npm run dev         # local worker (uses local D1/queue simulators)
```

### Code map

```
src/
├── index.ts          # fetch / scheduled (cron) / queue entrypoints
├── api.ts            # HTTP API: /search, /status, /admin/*
├── pipeline.ts       # kickoff, discovery fan-out, per-document index pipeline
├── lib/
│   ├── fetch.ts      # browser-profile fetch, retries, windows-1251 decoding
│   ├── html.ts       # HTMLRewriter text/link extraction
│   ├── chunk.ts      # article-aware chunking (Чл./§/Глава boundaries)
│   ├── embed.ts      # Workers AI BGE-M3 batching
│   └── hash.ts
└── sources/
    ├── lexbg.ts      # laws adapter (verified selectors/URLs)
    └── vks.ts        # cases adapter (verify SEARCH_PARAMS once — see above)
```

## Notes & caveats

- **Respectful crawling.** The data is public, but the worker still paces itself (single consumer concurrency + `CRAWL_DELAY_MS`). A full lex.bg laws+codes sweep is a few thousand requests spread over ~an hour.
- **Embedding costs** are incurred only on first index and when a document actually changes; the daily sweep itself only embeds amendments.
- **lex.bg markup changes**: selectors live at the top of `src/sources/lexbg.ts`; the `crawl_log` table makes silent breakage visible (`found=0` discoveries, `no usable content` errors).
- **Adding sources** (e.g. legalacts.justice.bg, Constitutional Court, ВАС): implement `SourceAdapter` in `src/sources/`, register it in `src/sources/index.ts`, add its id to `SourceId`.
