/**
 * Browser pane URL scope (#90, design brief D2).
 *
 * The Browser pane opens `http:` and `https:` URLs plus `about:blank`, and
 * nothing else. Every other scheme (`file:`, `chrome:`, `data:`,
 * `javascript:`, `view-source:`, `devtools:`, `blob:`, any other `about:`)
 * fails closed. Credentials embedded in a URL are refused rather than
 * stripped, so the caller learns their input was not what got loaded.
 *
 * Bare hosts are normalized the way t3code's `packages/shared/src/preview.ts`
 * does it (MIT, © 2026 T3 Tools Inc.): a loopback host becomes `http://`,
 * anything else `https://`.
 *
 * This module is pure. The same predicate ({@link isAllowedBrowserUrl}) runs
 * on already-parsed URLs reported by the browser (in-page navigations), so
 * the navigate path and the enforcement path cannot disagree.
 */

export type BrowserUrlRejection =
  | 'empty'
  | 'too-long'
  | 'malformed'
  | 'unsupported-scheme'
  | 'credentials';

export type BrowserUrlDecision =
  | { ok: true; url: string }
  | { ok: false; reason: BrowserUrlRejection; scheme?: string };

/** Longer inputs are refused before parsing. Chrome's own cap is 2 MiB. */
export const MAX_BROWSER_URL_LENGTH = 8192;

export const ABOUT_BLANK = 'about:blank';

const LOOPBACK_BARE_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:[/?#]|$)/i;

/**
 * A leading `name:` that is a scheme, as opposed to `host:port`. Anything
 * shaped `word:digits` followed by the end or `/?#` is a host with a port.
 */
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const HOST_PORT_PREFIX = /^[A-Za-z0-9.-]+:\d+(?:[/?#]|$)/;

// Control characters and whitespace anywhere inside the input. WHATWG URL
// parsing silently strips tab/newline from the middle of a URL
// (`java\nscript:` parses as `javascript:`), so they are refused outright
// rather than trusting every consumer to parse identically.
function hasInteriorControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function schemeOf(raw: string): string | undefined {
  return SCHEME_PREFIX.exec(raw)?.[1]?.toLowerCase();
}

/**
 * Judge an already-absolute URL string reported by the browser or produced by
 * {@link normalizeBrowserUrl}. Used for in-page navigation enforcement.
 */
export function isAllowedBrowserUrl(url: string): boolean {
  if (url === ABOUT_BLANK) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return parsed.hostname !== '';
}

/**
 * Normalize free-form user or agent input into a loadable URL, or refuse it
 * with a typed reason.
 */
export function normalizeBrowserUrl(input: unknown): BrowserUrlDecision {
  if (typeof input !== 'string') return { ok: false, reason: 'malformed' };
  if (input.length > MAX_BROWSER_URL_LENGTH)
    return { ok: false, reason: 'too-long' };
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (hasInteriorControlOrSpace(trimmed))
    return { ok: false, reason: 'malformed' };

  const scheme = HOST_PORT_PREFIX.test(trimmed) ? undefined : schemeOf(trimmed);
  let candidate: string;
  if (scheme === undefined) {
    // No scheme at all: a bare host, optionally with port/path. A leading
    // `//` (scheme-relative) or `/` (path) has no host to decide on.
    if (trimmed.startsWith('/') || trimmed.startsWith('\\'))
      return { ok: false, reason: 'malformed' };
    candidate = `${LOOPBACK_BARE_HOST.test(trimmed) ? 'http' : 'https'}://${trimmed}`;
  } else if (scheme === 'about') {
    return trimmed.toLowerCase() === ABOUT_BLANK
      ? { ok: true, url: ABOUT_BLANK }
      : { ok: false, reason: 'unsupported-scheme', scheme: 'about' };
  } else if (scheme === 'http' || scheme === 'https') {
    // WHATWG parsing repairs `http:/x`, `http:x` and `http:\\x` into
    // `http://x/`. Refuse the non-canonical spellings instead of guessing
    // which host was meant.
    if (!trimmed.slice(scheme.length + 1).startsWith('//'))
      return { ok: false, reason: 'malformed', scheme };
    candidate = trimmed;
  } else {
    return { ok: false, reason: 'unsupported-scheme', scheme };
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return {
      ok: false,
      reason: 'unsupported-scheme',
      scheme: parsed.protocol.slice(0, -1),
    };
  if (parsed.username !== '' || parsed.password !== '')
    return { ok: false, reason: 'credentials' };
  if (parsed.hostname === '') return { ok: false, reason: 'malformed' };
  return { ok: true, url: parsed.href };
}
