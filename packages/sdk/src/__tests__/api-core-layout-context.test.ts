import { afterEach, describe, expect, test } from 'vitest';
import { _getPluginName, _setLayoutContext } from '../api-core';

const firstOwner = {};
const secondOwner = {};

let releases: Array<() => void> = [];

afterEach(() => {
  for (const release of releases.reverse()) release();
  releases = [];
});

describe('SDK layout compatibility identity', () => {
  test('keeps plugin identity distinct from the occurrence-shaped layout slug', () => {
    releases.push(
      _setLayoutContext(
        { name: 'Pane', slug: 'instance:project-a:pane-a', tabs: [] },
        { owner: firstOwner, pluginName: 'acme-plugin' },
      ),
    );
    expect(_getPluginName()).toBe('acme-plugin');
  });

  test('an older provider cleanup cannot clear a newer owner generation', () => {
    const releaseFirst = _setLayoutContext(
      { name: 'First', slug: 'first-occurrence', tabs: [] },
      { owner: firstOwner, pluginName: 'first-plugin' },
    );
    const releaseSecond = _setLayoutContext(
      { name: 'Second', slug: 'second-occurrence', tabs: [] },
      { owner: secondOwner, pluginName: 'second-plugin' },
    );
    releases.push(releaseFirst, releaseSecond);
    releaseFirst();
    expect(_getPluginName()).toBe('second-plugin');
    releaseSecond();
    expect(_getPluginName()).toBe('');
  });
});
