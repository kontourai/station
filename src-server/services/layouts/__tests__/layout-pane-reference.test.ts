/**
 * The identity set the withheld decision is computed over (#2090/#2103).
 *
 * The route tests in
 * `src-server/routes/projects/__tests__/pane-visibility.routes.test.ts` drive
 * the real handlers and are where the behaviour is proven. This file covers
 * the two properties of the derivation that no route can reach:
 *
 *  - the malformed record (a `plugin`-origin contribution naming no plugin),
 *    which `file-storage-schemas.ts` refuses to persist — its
 *    `sourceIdentity.id` is a non-empty string — so a route test asserting
 *    it would be asserting against a record the store cannot hold;
 *  - the exact membership of the identity set, which a route test can only
 *    observe through a response.
 */
import { describe, expect, test } from 'vitest';
import {
  layoutPluginBindingWithheld,
  layoutReferencedPluginIds,
  resolveLayoutPaneReferences,
} from '../layout-pane-reference.js';

const contribution = (
  provenance: { origin: string; pluginId?: string },
  sourceId?: string,
) => ({
  provenance,
  ...(sourceId === undefined ? {} : { sourceIdentity: { id: sourceId } }),
});

describe('layoutReferencedPluginIds', () => {
  test('reads the merge key and both contribution names', () => {
    // The response derives from all three. The first implementation read one
    // of them — and preferred the server-issued one over the merge key the
    // live read is actually keyed on, which is what made the route an
    // enumeration oracle for anybody who could see a single plugin.
    expect(
      layoutReferencedPluginIds({
        config: { plugin: 'written-by-a-member' },
        catalogContribution: contribution(
          { origin: 'plugin', pluginId: 'issued-by-the-server' },
          'named-in-the-source-path',
        ),
      })
        .pluginIds.slice()
        .sort(),
    ).toEqual([
      'issued-by-the-server',
      'named-in-the-source-path',
      'written-by-a-member',
    ]);
  });

  test('a Kit layout and a builtin contribution name nothing', () => {
    expect(
      layoutReferencedPluginIds({
        config: { kit: { contributionRef: 'some-kit/view' } },
      }),
    ).toEqual({ pluginIds: [], unattributed: false });
    expect(
      layoutReferencedPluginIds({
        config: {},
        catalogContribution: contribution({ origin: 'builtin' }, 'station'),
      }),
    ).toEqual({ pluginIds: [], unattributed: false });
  });

  test('an mcp contribution falls through to the merge key', () => {
    expect(
      layoutReferencedPluginIds({
        config: { plugin: 'a-plugin' },
        catalogContribution: contribution({ origin: 'mcp' }, 'a-server'),
      }).pluginIds,
    ).toEqual(['a-plugin']);
  });
});

describe('layoutPluginBindingWithheld', () => {
  const seesOnly = (allowed: string) => (pluginId: string) =>
    pluginId === allowed;

  test('fails closed when ANY named plugin is invisible', () => {
    const layout = {
      config: { plugin: 'hidden' },
      catalogContribution: contribution(
        { origin: 'plugin', pluginId: 'visible' },
        'visible',
      ),
    };
    expect(
      layoutPluginBindingWithheld(layout, {
        canSeePlugin: seesOnly('visible'),
      }),
    ).toBe(true);
    // And the mirror, so the assertion above is about the set rather than
    // about one of its members always losing.
    expect(
      layoutPluginBindingWithheld(
        {
          config: { plugin: 'visible' },
          catalogContribution: contribution(
            { origin: 'plugin', pluginId: 'hidden' },
            'hidden',
          ),
        },
        { canSeePlugin: seesOnly('visible') },
      ),
    ).toBe(true);
  });

  test('a plugin contribution naming no plugin fails closed', () => {
    // Not route-reachable: `file-storage-schemas.ts` requires a non-empty
    // `sourceIdentity.id`, so this record cannot be stored. A gate that
    // failed OPEN on a malformed record would be the wrong default here and
    // nothing downstream would notice, so it is pinned at the one layer that
    // can express it.
    const malformed = {
      config: {},
      catalogContribution: contribution({ origin: 'plugin' }),
    };
    expect(layoutReferencedPluginIds(malformed).unattributed).toBe(true);
    expect(
      layoutPluginBindingWithheld(malformed, { canSeePlugin: () => true }),
    ).toBe(true);
    expect(
      resolveLayoutPaneReferences(
        { ...malformed, config: { tabs: [{ id: 'a' }] } as never },
        { canSeePlugin: () => true },
      ),
    ).toEqual({ unavailableTabIds: ['a'] });
  });

  test('no projection withholds nothing, malformed record included', () => {
    // Absence must never read as a verdict, even here.
    expect(
      layoutPluginBindingWithheld(
        {
          config: { plugin: 'hidden' },
          catalogContribution: contribution({ origin: 'plugin' }),
        },
        {},
      ),
    ).toBe(false);
  });
});
