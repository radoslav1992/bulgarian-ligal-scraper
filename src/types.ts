export type SourceId = 'lexbg' | 'vks';

export type CrawlMode = 'incremental' | 'full';

export type CrawlJob =
  | {
      /** Fetch one listing page and enqueue a `doc` job per discovered document. */
      type: 'discover';
      source: SourceId;
      mode: CrawlMode;
      /** Adapter-specific position, e.g. "tree:laws" (lex.bg) or "year:2012" (VKS). */
      cursor: string;
    }
  | {
      /** Fetch, hash-compare and (re)index a single document. */
      type: 'doc';
      source: SourceId;
      docId: string;
      url: string;
      title?: string;
      /** Re-embed even when the content hash is unchanged. */
      force?: boolean;
    };

export interface Env {
  AI: Ai;
  VECTORS: VectorizeIndex;
  DB: D1Database;
  CRAWL_QUEUE: Queue<CrawlJob>;
  API_TOKEN?: string;
  ENABLED_SOURCES?: string;
  LEXBG_TREES?: string;
  VKS_RECENT_DAYS?: string;
  VKS_BACKFILL_FROM_YEAR?: string;
  CRAWL_DELAY_MS?: string;
}

export interface ExtractedDocument {
  title: string;
  /** Cleaned plain text of the law / court act. */
  text: string;
  meta?: Record<string, string>;
}

export interface DiscoveredDoc {
  docId: string;
  url: string;
  title?: string;
}
