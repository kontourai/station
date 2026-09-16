import { workspaceLayoutPaneId } from '@kontourai/station-contracts/workspace-layout-pane';
import { describe, expect, test } from 'vitest';
import { sidebarLayoutPaneId } from '../pill-region-placement';

/**
 * The one duplication #2158 D1 accepts, held to its original.
 *
 * `sidebarLayoutPaneId` spells the pane id itself instead of calling
 * `workspaceLayoutPaneId`, because reaching the pane contracts from the
 * sidebar's EAGER chunk costs +1,820 B gzip (`useOpenInRegion.ts` records the
 * measurement; every one of its callers sits behind a lazy boundary and the
 * sidebar does not). Nothing in the shipped bundle then compares the two
 * spellings — so this file does, in a test, where the import is free.
 *
 * It is a real comparison and not a restatement: the sidebar admits an id
 * through `resolveRegionSurface`'s `INSTANCE_SURFACE_PREFIXES` table, and the
 * contract mints it through its own `UUID` regex. Two independent grammars,
 * required here to agree on every case — including the ones that must produce
 * NO id, which is what makes a legacy record an absent row rather than a row
 * that refuses when pressed (D2).
 */

/**
 * Both carry hex LETTERS on purpose. A digits-only UUID is unchanged by
 * `toUpperCase()`, so the case-folding row below would have asserted nothing —
 * it reported a pass for a value identical to the accepted one until these
 * fixtures were corrected.
 */
const LAYOUT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PROJECT = 'f1e2d3c4-b5a6-4978-8123-456789abcdef';

describe('the sidebar builds the id the contract mints', () => {
  test('a Board is board:<layoutId>', () => {
    expect(sidebarLayoutPaneId({ kind: 'board', layoutId: LAYOUT })).toBe(
      `board:${LAYOUT}`,
    );
    expect(sidebarLayoutPaneId({ kind: 'board', layoutId: LAYOUT })).toBe(
      workspaceLayoutPaneId({ kind: 'board', layoutId: LAYOUT }),
    );
  });

  test('a project Layout is layout:<projectId>/<layoutId>', () => {
    const key = {
      kind: 'project',
      projectId: PROJECT,
      layoutId: LAYOUT,
    } as const;
    expect(sidebarLayoutPaneId(key)).toBe(`layout:${PROJECT}/${LAYOUT}`);
    expect(sidebarLayoutPaneId(key)).toBe(workspaceLayoutPaneId(key));
  });

  /**
   * Every refusal the contract makes, the sidebar makes too. `l1` and `p1` are
   * the ids this repo's own e2e fixtures carried before #2158 — a slug-shaped
   * id is the realistic legacy record, not an invented one — and the uppercase
   * case matters because the contract deliberately does not fold it (the lists
   * a pane resolves against compare ids exactly).
   */
  test.each([
    ['a slug where a layout id belongs', { kind: 'board', layoutId: 'l1' }],
    ['an empty layout id', { kind: 'board', layoutId: '' }],
    ['an uppercase UUID', { kind: 'board', layoutId: LAYOUT.toUpperCase() }],
    [
      'a comma, which the pane list joins on',
      { kind: 'board', layoutId: `${LAYOUT},x` },
    ],
    [
      'a slug where a project id belongs',
      { kind: 'project', projectId: 'p1', layoutId: LAYOUT },
    ],
    [
      'a slug where the layout id belongs, under a real project',
      { kind: 'project', projectId: PROJECT, layoutId: 'notes' },
    ],
  ] as const)('refuses %s, in both spellings', (_what, key) => {
    expect(sidebarLayoutPaneId(key)).toBeNull();
    expect(workspaceLayoutPaneId(key)).toBeNull();
  });
});
