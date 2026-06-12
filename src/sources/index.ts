import type { Env, SourceId } from '../types';
import { lexbg } from './lexbg';
import type { SourceAdapter } from './types';
import { vks } from './vks';

const ADAPTERS: Record<SourceId, SourceAdapter> = { lexbg, vks };

export function getAdapter(id: SourceId): SourceAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`Unknown source: ${id}`);
  return adapter;
}

export const ALL_SOURCES: SourceId[] = ['lexbg', 'vks'];

/**
 * Sources covered by the daily cron and by /admin/scrape when no explicit
 * source is given. VKS stays implemented but off until enabled via the
 * ENABLED_SOURCES var (and its SEARCH_PARAMS are verified).
 */
export function enabledSources(env: Env): SourceId[] {
  const raw = env.ENABLED_SOURCES ?? 'lexbg';
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SourceId => ALL_SOURCES.includes(s as SourceId));
  return ids.length > 0 ? ids : ['lexbg'];
}
