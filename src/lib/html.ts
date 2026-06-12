/**
 * HTML extraction helpers built on the Workers-native HTMLRewriter.
 *
 * HTMLRewriter is a streaming parser: text handlers only fire for text nodes
 * whose immediate parent matches the selector, so to collect a container's
 * full text we register both `selector` and `selector *`.
 */

export interface Link {
  href: string;
  text: string;
}

/** Remove elements whose text content must never leak into extracted text. */
export function stripNoise(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Collect all `<a href>` links (with their anchor text) from an HTML page. */
export async function extractLinks(html: string): Promise<Link[]> {
  const links: Link[] = [];
  let current: Link | null = null;

  const rewriter = new HTMLRewriter().on('a[href]', {
    element(el) {
      const href = el.getAttribute('href');
      current = href ? { href, text: '' } : null;
      if (current) {
        const link = current;
        links.push(link);
        el.onEndTag(() => {
          if (current === link) current = null;
        });
      }
    },
    text(t) {
      if (current) current.text += t.text;
    },
  });

  await consume(rewriter.transform(new Response(html)));
  for (const l of links) l.text = normalizeWhitespace(l.text);
  return links;
}

/**
 * Return the text content of the first selector (in priority order) that
 * matches a non-empty element. Block-level boundaries become line breaks.
 */
export async function extractText(html: string, selectors: string[]): Promise<string> {
  const clean = stripNoise(html);
  for (const selector of selectors) {
    const text = await extractTextBySelector(clean, selector);
    if (text.length > 0) return text;
  }
  return '';
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article',
]);

async function extractTextBySelector(html: string, selector: string): Promise<string> {
  let out = '';
  const handler = {
    element(el: Element) {
      if (BLOCK_TAGS.has(el.tagName)) out += '\n';
    },
    text(t: Text) {
      out += t.text;
    },
  };

  const rewriter = new HTMLRewriter().on(selector, handler).on(`${selector} *`, handler);
  await consume(rewriter.transform(new Response(html)));
  return normalizeText(out);
}

/** Drain a transformed response so the rewriter actually runs. */
async function consume(res: Response): Promise<void> {
  await res.text();
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Collapse intra-line whitespace but keep paragraph structure. */
export function normalizeText(s: string): string {
  return s
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
