/**
 * @vitest-environment jsdom
 */

import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  getRecentLayoutIds,
  getRecentLayouts,
  trackRecentLayout,
} from '../hooks/useRecentLayouts';

const catalog = [
  { id: 'builtin:coding', name: 'Coding' },
  { id: 'plugin:review', name: 'Review' },
  { id: 'organization:triage', name: 'Triage' },
] as LayoutCatalogItem[];

beforeEach(() => {
  localStorage.clear();
});

describe('useRecentLayouts helpers', () => {
  test('tracks canonical IDs in most-recent-first order without duplicate IDs', () => {
    trackRecentLayout('builtin:coding');
    trackRecentLayout('plugin:review');
    trackRecentLayout('builtin:coding');

    expect(getRecentLayoutIds()).toEqual(['builtin:coding', 'plugin:review']);
  });

  test('keeps only a small bounded history', () => {
    for (const id of ['one', 'two', 'three', 'four', 'five', 'six']) {
      trackRecentLayout(id);
    }

    expect(getRecentLayoutIds()).toEqual([
      'six',
      'five',
      'four',
      'three',
      'two',
    ]);
  });

  test('recovers from malformed or invalid stored data', () => {
    localStorage.setItem('recentLayouts', '{not valid json');
    expect(getRecentLayoutIds()).toEqual([]);

    localStorage.setItem(
      'recentLayouts',
      JSON.stringify(['plugin:review', null, 'plugin:review', 4, '']),
    );
    expect(getRecentLayoutIds()).toEqual(['plugin:review']);
  });

  test('orders catalog items by the stored MRU and ignores obsolete IDs', () => {
    localStorage.setItem(
      'recentLayouts',
      JSON.stringify([
        'removed:legacy',
        'organization:triage',
        'builtin:coding',
      ]),
    );

    expect(getRecentLayouts(catalog).map((item) => item.id)).toEqual([
      'organization:triage',
      'builtin:coding',
    ]);
  });

  test('does not record selection or reads until an apply success explicitly tracks it', () => {
    const selectedLayoutId = 'plugin:review';

    expect(getRecentLayoutIds()).toEqual([]);
    expect(getRecentLayouts(catalog)).toEqual([]);

    // This is deliberately the caller's post-success action, not selection.
    trackRecentLayout(selectedLayoutId);

    expect(getRecentLayoutIds()).toEqual([selectedLayoutId]);
  });
});
