// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import { createRegionClearanceWriter } from '../region-clearance';

function value(root: HTMLElement, name: string): string {
  return root.style.getPropertyValue(name);
}

function setup() {
  const root = document.createElement('div');
  return { root, writer: createRegionClearanceWriter(root) };
}

/** Every variable the writer owns; nothing else may appear on the root. */
const MANAGED = [
  '--region-left-size',
  '--region-right-size',
  '--region-bottom-size',
  '--dock-slot-size',
];

describe('region clearance writer', () => {
  test('publishes a bottom report to its region and the bottom alias', () => {
    const { root, writer } = setup();

    writer.report('bottom', { size: 320, width: null });

    expect(value(root, '--region-bottom-size')).toBe('320px');
    expect(value(root, '--dock-slot-size')).toBe('320px');
  });

  test('publishes a side report to its own region variable only', () => {
    const { root, writer } = setup();

    writer.report('left', { size: 0, width: 400 });

    expect(value(root, '--region-left-size')).toBe('400px');
    expect(value(root, '--region-right-size')).toBe('');
    // A side occupies no bottom space, so the bottom alias reads zero.
    expect(value(root, '--dock-slot-size')).toBe('0px');
  });

  test('re-applies bottom and right reports together', () => {
    const { root, writer } = setup();

    writer.report('bottom', { size: 320, width: null });
    writer.report('right', { size: 0, width: 420 });

    expect(value(root, '--region-bottom-size')).toBe('320px');
    expect(value(root, '--region-right-size')).toBe('420px');
    expect(value(root, '--dock-slot-size')).toBe('320px');
  });

  /**
   * #1374: the retired single-side alias could not express this at all —
   * one name, two widths — and the reducer withheld it here, which left
   * every side reader on a shared literal. Each side now carries its own
   * number, and one side leaving does not disturb the other's.
   */
  test('both sides occupied publish two independent widths', () => {
    const { root, writer } = setup();
    writer.report('left', { size: 0, width: 400 });
    writer.report('right', { size: 0, width: 420 });

    expect(value(root, '--region-left-size')).toBe('400px');
    expect(value(root, '--region-right-size')).toBe('420px');
    expect(value(root, '--dock-slot-size')).toBe('0px');

    writer.report('right', null);

    expect(value(root, '--region-left-size')).toBe('400px');
    expect(value(root, '--region-right-size')).toBe('');
  });

  test("removing one report leaves the other region's variables", () => {
    const { root, writer } = setup();
    writer.report('bottom', { size: 320, width: null });
    writer.report('right', { size: 0, width: 420 });

    writer.report('right', null);

    expect(value(root, '--region-right-size')).toBe('');
    expect(value(root, '--region-bottom-size')).toBe('320px');
    expect(value(root, '--dock-slot-size')).toBe('320px');
  });

  test('removes every managed variable when the map becomes empty', () => {
    const { root, writer } = setup();
    writer.report('right', { size: 0, width: 420 });

    writer.report('right', null);

    for (const name of MANAGED) expect(value(root, name)).toBe('');
    // Specifically NOT `-Infinitypx`: the bottom alias folds a max over the
    // reports, and an unguarded `Math.max()` of none returns -Infinity.
    expect(root.getAttribute('style') ?? '').not.toContain('Infinity');
  });

  /**
   * The legacy single-shell mount (no `RegionModelProvider` above it,
   * `RegionShells.tsx`) reports under the region it renders like any other
   * shell — that is what left the retired side-width alias with no writer
   * (#1374). It is not a separate publishing path any more.
   */
  test('a shell mounted without a region model still keys its own region', () => {
    const { root, writer } = setup();

    writer.report('left', { size: 0, width: 390 });

    expect(value(root, '--region-left-size')).toBe('390px');
    expect(value(root, '--dock-slot-size')).toBe('0px');
    expect(value(root, '--region-right-size')).toBe('');
    expect(value(root, '--region-bottom-size')).toBe('');
  });
});
