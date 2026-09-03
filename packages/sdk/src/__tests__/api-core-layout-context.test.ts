import { describe, expect, test } from 'vitest';
import {
  _getPluginName,
  _setLayoutContext,
  createPluginApiIdentity,
} from '../api-core';

describe('SDK layout compatibility identity', () => {
  test('keeps boundary identities independent from occurrence-shaped layout slugs', () => {
    const identity = createPluginApiIdentity('acme-plugin');
    expect(identity.pluginName).toBe('acme-plugin');
    expect(identity.getHeaders()['x-station-plugin']).toBe('acme-plugin');
    expect(
      identity.getHeaders({ 'x-station-plugin': 'different-plugin' })[
        'x-station-plugin'
      ],
    ).toBe('acme-plugin');
  });

  test('legacy layout context never becomes ambient plugin request identity', () => {
    const release = _setLayoutContext(
      { name: 'First', slug: 'first-occurrence', tabs: [] },
      { owner: {}, pluginName: 'first-plugin' },
    );
    expect(_getPluginName()).toBe('');
    release();
    expect(_getPluginName()).toBe('');
  });
});
