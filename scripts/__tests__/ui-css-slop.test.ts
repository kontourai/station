import { describe, expect, it } from 'vitest';
import { cssDeclarations, inspectCssSlop } from '../ui-css-slop.mjs';

const kinds = (css: string) => inspectCssSlop(css).map(({ kind }) => kind);

describe('UI CSS slop policy', () => {
  it('reads declarations, never selectors, comments or strings', () => {
    expect(
      cssDeclarations(
        `/* .x { color: #fff; } */
.card:hover, #main > a[href="#top"] { color: var(--k-text); margin: 0 }
.card { &:focus-visible { outline: 1px solid var(--k-focus) } }
@media (max-width: 768px) { .card { padding: 0; } }
@import url("x.css");`,
      ),
    ).toEqual([
      { property: 'color', value: 'var(--k-text)' },
      { property: 'margin', value: '0' },
      { property: 'outline', value: '1px solid var(--k-focus)' },
      { property: 'padding', value: '0' },
    ]);
  });

  it('catches each kind', () => {
    expect(kinds('.a { background: linear-gradient(red, blue); }')).toEqual([
      'gradient',
    ]);
    expect(
      kinds(
        '.a { background-image: repeating-radial-gradient(circle, var(--k-bg), transparent); }',
      ),
    ).toEqual(['gradient']);
    expect(
      kinds('.a { background: conic-gradient(from 0deg, black, white) }'),
    ).toEqual(['gradient']);
    expect(kinds('.a { backdrop-filter: blur(8px); }')).toEqual([
      'backdrop-blur',
    ]);
    expect(
      kinds('.a { -webkit-backdrop-filter: saturate(1.2) blur(6px) }'),
    ).toEqual(['backdrop-blur']);
    expect(
      kinds('.a { animation: spin var(--motion-slow) linear infinite; }'),
    ).toEqual(['infinite-animation']);
    expect(kinds('.a { animation-iteration-count: infinite; }')).toEqual([
      'infinite-animation',
    ]);
    expect(kinds('.a { z-index: 40; }')).toEqual(['numeric-z-index']);
    expect(kinds('.a { z-index: 9999 !important; }')).toEqual([
      'numeric-z-index',
    ]);
    expect(kinds('.a { z-index: -2; }')).toEqual(['numeric-z-index']);
    expect(kinds('.a { color: #fff; }')).toEqual(['hex-color']);
    expect(kinds('.a { border: 1px solid #5B8CFFcc; }')).toEqual(['hex-color']);
    // A hex outside the var() call still counts.
    expect(
      kinds('.a { border: 1px solid var(--k-line); color: #5b8cff; }'),
    ).toEqual(['hex-color']);
    expect(
      kinds('.a { box-shadow: 0 0 0 1px var(--k-line), 0 0 2px #000; }'),
    ).toEqual(['hex-color']);
  });

  it('leaves a var() fallback hex to component-style-hygiene, and skips mask gradients', () => {
    // component-style-hygiene counts the legacy --accent reference; one edit
    // must not fail two gates.
    for (const css of [
      '.a { outline-color: var(--accent-primary, #5b8cff); }',
      '.a { color: var(--k-text, var(--text-primary, #fff)); }',
      // Nested parentheses inside a legacy fallback are matched, balanced.
      '.a{box-shadow: var(--shadow-x, 0 0 calc(2px) #000)}',
      '.a { mask-image: linear-gradient(to bottom, #000 80%, transparent); }',
      '.a { -webkit-mask-image: linear-gradient(#000, transparent); }',
      '.a { mask: radial-gradient(circle, #000 60%, transparent) }',
      '.a { -webkit-mask: conic-gradient(#000, transparent) }',
    ]) {
      expect(kinds(css), css).toEqual([]);
    }
    // A non-legacy fallback hex is a hard-coded color nothing else counts.
    for (const css of [
      '.a { color: var(--k-text, #fff); }',
      '.a { border-color: var(--my-local, #5b8cff); }',
      '.a { color: var(--k-text, var(--k-text-muted, #777)); }',
    ]) {
      expect(kinds(css), css).toEqual(['hex-color']);
    }
    // The mask exemption is for masks only.
    expect(
      kinds('.a { background-image: linear-gradient(#000, transparent); }'),
    ).toEqual(['gradient', 'hex-color']);
  });

  it('does not count tokens, local stacking, settled motion or definitions', () => {
    for (const css of [
      '.a { background: var(--k-panel); }',
      '.a { backdrop-filter: saturate(1.2); }',
      '.a { filter: blur(2px); }',
      '.a { animation: fade-in var(--motion-fast) var(--ease-out) 1; }',
      '.a { animation-iteration-count: 3; }',
      '.a { z-index: var(--layer-popover); }',
      '.a { z-index: calc(var(--layer-dialog) + 1); }',
      '.a { z-index: 1; } .b { z-index: 0 } .c { z-index: -1 } .d { z-index: auto }',
      ':root { --brand: #5b8cff; --panel-bg: #fff; }',
      '.a { --tint: #102030; color: var(--tint); }',
      '.a { background: url("img.svg#frag-ffffff"); }',
      '/* z-index: 9999; color: #fff; */ .a { color: inherit; }',
      '.a { grid-area: header; }',
    ]) {
      expect(kinds(css), css).toEqual([]);
    }
  });

  it('counts one finding per kind per declaration', () => {
    expect(
      kinds(
        '.a { background: linear-gradient(#fff, #000); } .b { z-index: 10; color: #222 }',
      ),
    ).toEqual(['gradient', 'hex-color', 'numeric-z-index', 'hex-color']);
  });
});
