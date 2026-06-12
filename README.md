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

| Source | Default | What | How |
|---|---|---|---|
| `lexbg` | **enabled** | Constitution, codes (кодекси), laws (закони); optionally ordinances/regulations | Listing pages `lex.bg/laws/tree/{laws,code,ords,regs,reg_laws}` → documents `lex.bg/laws/ldoc/<id>`. Title from `#DocumentTitle`, body from `div.boxi.boxinb`. |
| `vks` | disabled | Supreme Court of Cassation acts (public since 1 Oct 2008) | Search results `vks.bg/spisak-aktove.jsp` (by date range) → acts `vks.bg/pregled-akt.jsp?type=ot-spisak&id=<id>`. |

Only `lexbg` is active out of the box (`ENABLED_SOURCES` in `wrangler.jsonc`); the daily cron and default scrape calls touch laws only. To turn on case law later: verify the VKS search parameters (below), set `ENABLED_SOURCES` to `lexbg,vks`, redeploy, and run a one-time `POST /admin/scrape {"source":"vks","mode":"full"}`.

Both sites reject non-browser clients with 403, and **lex.bg sits behind Cloudflare bot protection that challenges datacenter IPs** — including Workers egress and GitHub Actions runners (verified). Page *fetching* therefore runs outside Cloudflare in the default configuration:

### Fetch path (`SCRAPE_MODE`)

- **`push` (default):** [`scripts/local-crawl.mjs`](scripts/local-crawl.mjs) runs on any machine whose IP lex.bg accepts (home connection, VPS) — it discovers and downloads pages, then posts the raw HTML to the worker's `POST /ingest`, where extraction, hash-based change detection, chunking, embedding and indexing happen. Run it from cron for the daily sweep:

  ```cron
  0 3 * * * cd /opt/bulgarian-legal-scraper && WORKER_URL=https://... API_TOKEN=... node scripts/local-crawl.mjs >> /var/log/legal-crawl.log 2>&1
  ```

  `/ingest` also accepts pre-extracted plain `text` instead of `html`, so an existing scrape dump can be bulk-loaded without re-fetching anything.

- **`worker`:** the original in-Cloudflare crawl (cron → queue → fetch). Kept for the case where the target site is reachable from Workers; `GET /admin/test-fetch?url=...` shows what a target returns to the worker.

> **⚠ One-time VKS verification needed.** The result-page and act-page URLs above are confirmed, but the *query parameter names* that `search.html` submits to `spisak-aktove.jsp` could not be verified offline. Before the first VKS crawl: open <https://www.vks.bg/search.html>, run a date-range search with browser dev tools open (Network tab), and copy the real parameter names into `SEARCH_PARAMS` (and `formatDate` if the format differs) in [`src/sources/vks.ts`](src/sources/vks.ts). The `crawl_log` table records how many acts each discovery finds — a persistent `found=0` means the parameters still need adjusting.
>
> Alternative case-law source: [legalacts.justice.bg](https://legalacts.justice.bg) (the central register covering *all* courts). It is ASP.NET WebForms with viewstate, which is much more painful from a Worker — VKS was chosen as the highest-value, most scrape-friendly source. A `legalacts` adapter can be added later behind the same `SourceAdapter` interface.

## Setup

### Deploy via Cloudflare Workers Builds (recommended)

1. **Workers Paid plan** — dashboard → Billing → subscribe ($5/mo; Vectorize requires it).
2. **Connect the repo** — dashboard → Workers & Pages → Create → *Import a repository* → authorize the Cloudflare GitHub app for this repo, branch `main`. Set the **deploy command** to:
   ```
   node scripts/provision.mjs && npx wrangler deploy
   ```
   The provision script idempotently creates the Vectorize index (+ metadata indexes), the D1 database (and patches its id into the config at build time), both queues, and applies migrations. If Cloudflare opens a PR syncing config back into the repo, review and merge it.
3. **If the first build fails on provisioning** (the build token may lack resource-creation rights), run it once from your machine, then retry the build — after that you can shorten the deploy command to plain `npx wrangler deploy`:
   ```bash
   npx wrangler login
   npm run provision
   ```
4. **API token for your agents** — dashboard → your worker → Settings → Variables and Secrets → add **secret** `API_TOKEN` (any long random string), or `npx wrangler secret put API_TOKEN`. Without it the API is publicly accessible.

Every push to `main` then deploys automatically; GitHub Actions ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) runs typecheck + tests on each push/PR.

### Manual deploy (alternative)

```bash
npm install
npx wrangler login
npm run provision    # same idempotent script CI uses: Vectorize + D1 + queues + migrations
npx wrangler secret put API_TOKEN   # any long random string for your agents
npm run deploy
```

### Initial backfill

From a machine whose IP lex.bg accepts (test with `curl -s -o /dev/null -w "%{http_code}" -A "Mozilla/5.0" https://lex.bg/laws/tree/laws` — you want `200`, not `403`):

```bash
WORKER_URL=https://<your-worker>.workers.dev API_TOKEN=<token> \
  node scripts/local-crawl.mjs            # all laws + codes + constitution

# smoke test first: just 5 documents
node scripts/local-crawl.mjs --limit 5
```

Watch progress with:

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
