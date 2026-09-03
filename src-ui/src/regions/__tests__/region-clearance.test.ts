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

describe('region clearance writer', () => {
  test('publishes a bottom report to its region and legacy aliases', () => {
    const { root, writer } = setup();

    writer.report('bottom', { size: 320, width: null });

    expect(value(root, '--region-bottom-size')).toBe('320px');
    expect(value(root, '--dock-slot-size')).toBe('320px');
    expect(value(root, '--chat-dock-width')).toBe('');
  });

  test('publishes a side report to its region and legacy aliases', () => {
    const { root, writer } = setup();

    writer.report('left', { size: 0, width: 400 });

    expect(value(root, '--region-left-size')).toBe('400px');
    expect(value(root, '--dock-slot-size')).toBe('0px');
    expect(value(root, '--chat-dock-width')).toBe('400px');
  });

  test('re-applies bottom and right reports together', () => {
    const { root, writer } = setup();

    writer.report('bottom', { size: 320, width: null });
    writer.report('right', { size: 0, width: 420 });

    expect(value(root, '--region-bottom-size')).toBe('320px');
    expect(value(root, '--region-right-size')).toBe('420px');
    expect(value(root, '--dock-slot-size')).toBe('320px');
    expect(value(root, '--chat-dock-width')).toBe('420px');
  });

  test('withholds the single-width alias while both sides are occupied', () => {
    const { root, writer } = setup();
    writer.report('left', { size: 0, width: 400 });
    writer.report('right', { size: 0, width: 420 });

    expect(value(root, '--region-left-size')).toBe('400px');
    expect(value(root, '--region-right-size')).toBe('420px');
    expect(value(root, '--dock-slot-size')).toBe('0px');
    expect(value(root, '--chat-dock-width')).toBe('');

    writer.report('right', null);

    expect(value(root, '--chat-dock-width')).toBe('400px');
  });

  test("removing one report leaves the other region's variables", () => {
    const { root, writer } = setup();
    writer.report('bottom', { size: 320, width: null });
    writer.report('right', { size: 0, width: 420 });

    writer.report('right', null);

    expect(value(root, '--region-right-size')).toBe('');
    expect(value(root, '--region-bottom-size')).toBe('320px');
    expect(value(root, '--dock-slot-size')).toBe('320px');
    expect(value(root, '--chat-dock-width')).toBe('');
  });

  test('removes every managed variable when the map becomes empty', () => {
    const { root, writer } = setup();
    writer.report('right', { size: 0, width: 420 });

    writer.report('right', null);

    for (const name of [
      '--region-left-size',
      '--region-right-size',
      '--region-bottom-size',
      '--dock-slot-size',
      '--chat-dock-width',
    ]) {
      expect(value(root, name)).toBe('');
    }
  });

  test('a legacy mount writes only legacy variables', () => {
    const { root, writer } = setup();

    writer.report(null, { size: 38, width: 390 });

    expect(value(root, '--dock-slot-size')).toBe('38px');
    expect(value(root, '--chat-dock-width')).toBe('390px');
    expect(value(root, '--region-left-size')).toBe('');
    expect(value(root, '--region-right-size')).toBe('');
    expect(value(root, '--region-bottom-size')).toBe('');
  });

  test('a persisted right occupant folded under bottom writes its rendered region', () => {
    const { root, writer } = setup();

    writer.report('bottom', { size: 280, width: null });

    expect(value(root, '--region-bottom-size')).toBe('280px');
    expect(value(root, '--region-right-size')).toBe('');
  });
});
