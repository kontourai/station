import { describe, expect, test } from 'vitest';
import {
  isAllowedBrowserUrl,
  MAX_BROWSER_URL_LENGTH,
  normalizeBrowserUrl,
} from '../url-policy.js';

describe('normalizeBrowserUrl: allowed inputs', () => {
  test.each([
    ['https://example.com', 'https://example.com/'],
    ['http://example.com/a?b=1#c', 'http://example.com/a?b=1#c'],
    ['HTTPS://EXAMPLE.COM/Path', 'https://example.com/Path'],
    ['  https://example.com  ', 'https://example.com/'],
    ['about:blank', 'about:blank'],
    ['ABOUT:BLANK', 'about:blank'],
    // Bare hosts: loopback becomes http, everything else https.
    ['localhost', 'http://localhost/'],
    ['localhost:5173', 'http://localhost:5173/'],
    ['localhost:5173/app?x=1', 'http://localhost:5173/app?x=1'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['127.1.2.3', 'http://127.1.2.3/'],
    ['0.0.0.0:3001', 'http://0.0.0.0:3001/'],
    ['[::1]:4000', 'http://[::1]:4000/'],
    ['example.com', 'https://example.com/'],
    ['example.com:8443/x', 'https://example.com:8443/x'],
    ['localhost.evil.com', 'https://localhost.evil.com/'],
    // IDN is punycoded, never passed through raw.
    ['https://bücher.de/', 'https://xn--bcher-kva.de/'],
    ['bücher.de', 'https://xn--bcher-kva.de/'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeBrowserUrl(input)).toEqual({ ok: true, url: expected });
  });
});

describe('normalizeBrowserUrl: every other scheme fails closed', () => {
  test.each([
    ['javascript:alert(1)', 'javascript'],
    ['JavaScript:alert(1)', 'javascript'],
    ['JAVASCRIPT:alert(1)', 'javascript'],
    ['file:///etc/passwd', 'file'],
    ['FILE:///etc/passwd', 'file'],
    ['file://localhost/etc/passwd', 'file'],
    ['data:text/html,<h1>x</h1>', 'data'],
    ['chrome://settings', 'chrome'],
    ['chrome-extension://abc/x.html', 'chrome-extension'],
    ['view-source:https://example.com', 'view-source'],
    ['devtools://devtools/bundled/inspector.html', 'devtools'],
    ['blob:https://example.com/uuid', 'blob'],
    ['about:srcdoc', 'about'],
    ['about:config', 'about'],
    ['ftp://example.com', 'ftp'],
    ['ws://example.com', 'ws'],
    ['mailto:a@example.com', 'mailto'],
    ['vbscript:x', 'vbscript'],
  ])('%j is refused as unsupported-scheme %s', (input, scheme) => {
    expect(normalizeBrowserUrl(input)).toEqual({
      ok: false,
      reason: 'unsupported-scheme',
      scheme,
    });
  });
});

describe('normalizeBrowserUrl: malformed and smuggling inputs', () => {
  test.each([
    // Non-canonical special-scheme spellings WHATWG would silently repair.
    ['http:/x'],
    ['http:x'],
    ['https:\\\\example.com'],
    // Interior whitespace/control characters: WHATWG strips tab/newline, so
    // `java\nscript:` would otherwise parse as `javascript:`.
    ['java\nscript:alert(1)'],
    ['java\tscript:alert(1)'],
    ['https://exa mple.com'],
    ['https://example.com/\u0000'],
    ['https://example.com/a\u2028b'],
    // No host to decide on.
    ['//example.com'],
    ['/relative/path'],
    ['\\\\server\\share'],
    ['https://'],
    ['http://[::1'],
  ])('%j is refused as malformed', (input) => {
    const decision = normalizeBrowserUrl(input);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('malformed');
  });

  test('credentials in the authority are refused, not stripped', () => {
    expect(normalizeBrowserUrl('https://user:pass@example.com')).toEqual({
      ok: false,
      reason: 'credentials',
    });
    expect(normalizeBrowserUrl('https://user@example.com')).toEqual({
      ok: false,
      reason: 'credentials',
    });
    expect(normalizeBrowserUrl('user:pw@example.com')).toMatchObject({
      ok: false,
    });
  });

  test('empty, whitespace-only, non-string and oversized inputs', () => {
    expect(normalizeBrowserUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeBrowserUrl('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeBrowserUrl(undefined)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(normalizeBrowserUrl(42)).toEqual({ ok: false, reason: 'malformed' });
    expect(
      normalizeBrowserUrl(
        `https://example.com/${'a'.repeat(MAX_BROWSER_URL_LENGTH)}`,
      ),
    ).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('isAllowedBrowserUrl (in-page navigation enforcement)', () => {
  test.each([
    ['https://example.com/', true],
    ['http://127.0.0.1:9/', true],
    ['about:blank', true],
    ['about:blank#x', false],
    ['about:srcdoc', false],
    ['file:///etc/passwd', false],
    ['data:text/html,x', false],
    ['chrome://version/', false],
    ['chrome-error://chromewebdata/', false],
    ['view-source:https://example.com/', false],
    ['javascript:alert(1)', false],
    ['https://u:p@example.com/', false],
    ['not a url', false],
    ['', false],
  ])('%j -> %s', (url, allowed) => {
    expect(isAllowedBrowserUrl(url)).toBe(allowed);
  });
});
