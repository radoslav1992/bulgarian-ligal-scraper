/**
 * Legal-aware chunking.
 *
 * Bulgarian statutes are structured as "Чл. 1. ... Чл. 2. ..." with chapter
 * headings (Глава, Раздел, Част) and transitional provisions (§). We split on
 * those boundaries first, then pack units into chunks of roughly `maxLen`
 * characters so a chunk never starts mid-article. Court decisions have no
 * article structure and fall back to paragraph packing with overlap.
 */

export interface Chunk {
  text: string;
  /** First article/paragraph label in the chunk, e.g. "Чл. 5" or "§ 3". */
  article?: string;
}

export interface ChunkOptions {
  maxLen: number;
  overlap: number;
}

const DEFAULTS: ChunkOptions = { maxLen: 1600, overlap: 200 };

const UNIT_BOUNDARY =
  /(?=\n(?:Чл\.\s*\d|§\s*\d|(?:ГЛАВА|Глава|РАЗДЕЛ|Раздел|ЧАСТ|Част)\s+[А-Яа-я\dIVXLC]|ПРЕХОДНИ|ЗАКЛЮЧИТЕЛНИ|ДОПЪЛНИТЕЛН))/;

const ARTICLE_LABEL = /^(Чл\.\s*\d+[а-я]?|§\s*\d+[а-я]?)/;

export function chunkLegalText(text: string, opts: Partial<ChunkOptions> = {}): Chunk[] {
  const { maxLen, overlap } = { ...DEFAULTS, ...opts };
  const normalized = text.trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= maxLen) {
    return [{ text: normalized, article: findLabel(normalized) }];
  }

  const units = ('\n' + normalized)
    .split(UNIT_BOUNDARY)
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  // No article structure detected (e.g. a court decision): pack paragraphs.
  if (units.length <= 1) {
    return packParagraphs(normalized, maxLen, overlap);
  }

  const chunks: Chunk[] = [];
  let buf = '';
  for (const unit of units) {
    if (buf.length > 0 && buf.length + unit.length + 1 > maxLen) {
      chunks.push({ text: buf, article: findLabel(buf) });
      buf = '';
    }
    if (unit.length > maxLen * 1.5) {
      // A single oversized article: flush and hard-split it by paragraphs.
      if (buf.length > 0) {
        chunks.push({ text: buf, article: findLabel(buf) });
        buf = '';
      }
      const label = findLabel(unit);
      for (const piece of packParagraphs(unit, maxLen, overlap)) {
        chunks.push({ text: piece.text, article: piece.article ?? label });
      }
      continue;
    }
    buf = buf.length > 0 ? `${buf}\n${unit}` : unit;
  }
  if (buf.length > 0) chunks.push({ text: buf, article: findLabel(buf) });
  return chunks;
}

function packParagraphs(text: string, maxLen: number, overlap: number): Chunk[] {
  const chunks: Chunk[] = [];
  const paragraphs = text.split('\n').filter((p) => p.trim().length > 0);
  let buf = '';
  for (const p of paragraphs) {
    if (buf.length > 0 && buf.length + p.length + 1 > maxLen) {
      chunks.push({ text: buf, article: findLabel(buf) });
      buf = buf.slice(Math.max(0, buf.length - overlap));
      const nl = buf.indexOf('\n');
      buf = nl >= 0 ? buf.slice(nl + 1) : buf;
    }
    // A single paragraph longer than maxLen gets hard-split.
    let rest = p;
    while (rest.length > maxLen) {
      const head = rest.slice(0, maxLen);
      chunks.push({ text: buf.length > 0 ? `${buf}\n${head}` : head, article: findLabel(buf || head) });
      rest = rest.slice(maxLen - overlap);
      buf = '';
    }
    buf = buf.length > 0 ? `${buf}\n${rest}` : rest;
  }
  if (buf.trim().length > 0) chunks.push({ text: buf, article: findLabel(buf) });
  return chunks;
}

function findLabel(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const m = ARTICLE_LABEL.exec(line.trim());
    if (m) return m[1];
  }
  return undefined;
}
