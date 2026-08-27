import { describe, expect, it } from 'vitest';
import {
  buildPluginListItems,
  filterPlugins,
  slugifyProjectName,
  toggleSetValue,
} from '../views/plugin-management/view-utils';

describe('plugin management utils', () => {
  it('filters plugins by display name and description', () => {
    const plugins = [
      {
        name: 'alpha',
        displayName: 'Alpha Tools',
        version: '1.0.0',
        description: 'Build pipeline',
        hasBundle: false,
      },
      {
        name: 'beta',
        displayName: 'Beta',
        version: '2.0.0',
        description: 'Observability',
        hasBundle: true,
      },
    ];

    expect(filterPlugins(plugins, 'alpha')).toEqual([plugins[0]]);
    expect(filterPlugins(plugins, 'observ')).toEqual([plugins[1]]);
  });

  it('builds list items and project slugs consistently', () => {
    expect(
      buildPluginListItems([
        {
          name: 'alpha',
          displayName: 'Alpha Tools',
          version: '1.0.0',
          description: 'Build pipeline',
          hasBundle: false,
        },
      ]),
    ).toEqual([
      {
        id: 'alpha',
        name: 'Alpha Tools',
        subtitle: 'v1.0.0 · Build pipeline',
      },
    ]);
    expect(slugifyProjectName('Alpha Tools / Layout')).toBe(
      'alpha-tools-layout',
    );
    expect(slugifyProjectName('***')).toBe('default');
  });

  it('toggles set values immutably', () => {
    const original = new Set(['alpha']);

    const added = toggleSetValue(original, 'beta');
    const removed = toggleSetValue(added, 'alpha');

    expect([...original]).toEqual(['alpha']);
    expect([...added].sort()).toEqual(['alpha', 'beta']);
    expect([...removed]).toEqual(['beta']);
  });
});
