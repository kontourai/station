/** @vitest-environment jsdom */

/**
 * A related plugin occurrence's stored record (`pluginPaneOccurrence.ts`):
 * closed and bounded on read, refused (never truncated) on write, capped at
 * its bound without evicting anything, and removed together with the
 * occurrence's Station fence.
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { readPaneFence, writePaneFence } from '../../regions/pane-fence';
import {
  createPluginPaneStatePreparation,
  MAX_PLUGIN_PANE_STATES,
  type PluginPaneState,
  parsePluginPaneState,
  readPluginPaneState,
} from '../pluginPaneOccurrence';

const STATE: PluginPaneState = {
  version: 1,
  projectId: 'project-uuid',
  projectSlug: 'station',
  pluginId: 'reports',
  generation: 'plugin:reports@1.0.0:local:reports:plugins/reports',
  descriptorId: 'pane:plugin%3Areports:detail',
  modeId: 'project',
  key: 'weekly',
};

const id = (index: number) =>
  `plugin-pane:${index.toString(16).padStart(32, '0')}`;

beforeEach(() => localStorage.clear());

describe('a related plugin occurrence record', () => {
  test('reads back only the fields this version defines', () => {
    expect(
      parsePluginPaneState({
        ...STATE,
        scope: { taskId: 't1' },
        renderer: 'evil',
      }),
    ).toEqual({ ...STATE, scope: { taskId: 't1' } });
    expect(
      parsePluginPaneState({ ...STATE, scope: { path: '/etc' } }),
    ).toBeNull();
    expect(parsePluginPaneState({ ...STATE, version: 2 })).toBeNull();
  });

  test('a record past a bound is refused, never cut', () => {
    const preparation = createPluginPaneStatePreparation(localStorage, id(1), {
      ...STATE,
      key: 'k'.repeat(257),
    });
    expect(preparation.prepare()).toBe(false);
    expect(readPluginPaneState(localStorage, id(1))).toBeNull();
  });

  test('at the bound a new record is refused and every stored one stays', () => {
    for (let index = 0; index < MAX_PLUGIN_PANE_STATES; index += 1)
      expect(
        createPluginPaneStatePreparation(
          localStorage,
          id(index),
          STATE,
        ).prepare(),
      ).toBe(true);
    expect(
      createPluginPaneStatePreparation(
        localStorage,
        id(MAX_PLUGIN_PANE_STATES),
        STATE,
      ).prepare(),
    ).toBe(false);
    for (let index = 0; index < MAX_PLUGIN_PANE_STATES; index += 1)
      expect(readPluginPaneState(localStorage, id(index))).toEqual(STATE);
  });

  test('a record is written once, and its rollback takes the fence with it', () => {
    writePaneFence(localStorage, id(1), 'station-a');
    const preparation = createPluginPaneStatePreparation(
      localStorage,
      id(1),
      STATE,
    );
    expect(preparation.prepare()).toBe(true);
    expect(
      createPluginPaneStatePreparation(localStorage, id(1), {
        ...STATE,
        key: 'other',
      }).prepare(),
    ).toBe(false);
    expect(readPluginPaneState(localStorage, id(1))?.key).toBe('weekly');
    preparation.rollback();
    expect(readPluginPaneState(localStorage, id(1))).toBeNull();
    expect(readPaneFence(localStorage, id(1)).status).toBe('none');
  });
});
