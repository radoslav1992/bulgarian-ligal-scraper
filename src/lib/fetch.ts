/**
 * Polite HTTP client for the scraped sites.
 *
 * lex.bg and vks.bg both reject obviously non-browser clients (403), so we
 * send a normal desktop browser profile. Older Bulgarian sites also still
 * serve windows-1251, so the body is decoded from the charset advertised in
 * the Content-Type header or a <meta charset> tag rather than assumed UTF-8.
 */

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'bg,en;q=0.5',
  'Upgrade-Insecure-Requests': '1',
};

const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

export async function fetchHtml(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      if (!res.ok) {
        // 4xx other than 429 will not get better on retry.
        throw new PermanentFetchError(`HTTP ${res.status} from ${url}`);
      }
      return await decodeBody(res);
    } catch (err) {
      if (err instanceof PermanentFetchError) throw err;
      lastError = err;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
  }
  throw new Error(`Failed to fetch ${url}: ${String(lastError)}`);
}

export class PermanentFetchError extends Error {}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function decodeBody(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  const headerCharset = charsetFromContentType(res.headers.get('content-type'));
  const charset = headerCharset ?? sniffMetaCharset(buf) ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function charsetFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const m = /charset=["']?([\w-]+)/i.exec(contentType);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Look for <meta charset=...> / http-equiv content-type in the first 2KB. */
function sniffMetaCharset(buf: ArrayBuffer): string | null {
  const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
  const m =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ??
    /content=["'][^"']*charset=([\w-]+)/i.exec(head);
  return m?.[1]?.toLowerCase() ?? null;
}
