import type { CrawlMode, DiscoveredDoc, Env, ExtractedDocument, SourceId } from '../types';

export interface SourceAdapter {
  id: SourceId;

  /** Cursors to enqueue as `discover` jobs when a crawl is kicked off. */
  initialCursors(env: Env, mode: CrawlMode): string[];

  /** Fetch one listing page (identified by cursor) and return document links. */
  discover(env: Env, cursor: string): Promise<DiscoveredDoc[]>;

  /** Fetch and extract a single document. Returns null when there is no usable content. */
  fetchDocument(env: Env, url: string): Promise<ExtractedDocument | null>;
}
