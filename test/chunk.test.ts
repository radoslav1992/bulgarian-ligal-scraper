import { describe, expect, it } from 'vitest';
import { chunkLegalText } from '../src/lib/chunk';

function makeLaw(articles: number, bodyLen = 300): string {
  const lines: string[] = ['ЗАКОН ЗА ПРИМЕРИТЕ', 'Глава първа', 'ОБЩИ ПОЛОЖЕНИЯ'];
  for (let i = 1; i <= articles; i++) {
    lines.push(`Чл. ${i}. ${'Това е примерен нормативен текст. '.repeat(Math.ceil(bodyLen / 35))}`);
  }
  return lines.join('\n');
}

describe('chunkLegalText', () => {
  it('returns a single chunk for short texts', () => {
    const chunks = chunkLegalText('Чл. 1. Кратък закон.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.article).toBe('Чл. 1');
  });

  it('returns empty array for empty input', () => {
    expect(chunkLegalText('   ')).toEqual([]);
  });

  it('splits long laws on article boundaries', () => {
    const chunks = chunkLegalText(makeLaw(30));
    expect(chunks.length).toBeGreaterThan(3);
    // Every chunk after the preamble should start at an article boundary.
    for (const chunk of chunks.slice(1)) {
      expect(chunk.text.trimStart()).toMatch(/^(Чл\.|§|Глава|ГЛАВА|Раздел|РАЗДЕЛ|Част|ЧАСТ|ПРЕХОДНИ|ЗАКЛЮЧИТЕЛНИ|ДОПЪЛНИТЕЛН)/);
    }
  });

  it('respects the max length for article-structured text', () => {
    const chunks = chunkLegalText(makeLaw(50), { maxLen: 1600 });
    for (const chunk of chunks) {
      // Oversized single articles may exceed maxLen slightly via packing, but
      // normal packing must stay below maxLen + one article.
      expect(chunk.text.length).toBeLessThan(1600 * 2);
    }
  });

  it('labels chunks with their first article', () => {
    const chunks = chunkLegalText(makeLaw(40));
    const labels = chunks.map((c) => c.article).filter(Boolean);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels[labels.length - 1]).toMatch(/^Чл\. \d+/);
  });

  it('handles unstructured text (court decisions) via paragraph packing', () => {
    const decision = Array.from({ length: 60 }, (_, i) =>
      `Параграф ${i + 1} от мотивите на съда, който описва фактическата обстановка по делото.`,
    ).join('\n');
    const chunks = chunkLegalText(decision, { maxLen: 800, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.text.length <= 1600)).toBe(true);
  });

  it('hard-splits a single oversized article', () => {
    const text = `Чл. 1. ${'дълъг текст без нови редове '.repeat(300)}`;
    const chunks = chunkLegalText(text, { maxLen: 1000, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});
