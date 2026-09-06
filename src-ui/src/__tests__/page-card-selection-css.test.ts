/**
 * @vitest-environment node
 *
 * #1536 G8. `.page__card-loose` is the shared catalog card behind Registry,
 * Integrations, and the other browse pages; its selected state and its hover
 * state both painted `--accent-primary` on the border, so pointing at any card
 * gave it the selected card's ring and the selection appeared to follow the
 * pointer while the detail hero stayed put. Selection follows click and
 * keyboard only, and only the stylesheet says so — jsdom computes no
 * `:hover` styles, so the distinction has no runtime seam to assert against.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Bodies of every rule whose selector list contains `selector` exactly. Parsed
 * by splitting on braces rather than by a regex around the selector, so a
 * grouped selector list and a preceding comment are both read correctly.
 */
function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  for (const block of css.split('}')) {
    const brace = block.indexOf('{');
    if (brace < 0) continue;
    const selectors = block
      .slice(0, brace)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((entry) => entry.trim());
    if (selectors.includes(selector)) bodies.push(block.slice(brace + 1));
  }
  return bodies;
}

/**
 * Position of the rule whose selector list contains `selector`, in source
 * order — `-1` when no rule declares it. Two rules of equal specificity are
 * decided by which comes later, so ORDER is what a cascade assertion has to
 * read.
 */
function ruleIndex(css: string, selector: string): number {
  let index = 0;
  for (const block of css.split('}')) {
    const brace = block.indexOf('{');
    if (brace < 0) continue;
    const selectors = block
      .slice(0, brace)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((entry) => entry.trim());
    if (selectors.includes(selector)) return index;
    index += 1;
  }
  return -1;
}

const css = readFileSync(
  join(__dirname, '..', 'views', 'page-layout.css'),
  'utf-8',
);

describe('the shared browse card (#1536 G8)', () => {
  it('reserves the accent ring for the selected card', () => {
    const [selected] = ruleBodies(css, '.page__card-loose--selected');
    expect(selected, 'missing .page__card-loose--selected rule').toBeDefined();
    expect(selected).toMatch(/border-color:\s*var\(--accent-primary\)/);
    expect(selected).toMatch(/box-shadow:\s*0 0 0 1px var\(--accent-primary\)/);
  });

  it('does not paint the accent ring on hover', () => {
    const hovered = ruleBodies(css, '.page__card-loose:hover');
    expect(hovered.length, 'missing .page__card-loose:hover rule').toBe(1);
    // The hover affordance stays — it just must not impersonate selection.
    expect(hovered[0]).toMatch(/border-color:\s*var\(--border-secondary\)/);
    expect(hovered[0]).not.toContain('--accent-primary');
  });

  it('keeps the selected ring while the selected card is hovered', () => {
    // Hover and selected-hover have equal specificity, so the LATER rule wins
    // — which makes source order the actual mechanism, not adjacency. Review
    // L2: matching the two selectors as adjacent text passed for any
    // formatting that happened to put them together and failed for any that
    // did not, while saying nothing about which rule wins.
    const hoverIndex = ruleIndex(css, '.page__card-loose:hover');
    const selectedHoverIndex = ruleIndex(
      css,
      '.page__card-loose--selected:hover',
    );
    expect(hoverIndex, 'missing .page__card-loose:hover rule').toBeGreaterThan(
      -1,
    );
    expect(
      selectedHoverIndex,
      'missing .page__card-loose--selected:hover rule',
    ).toBeGreaterThan(-1);
    expect(selectedHoverIndex).toBeGreaterThan(hoverIndex);
  });
});
