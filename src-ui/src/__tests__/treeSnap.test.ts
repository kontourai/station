import { describe, expect, test } from 'vitest';
import {
  clampTreeHeight,
  DEFAULT_TREE_SNAP,
  growTreeSnap,
  nearestTreeSnap,
  nextTreeSnap,
  shrinkTreeSnap,
  TREE_SNAP_ORDER,
  treeSnapHeight,
  treeSnapPixels,
} from '../components/coding-layout/treeSnap';

describe('treeSnap', () => {
  test('cycle order is Collapsed → Half → Full → Collapsed', () => {
    expect(nextTreeSnap('collapsed')).toBe('half');
    expect(nextTreeSnap('half')).toBe('full');
    expect(nextTreeSnap('full')).toBe('collapsed');
  });

  test('grow/shrink clamp at the ends', () => {
    expect(growTreeSnap('full')).toBe('full');
    expect(growTreeSnap('half')).toBe('full');
    expect(shrinkTreeSnap('collapsed')).toBe('collapsed');
    expect(shrinkTreeSnap('half')).toBe('collapsed');
  });

  test('heights map to expected CSS values, default is Half', () => {
    expect(treeSnapHeight('collapsed')).toBe('44px');
    expect(treeSnapHeight('half')).toBe('48vh');
    expect(treeSnapHeight('full')).toBe('85vh');
    expect(DEFAULT_TREE_SNAP).toBe('half');
    expect(TREE_SNAP_ORDER).toEqual(['collapsed', 'half', 'full']);
  });

  test('treeSnapPixels resolves vh against a viewport', () => {
    expect(treeSnapPixels('collapsed', 1000)).toBe(44);
    expect(treeSnapPixels('half', 1000)).toBe(480);
    expect(treeSnapPixels('full', 1000)).toBe(850);
  });

  test('nearestTreeSnap picks the closest state to a drag height', () => {
    const vh = 1000; // collapsed=44, half=480, full=850
    expect(nearestTreeSnap(50, vh)).toBe('collapsed');
    expect(nearestTreeSnap(400, vh)).toBe('half');
    expect(nearestTreeSnap(700, vh)).toBe('full');
    // Midpoint between half(480) and full(850) ≈ 665 → leans full.
    expect(nearestTreeSnap(700, vh)).toBe('full');
  });

  test('clampTreeHeight bounds to [collapsed, full]', () => {
    const vh = 1000;
    expect(clampTreeHeight(10, vh)).toBe(44);
    expect(clampTreeHeight(9999, vh)).toBe(850);
    expect(clampTreeHeight(300, vh)).toBe(300);
  });
});
