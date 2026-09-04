import { describe, expect, test } from 'vitest';
import {
  _getPluginName,
  _setLayoutContext,
  getPluginHeaders,
} from '../api-core';

describe('SDK layout compatibility identity', () => {
  test.each(['X-Station-Plugin', 'X-STATION-PLUGIN'])(
    'bound attribution replaces case-insensitive header spelling %s',
    (spelling) => {
      const headers = new Headers(
        getPluginHeaders(
          {
            [spelling]: 'other-plugin',
            'x-station-plugin': 'another-plugin',
            'x-extra': 'preserved',
          },
          'owner-plugin',
        ),
      );
      expect(headers.get('x-station-plugin')).toBe('owner-plugin');
      expect(headers.get('x-extra')).toBe('preserved');
    },
  );
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
