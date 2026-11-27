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

  test('a Coding layout record is repository-bound even without the binding', () => {
    expect(
      deriveRegistryAppFacts({
        manifest: {},
        layouts: [{ type: 'coding', tabs: tabs(1) }],
      }),
    ).toMatchObject({
      opensAs: ['project-view'],
      worksWith: ['files-and-code'],
    });
  });

  test('counts only host actions that send a prompt', () => {
    const facts = deriveRegistryAppFacts({
      manifest: {
        workspacePaneHost: {
          actions: [
            { label: 'Daily overview', intent: { kind: 'plugin-prompt' } },
            { label: 'Summarize', intent: { kind: 'prompt' } },
            { label: 'Open settings', intent: { kind: 'navigate' } },
          ],
        },
      },
      layouts: [{ tabs: tabs(1) }],
    });
    expect(facts).toMatchObject({
      promptActions: ['Daily overview', 'Summarize'],
    });
  });

  test('counts a prompt once when a package action and a tab action send it', () => {
    const facts = deriveRegistryAppFacts({
      manifest: {
        name: 'demo',
        workspacePaneHost: {
          actions: [
            {
              label: 'Log activity',
              intent: { kind: 'plugin-prompt', promptId: 'activity' },
            },
          ],
        },
      },
      layouts: [
        {
          tabs: [
            {
              id: 'a',
              label: 'A',
              component: 'a',
              actions: [
                {
                  type: 'prompt',
                  label: 'Review activity',
                  data: 'demo:activity',
                },
                {
                  type: 'prompt',
                  label: 'Summarize',
                  data: 'Summarize this tab',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(facts).toMatchObject({
      promptActions: ['Log activity', 'Summarize'],
    });
  });

  test('says whether screen code runs inside Station', () => {
    expect(
      deriveRegistryAppFacts({
        manifest: { entrypoint: 'src/index.tsx' },
        layouts: [{ tabs: tabs(1) }],
      }),
    ).toMatchObject({ inProcessScreen: true });
    expect(
      deriveRegistryAppFacts({ manifest: {}, layouts: [{ tabs: tabs(1) }] }),
    ).toMatchObject({ inProcessScreen: false });
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
    // A field a newer writer adds does not make it unknown.
    expect(parseRegistryAppFacts({ kind: 'none', reason: 'skills' })).toEqual({
      kind: 'none',
    });
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
    expect(parseRegistryAppFacts('app')).toBeNull();
  });
});
