import { fetchHtml } from '../lib/fetch';
import { extractLinks, extractText, normalizeWhitespace } from '../lib/html';
import type { CrawlMode, DiscoveredDoc, Env, ExtractedDocument } from '../types';
import type { SourceAdapter } from './types';

/**
 * lex.bg — the Bulgarian legal portal mirroring the State Gazette.
 *
 * Site structure (verified):
 *  - Tree (listing) pages: https://lex.bg/laws/tree/{laws,code,ords,regs,reg_laws}
 *  - Documents:            https://lex.bg/laws/ldoc/<numeric id>
 *  - Constitution:         https://lex.bg/laws/ldoc/521957377
 *  - Document title lives in #DocumentTitle, body text in <div class="boxi boxinb">.
 *  - The site rejects non-browser user agents with 403 (handled in lib/fetch).
 */

const BASE = 'https://lex.bg';

const TREE_PATHS: Record<string, string> = {
  laws: '/laws/tree/laws',       // закони
  code: '/laws/tree/code',       // кодекси
  ords: '/laws/tree/ords',       // наредби
  regs: '/laws/tree/regs',       // правилници
  reg_laws: '/laws/tree/reg_laws', // правилници по прилагане
};

const CONSTITUTION_ID = '521957377';

const LDOC_HREF = /\/(?:bg\/)?(?:mobile\/)?laws\/ldoc\/(\d+)/;

const TITLE_SELECTORS = ['#DocumentTitle', '.TitleDocument'];
const BODY_SELECTORS = ['div.boxinb', '.boxi', '#ContentPlaceholder', 'body'];

export const lexbg: SourceAdapter = {
  id: 'lexbg',

  initialCursors(env: Env, _mode: CrawlMode): string[] {
    const trees = (env.LEXBG_TREES ?? 'laws,code')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t in TREE_PATHS);
    // The constitution is a single document, not a tree.
    return [...trees.map((t) => `tree:${t}`), `doc:${CONSTITUTION_ID}`];
  },

  async discover(_env: Env, cursor: string): Promise<DiscoveredDoc[]> {
    if (cursor.startsWith('doc:')) {
      const id = cursor.slice(4);
      return [{ docId: `lexbg:${id}`, url: `${BASE}/laws/ldoc/${id}` }];
    }
    const tree = cursor.replace(/^tree:/, '');
    const path = TREE_PATHS[tree];
    if (!path) throw new Error(`Unknown lex.bg cursor: ${cursor}`);

    const html = await fetchHtml(`${BASE}${path}`);
    const seen = new Set<string>();
    const docs: DiscoveredDoc[] = [];
    for (const link of await extractLinks(html)) {
      const m = LDOC_HREF.exec(link.href);
      if (!m?.[1] || seen.has(m[1])) continue;
      seen.add(m[1]);
      docs.push({
        docId: `lexbg:${m[1]}`,
        url: `${BASE}/laws/ldoc/${m[1]}`,
        title: link.text || undefined,
      });
    }
    return docs;
  },

  async fetchDocument(_env: Env, url: string): Promise<ExtractedDocument | null> {
    const html = await fetchHtml(url);

    let title = normalizeWhitespace(await extractText(html, TITLE_SELECTORS));
    if (!title) {
      const m = /<title>([^<]*)<\/title>/i.exec(html);
      // Page titles look like "Lex.bg - Закон за задълженията и договорите".
      title = normalizeWhitespace((m?.[1] ?? '').replace(/^Lex\.bg\s*[-–|]\s*/i, ''));
    }

    const text = await extractText(html, BODY_SELECTORS);
    if (text.length < 200) return null;

    return { title: title || 'Без заглавие', text };
  },
};
