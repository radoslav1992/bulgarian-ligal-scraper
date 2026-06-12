import { describe, expect, it } from 'vitest';

// Keep these in sync with src/sources/lexbg.ts and src/sources/vks.ts.
const LDOC_HREF = /\/(?:bg\/)?(?:mobile\/)?laws\/ldoc\/(\d+)/;
const ACT_HREF = /pregled-akt(?:\.jsp)?\?[^"'\s]*id=([0-9A-Fa-f]{16,})/;

describe('lex.bg document link pattern', () => {
  it.each([
    ['https://lex.bg/laws/ldoc/2135180800', '2135180800'],
    ['/laws/ldoc/2135588748', '2135588748'],
    ['/bg/laws/ldoc/521957377', '521957377'],
    ['https://lex.bg/bg/mobile/ldoc/2135180800', null], // mobile pages link without /laws/
  ])('%s', (href, expected) => {
    const m = LDOC_HREF.exec(href);
    expect(m?.[1] ?? null).toBe(expected);
  });

  it('ignores tree and unrelated links', () => {
    expect(LDOC_HREF.test('/laws/tree/laws')).toBe(false);
    expect(LDOC_HREF.test('https://news.lex.bg/article/123')).toBe(false);
  });
});

describe('vks.bg act link pattern', () => {
  it.each([
    'https://www.vks.bg/pregled-akt.jsp?id=51A2C407C78E4687C2258542003C0139&type=ot-spisak',
    'http://www.vks.bg/pregled-akt?type=ot-spisak&id=BCDAD2B498BC7A9AC2257869004BF562',
    'pregled-akt.jsp?type=ot-delo&id=34AE7DD07BE63F33C225856C002FCC8F',
  ])('matches %s', (href) => {
    const m = ACT_HREF.exec(href);
    expect(m?.[1]).toMatch(/^[0-9A-Fa-f]{32}$/);
  });

  it('ignores non-act links', () => {
    expect(ACT_HREF.test('https://www.vks.bg/spisak-aktove.jsp?from_date=01.01.2024')).toBe(false);
    expect(ACT_HREF.test('/novini.html')).toBe(false);
  });
});
