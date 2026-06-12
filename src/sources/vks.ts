import { fetchHtml } from '../lib/fetch';
import { extractLinks, extractText, normalizeWhitespace } from '../lib/html';
import type { CrawlMode, DiscoveredDoc, Env, ExtractedDocument } from '../types';
import type { SourceAdapter } from './types';

/**
 * vks.bg — Supreme Court of Cassation (Върховен касационен съд).
 *
 * Full text of VKS acts is public for everything issued after 1 Oct 2008.
 * Site structure (verified):
 *  - Search form:    https://www.vks.bg/search.html
 *  - Search results: https://www.vks.bg/spisak-aktove.jsp
 *  - Individual act: https://www.vks.bg/pregled-akt.jsp?type=ot-spisak&id=<32-char hex Domino id>
 *
 * ⚠ SEARCH_PARAMS below are a best guess — the exact form field names could
 * not be confirmed offline. Verify once before the first VKS crawl:
 * open https://www.vks.bg/search.html, run a search by date range with
 * browser dev tools open, and copy the real query parameter names from the
 * request to spisak-aktove.jsp into SEARCH_PARAMS / DATE_FORMAT below.
 * Discovery logs a `discover` event with the hit count to crawl_log, so a
 * persistent 0 means the parameters still need adjusting.
 */

const BASE = 'https://www.vks.bg';
const SEARCH_RESULTS_URL = `${BASE}/spisak-aktove.jsp`;

/** Query parameter names sent to spisak-aktove.jsp — verify against the live form. */
const SEARCH_PARAMS = {
  dateFrom: 'from_date',
  dateTo: 'to_date',
};

/** dd.mm.yyyy is the date format used across vks.bg. */
function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

const ACT_HREF = /pregled-akt(?:\.jsp)?\?[^"'\s]*id=([0-9A-Fa-f]{16,})/;

const BODY_SELECTORS = ['#act_text', '.act', '#content', '.content', 'main', 'body'];

export const vks: SourceAdapter = {
  id: 'vks',

  initialCursors(env: Env, mode: CrawlMode): string[] {
    if (mode === 'incremental') {
      const days = Number(env.VKS_RECENT_DAYS ?? '30') || 30;
      return [`recent:${days}`];
    }
    // Full backfill: one discovery job per month since acts became public,
    // keeping each result page small enough to parse reliably.
    const fromYear = Number(env.VKS_BACKFILL_FROM_YEAR ?? '2008') || 2008;
    const now = new Date();
    const cursors: string[] = [];
    for (let y = fromYear; y <= now.getFullYear(); y++) {
      const lastMonth = y === now.getFullYear() ? now.getMonth() + 1 : 12;
      for (let m = 1; m <= lastMonth; m++) {
        cursors.push(`month:${y}-${String(m).padStart(2, '0')}`);
      }
    }
    return cursors;
  },

  async discover(_env: Env, cursor: string): Promise<DiscoveredDoc[]> {
    let from: Date;
    let to: Date;
    if (cursor.startsWith('recent:')) {
      const days = Number(cursor.slice(7)) || 30;
      to = new Date();
      from = new Date(Date.now() - days * 86_400_000);
    } else if (cursor.startsWith('month:')) {
      const [y, m] = cursor.slice(6).split('-').map(Number);
      if (!y || !m) throw new Error(`Bad VKS cursor: ${cursor}`);
      from = new Date(Date.UTC(y, m - 1, 1));
      to = new Date(Date.UTC(y, m, 0));
    } else {
      throw new Error(`Unknown VKS cursor: ${cursor}`);
    }

    const url =
      `${SEARCH_RESULTS_URL}?${SEARCH_PARAMS.dateFrom}=${encodeURIComponent(formatDate(from))}` +
      `&${SEARCH_PARAMS.dateTo}=${encodeURIComponent(formatDate(to))}`;
    const html = await fetchHtml(url);

    const seen = new Set<string>();
    const docs: DiscoveredDoc[] = [];
    for (const link of await extractLinks(html)) {
      const m = ACT_HREF.exec(link.href);
      if (!m?.[1]) continue;
      const id = m[1].toUpperCase();
      if (seen.has(id)) continue;
      seen.add(id);
      docs.push({
        docId: `vks:${id}`,
        url: `${BASE}/pregled-akt.jsp?type=ot-spisak&id=${id}`,
        title: link.text || undefined,
      });
    }
    return docs;
  },

  docIdForUrl(url: string): string | null {
    const m = ACT_HREF.exec(url);
    return m?.[1] ? `vks:${m[1].toUpperCase()}` : null;
  },

  async fetchDocument(env: Env, url: string): Promise<ExtractedDocument | null> {
    return this.extract(env, url, await fetchHtml(url));
  },

  async extract(_env: Env, _url: string, html: string): Promise<ExtractedDocument | null> {
    const m = /<title>([^<]*)<\/title>/i.exec(html);
    const title = normalizeWhitespace(m?.[1] ?? '');

    const text = await extractText(html, BODY_SELECTORS);
    // Court acts are substantial documents; very short pages are error or
    // navigation-only pages.
    if (text.length < 300) return null;

    return { title: title || 'Съдебен акт (ВКС)', text };
  },
};
