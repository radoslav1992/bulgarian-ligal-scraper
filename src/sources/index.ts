import type { SourceId } from '../types';
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
