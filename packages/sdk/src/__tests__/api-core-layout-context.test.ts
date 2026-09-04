import { describe, expect, test } from 'vitest';
import {
  _getPluginName,
  _setLayoutContext,
  getPluginHeaders,
} from '../api-core';

describe('SDK layout compatibility identity', () => {
  test('the explicitly bound plugin header overrides extra headers', () => {
    expect(getPluginHeaders(undefined, 'acme-plugin')['x-station-plugin']).toBe(
      'acme-plugin',
    );
    expect(
      getPluginHeaders(
        { 'x-station-plugin': 'different-plugin' },
        'acme-plugin',
      )['x-station-plugin'],
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
