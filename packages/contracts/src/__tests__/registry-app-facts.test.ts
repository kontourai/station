import { describe, expect, test } from 'vitest';
import { deriveRegistryAppFacts, parseRegistryAppFacts } from '../catalog.js';

const tabs = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    label: `Tab ${index}`,
    component: 'tab',
  }));

describe('deriveRegistryAppFacts', () => {
  test('a plugin with no layout and no pane is not an app', () => {
    expect(
      deriveRegistryAppFacts({
        manifest: { capabilities: ['routing'] },
        layouts: [],
      }),
    ).toEqual({ kind: 'none' });
  });

  test('a layout bound to a repository opens only in a project and works with files', () => {
    expect(
      deriveRegistryAppFacts({
        manifest: {},
        layouts: [{ workspaceBinding: 'repository', tabs: tabs(1) }],
      }),
    ).toMatchObject({
      opensAs: ['project-view'],
      worksWith: ['files-and-code'],
    });
  });

  test('a pane that needs a Task works with Tasks', () => {
    expect(
      deriveRegistryAppFacts({
        manifest: {
          workspacePanes: [
            {
              name: 'Review',
              placement: { supportedRegions: ['primary'] },
              modes: [{ id: 'default', contextRequirement: { task: true } }],
            },
          ],
        },
        layouts: [],
      }),
    ).toMatchObject({ opensAs: ['screen'], worksWith: ['tasks'] });
  });

  test('refuses a tab list over the bound instead of truncating it', () => {
    expect(
      deriveRegistryAppFacts({ manifest: {}, layouts: [{ tabs: tabs(32) }] }),
    ).toMatchObject({ kind: 'app' });
    expect(
      deriveRegistryAppFacts({ manifest: {}, layouts: [{ tabs: tabs(33) }] }),
    ).toBeNull();
  });

  test('refuses a tab with no label', () => {
    expect(
      deriveRegistryAppFacts({
        manifest: {},
        layouts: [{ tabs: [{ id: 'a', component: 'a' }] }],
      }),
    ).toBeNull();
  });
});

describe('parseRegistryAppFacts', () => {
  const app = deriveRegistryAppFacts({
    manifest: { agents: [{}], integrations: { required: ['tools'] } },
    layouts: [{ tabs: tabs(2) }],
  });

  test('reads back what derivation produces', () => {
    expect(app).not.toBeNull();
    expect(parseRegistryAppFacts(JSON.parse(JSON.stringify(app)))).toEqual(app);
    expect(parseRegistryAppFacts({ kind: 'none' })).toEqual({ kind: 'none' });
  });

  test('refuses values outside the shape or its bounds', () => {
    const labels = (count: number) =>
      Array.from({ length: count }, (_, index) => `Label ${index}`);
    expect(
      parseRegistryAppFacts({ ...app, screens: labels(32) }),
    ).not.toBeNull();
    expect(parseRegistryAppFacts({ ...app, screens: labels(33) })).toBeNull();
    expect(parseRegistryAppFacts({ ...app, screens: ['A', 'A'] })).toBeNull();
    expect(parseRegistryAppFacts({ ...app, opensAs: ['window'] })).toBeNull();
    expect(parseRegistryAppFacts({ ...app, agents: -1 })).toBeNull();
    expect(parseRegistryAppFacts({ kind: 'none', screens: [] })).toBeNull();
    expect(parseRegistryAppFacts('app')).toBeNull();
  });
});
