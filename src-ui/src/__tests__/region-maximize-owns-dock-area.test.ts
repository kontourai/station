import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * #928 slice iii / #1385 review: the desktop grid's maximize rules collapse
 * `.app__main` to a single column (side maximize) or a single fill row
 * (bottom maximize). With two region shells mounted — Activity maximized in
 * `right`, Chat visible in `left` or `bottom` — the second shell would land in
 * a collapsed track or an implicit row. The stylesheet therefore hides every
 * other shell while one is maximized, by CSS alone: a maximized region owns
 * the dock area, and the model's "one region at a time" invariant
 * (region-model.ts) is what makes "the maximized one" well defined.
 *
 * A source scan, not a render: jsdom applies no layout, so what can be pinned
 * here is that the rule exists in the desktop media block, targets the
 * non-maximized siblings of a maximized shell, and hides them. The rendered
 * geometry is a pixel claim this test does not make.
 */

const indexCss = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');

/** Comments out, so a rule quoted in prose is not read as a declaration. */
function withoutComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

const RULE =
  '.app__main:has(> .chat-dock.is-maximized) > .chat-dock:not(.is-maximized) {';

test('a maximized region hides every other dock shell (the rule exists and hides)', () => {
  const source = withoutComments(indexCss);
  const index = source.indexOf(RULE);
  expect(index, `${RULE} must be declared in index.css`).toBeGreaterThan(-1);
  const body = source.slice(index + RULE.length, source.indexOf('}', index));
  expect(body.replace(/\s+/g, ' ').trim()).toBe('display: none;');
  // Declared once: a second copy in another media block would be the
  // two-copies-of-one-list shape placement.md warns about.
  expect(source.indexOf(RULE, index + 1)).toBe(-1);
});

test('the rule sits inside the desktop grid media block, beside the collapses it protects', () => {
  const source = withoutComments(indexCss);
  const desktopBlock = source.indexOf(
    '@media (min-width: 769px) and (not ((max-height: 540px) and (pointer: coarse)))',
  );
  const rule = source.indexOf(RULE);
  const sideCollapse = source.indexOf(
    'grid-template-columns: minmax(0, 1fr);',
    desktopBlock,
  );
  const bottomCollapse = source.indexOf(
    'grid-template-rows: auto minmax(0, 1fr);',
    desktopBlock,
  );
  expect(desktopBlock).toBeGreaterThan(-1);
  expect(rule).toBeGreaterThan(desktopBlock);
  // The hide precedes both single-track collapses it exists for.
  expect(sideCollapse).toBeGreaterThan(rule);
  expect(bottomCollapse).toBeGreaterThan(rule);
});
