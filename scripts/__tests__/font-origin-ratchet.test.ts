import { describe, expect, it } from 'vitest';
import {
  assertScanScope,
  findExternalFontOrigins,
  inspectFiles,
} from '../font-origin-ratchet.mjs';

describe('findExternalFontOrigins', () => {
  it('flags the Google Fonts stylesheet origin (the exact removed @import)', () => {
    const css =
      '@import url("https://fonts.googleapis.com/css2?family=DM+Sans:wght@400&display=swap");\nbody { color: red; }';
    expect(findExternalFontOrigins(css, 'src-ui/src/index.css')).toEqual([
      {
        file: 'src-ui/src/index.css',
        line: 1,
        text: '@import url("https://fonts.googleapis.com/css2?family=DM+Sans:wght@400&display=swap");',
      },
    ]);
  });

  it('flags the font-file CDN origin, including in a CSP directive', () => {
    const csp = '"font-src": "\'self\' data: https://fonts.gstatic.com",';
    const findings = findExternalFontOrigins(
      csp,
      'src-desktop/tauri.conf.json',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });

  it('matches case-insensitively and inside preload link tags', () => {
    const html =
      '<link rel="preconnect" href="https://FONTS.GSTATIC.com" crossorigin />';
    expect(findExternalFontOrigins(html, 'src-ui/index.html')).toHaveLength(1);
  });

  it('does not flag self-hosted font references or unrelated google hosts', () => {
    const clean = [
      '@font-face { src: url("/fonts/dm-sans-latin.woff2") format("woff2"); }',
      "const base = 'https://generativelanguage.googleapis.com';",
      'body { font-family: "DM Sans", sans-serif; }',
    ].join('\n');
    expect(findExternalFontOrigins(clean, 'src-ui/src/fonts.css')).toEqual([]);
  });
});

describe('assertScanScope', () => {
  it('accepts a list containing every sentinel', () => {
    expect(() =>
      assertScanScope([
        'src-ui/index.html',
        'src-ui/src/index.css',
        'src-ui/src/fonts.css',
        'src-desktop/tauri.conf.json',
        'packages/cli/src/commands/lifecycle.ts',
      ]),
    ).not.toThrow();
  });

  it('fails when a sentinel falls out of the scanned list (vacuous-green guard)', () => {
    expect(() =>
      assertScanScope(['src-ui/index.html', 'src-ui/src/fonts.css']),
    ).toThrow(/sentinel file\(s\) not in the scanned list/);
  });
});

describe('inspectFiles', () => {
  it('aggregates findings across files with file attribution', () => {
    const contents: Record<string, string> = {
      'a.css': 'src: url(https://fonts.gstatic.com/s/x.woff2);',
      'b.css': 'body {}',
    };
    const findings = inspectFiles(
      Object.keys(contents),
      (f: string) => contents[f],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('a.css');
  });
});
