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
    // Hover's border-color would otherwise win on the selected card by
    // specificity, so the ring the user aimed at would vanish under the
    // pointer.
    expect(css).toMatch(
      /\.page__card-loose--selected,\s*\n\s*\.page__card-loose--selected:hover\s*\{/,
    );
  });
});
