import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DistributionProfileService,
  resolveDistributionProfile,
} from '../distribution-profile-service.js';

describe('DistributionProfileService', () => {
  const homes: string[] = [];

  function home(): string {
    const value = mkdtempSync(join(tmpdir(), 'station-distribution-'));
    homes.push(value);
    return value;
  }

  function writePlugin(
    projectHome: string,
    pluginName: string,
    layoutSlug = pluginName,
  ): string {
    const pluginDir = join(projectHome, 'plugins', pluginName);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: pluginName,
        version: '1.2.3',
        layout: { slug: layoutSlug, source: 'layout.json' },
      }),
    );
    writeFileSync(
      join(pluginDir, 'layout.json'),
      JSON.stringify({ name: pluginName, slug: layoutSlug, tabs: [] }),
    );
    return pluginDir;
  }

  function writePanePlugin(projectHome: string, pluginName: string): void {
    const pluginDir = join(projectHome, 'plugins', pluginName);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: pluginName,
        version: '1.2.3',
        workspacePanes: [
          {
            version: '1.0',
            id: `${pluginName}-review`,
            name: 'Review',
            rendererId: `${pluginName}.review`,
            renderer: { kind: 'plugin-component', name: 'review' },
            placement: { supportedRegions: ['primary'] },
            modes: [{ id: 'default', contextRequirement: { project: true } }],
            provenance: { origin: 'plugin', pluginId: pluginName },
            lifecycle: { stage: 'stable' },
          },
        ],
      }),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    homes
      .splice(0)
      .forEach((value) => rmSync(value, { recursive: true, force: true }));
  });

  test('standard is offline-safe and exposes installed Coding, Tasks, and Session Board starters', () => {
    const service = new DistributionProfileService(home());
    expect(service.listLayouts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'builtin:coding',
          lifecycle: expect.objectContaining({ state: 'installed' }),
          enabled: true,
        }),
        expect.objectContaining({
          id: 'builtin:tasks',
          lifecycle: expect.objectContaining({ state: 'installed' }),
          enabled: true,
        }),
        expect.objectContaining({
          id: 'builtin:session-board',
          type: 'session-board',
          lifecycle: expect.objectContaining({ state: 'installed' }),
          enabled: true,
        }),
      ]),
    );
  });

  test('a Session Board catalog entry resolves to an applyable layout definition', () => {
    const service = new DistributionProfileService(home());
    const resolved = service.resolveForApply('builtin:session-board');
    expect(resolved.definition).toMatchObject({
      name: 'Session Board',
      slug: 'session-board',
      type: 'session-board',
    });
    expect(resolved.pluginName).toBeUndefined();
  });

  test('minimal starts with no catalog sources', () => {
    const projectHome = home();
    writePlugin(projectHome, 'hidden-plugin');
    expect(
      new DistributionProfileService(projectHome, 'minimal').listLayouts(),
    ).toEqual([]);
  });

  test('lists a pane-only third-party plugin without requiring a legacy layout', () => {
    const projectHome = home();
    writePanePlugin(projectHome, 'review-plugin');
    const [contribution] = new DistributionProfileService(
      projectHome,
    ).listPluginWorkspacePaneContributions();
    expect(contribution).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^plugin:review-plugin:pane-[a-f0-9]{12}$/),
        pluginName: 'review-plugin',
        enabled: true,
        descriptor: expect.objectContaining({
          version: '1.0',
          renderer: { kind: 'plugin-component', name: 'review' },
        }),
        // The catalog records the installed directory and manifest version.
        // On the supported installer path the directory and descriptor claim
        // both derive from manifest.name, so this pins consistency rather than
        // independently controlled identity.
        contribution: {
          id: contribution.id,
          version: '1.2.3',
          sourceIdentity: {
            id: 'review-plugin',
            kind: 'local',
            source: 'plugins/review-plugin',
          },
          provenance: { origin: 'plugin', pluginId: 'review-plugin' },
        },
      }),
    );
    expect(
      new DistributionProfileService(projectHome, {
        id: 'organization',
        registrySources: [
          { id: 'installed-plugins', kind: 'local', source: 'plugins' },
        ],
        itemPolicies: { [contribution.id]: { enabled: false } },
      }).listPluginWorkspacePaneContributions(),
    ).toEqual([
      expect.objectContaining({ id: contribution.id, enabled: false }),
    ]);
  });

  test('keeps period-bearing Agent Plugins visible in Pane discovery', () => {
    const projectHome = home();
    writePanePlugin(projectHome, 'acme.tools');
    expect(
      new DistributionProfileService(
        projectHome,
      ).listPluginWorkspacePaneContributions(),
    ).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^plugin:acme\.tools:pane-[a-f0-9]{12}$/),
        pluginName: 'acme.tools',
      }),
    ]);
  });

  test('keeps period-bearing Agent Plugins in legacy layout projection until layout retirement', () => {
    const projectHome = home();
    writePlugin(projectHome, 'acme.tools', 'tools');
    const service = new DistributionProfileService(projectHome);
    expect(service.listLayouts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'plugin:acme.tools:tools',
          plugin: 'acme.tools',
        }),
      ]),
    );
    expect(service.resolveForApply('plugin:acme.tools:tools')).toMatchObject({
      pluginName: 'acme.tools',
      definition: { slug: 'tools' },
    });
  });

  test('a manually relocated plugin with divergent directory and descriptor claims is recorded for fail-closed consistency checking', () => {
    // A manifest whose `name` diverges from its installed directory passes
    // the loader (panes must name the MANIFEST name), but the issuance
    // snapshot records where the code actually lives. The client consistency
    // check then refuses the renderer when the two records disagree. The
    // supported installer instead makes these names equal from manifest.name.
    const projectHome = home();
    const pluginDir = join(projectHome, 'plugins', 'actual-directory');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'claimed-name',
        version: '9.9.9',
        workspacePanes: [
          {
            version: '1.0',
            id: 'claimed-review',
            name: 'Review',
            rendererId: 'claimed-name.review',
            renderer: { kind: 'plugin-component', name: 'review' },
            placement: { supportedRegions: ['primary'] },
            modes: [{ id: 'default', contextRequirement: { project: true } }],
            provenance: { origin: 'plugin', pluginId: 'claimed-name' },
            lifecycle: { stage: 'stable' },
          },
        ],
      }),
    );
    const [entry] = new DistributionProfileService(
      projectHome,
    ).listPluginWorkspacePaneContributions();
    expect(entry).toEqual(
      expect.objectContaining({
        pluginName: 'actual-directory',
        descriptor: expect.objectContaining({
          provenance: { origin: 'plugin', pluginId: 'claimed-name' },
        }),
        contribution: expect.objectContaining({
          version: '9.9.9',
          sourceIdentity: expect.objectContaining({
            id: 'actual-directory',
            source: 'plugins/actual-directory',
          }),
          provenance: { origin: 'plugin', pluginId: 'actual-directory' },
        }),
      }),
    );
  });

  test('organization policy can hide a starter and leave another installable', () => {
    const service = new DistributionProfileService(home(), {
      id: 'acme',
      registrySources: [{ id: 'builtin', kind: 'builtin' }],
      itemPolicies: {
        'builtin:coding': { visible: false },
        'builtin:tasks': { visible: true, preinstalled: false, enabled: true },
        'builtin:session-board': { visible: false },
      },
    });
    expect(service.listLayouts()).toEqual([
      expect.objectContaining({
        id: 'builtin:tasks',
        lifecycle: expect.objectContaining({ state: 'installable' }),
        enabled: false,
      }),
    ]);
  });

  test('persists only an explicit built-in lifecycle override atomically', () => {
    const projectHome = home();
    const service = new DistributionProfileService(projectHome);
    service.setEnabled('builtin:coding', false);
    expect(
      new DistributionProfileService(projectHome).getLayout('builtin:coding'),
    ).toMatchObject({
      lifecycle: { state: 'disabled' },
      enabled: false,
    });
    expect(
      JSON.parse(
        readFileSync(
          join(projectHome, 'config', 'distribution-lifecycle.json'),
          'utf-8',
        ),
      ),
    ).toEqual({
      version: 1,
      items: { 'builtin:coding': { enabled: false } },
    });
  });

  test('standard includes installed plugin layouts through the same lifecycle contract', () => {
    const projectHome = home();
    writePlugin(projectHome, 'team-layout', 'team');
    const service = new DistributionProfileService(projectHome);
    expect(service.getLayout('plugin:team-layout:team')).toMatchObject({
      lifecycle: { state: 'installed' },
      enabled: true,
      source: 'plugin',
      contribution: {
        id: 'plugin:team-layout:team',
        version: '1.2.3',
        provenance: { origin: 'plugin', pluginId: 'team-layout' },
      },
    });
    expect(service.resolveForApply('plugin:team-layout:team').pluginName).toBe(
      'team-layout',
    );
  });

  // A layout still on a retired key must not resolve. Reading `globalSkills`
  // off a layout that declares `globalPrompts` yields `undefined`, so before
  // this refusal the profile resolved cleanly with every global action gone —
  // a layout that looked like it loaded fine and had lost its quick actions
  // (review M1). This service isolates one bad plugin from the catalog rather
  // than failing every plugin, so the observable contract is: not offered, not
  // applyable, and the reason names both sides of the rename.
  test.each([
    [
      'a retired top-level key',
      { globalPrompts: [{ id: 'g1', label: 'Stand up', prompt: 'x' }] },
      /retired layout key 'globalPrompts'; rename it to 'globalSkills'/,
    ],
    [
      'a retired tab key',
      {
        tabs: [
          {
            id: 'main',
            label: 'Main',
            prompts: [{ type: 'prompt', label: 'Summarise', data: 'x' }],
          },
        ],
      },
      /tab\[0\] uses the retired layout key 'prompts'; rename it to 'skills'/,
    ],
  ])('refuses a plugin layout carrying %s', (_label, extra, message) => {
    const projectHome = home();
    const pluginDir = writePlugin(projectHome, 'retired-layout', 'retired');
    writeFileSync(
      join(pluginDir, 'layout.json'),
      JSON.stringify({
        name: 'retired-layout',
        slug: 'retired',
        tabs: [],
        ...extra,
      }),
    );
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const service = new DistributionProfileService(projectHome);

      expect(
        service.getLayout('plugin:retired-layout:retired'),
      ).toBeUndefined();
      expect(() =>
        service.resolveForApply('plugin:retired-layout:retired'),
      ).toThrow('Layout is not a known installed contribution');
      // The reason has to reach the operator, or "the plugin vanished" is all
      // they get. Asserted on the logged error, not assumed.
      expect(
        debug.mock.calls.some((call) =>
          call.some((arg) =>
            message.test(String((arg as Error)?.message ?? arg)),
          ),
        ),
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });

  // A plugin whose layout is fine is unaffected: the refusal above is not a
  // blanket "any plugin with tabs is suspect".
  test('a plugin layout on the current keys still resolves', () => {
    const projectHome = home();
    const pluginDir = writePlugin(projectHome, 'current-layout', 'current');
    writeFileSync(
      join(pluginDir, 'layout.json'),
      JSON.stringify({
        name: 'current-layout',
        slug: 'current',
        globalSkills: [{ id: 'g1', label: 'Stand up', prompt: 'x' }],
        tabs: [
          {
            id: 'main',
            label: 'Main',
            skills: [{ type: 'prompt', label: 'Summarise', data: 'x' }],
          },
        ],
      }),
    );
    const service = new DistributionProfileService(projectHome);

    expect(
      service.resolveForApply('plugin:current-layout:current').definition
        .globalSkills,
    ).toEqual([{ id: 'g1', label: 'Stand up', prompt: 'x' }]);
  });

  test('reads a disabled installed plugin descriptor without authorizing application', () => {
    const projectHome = home();
    writePlugin(projectHome, 'disabled-layout', 'disabled');
    const service = new DistributionProfileService(projectHome);
    service.setEnabled('plugin:disabled-layout:disabled', false);

    expect(
      service.resolveForCatalog('plugin:disabled-layout:disabled'),
    ).toMatchObject({
      item: {
        lifecycle: { state: 'disabled' },
        enabled: false,
        id: 'plugin:disabled-layout:disabled',
      },
      pluginName: 'disabled-layout',
    });
    expect(() =>
      service.resolveForApply('plugin:disabled-layout:disabled'),
    ).toThrow('Layout is not installed and enabled');
  });

  test('built-in-only profiles exclude installed plugins', () => {
    const projectHome = home();
    writePlugin(projectHome, 'hidden-plugin');
    const service = new DistributionProfileService(projectHome, {
      id: 'builtin-only',
      registrySources: [{ id: 'builtin', kind: 'builtin' }],
    });
    expect(service.listLayouts().some((item) => item.source === 'plugin')).toBe(
      false,
    );
  });

  test('a plugins local source permits every installed plugin', () => {
    const projectHome = home();
    writePlugin(projectHome, 'first-plugin', 'first');
    writePlugin(projectHome, 'second-plugin', 'second');
    const service = new DistributionProfileService(projectHome, {
      id: 'plugins-all',
      registrySources: [
        { id: 'installed-plugins', kind: 'local', source: 'plugins' },
      ],
    });
    expect(service.listLayouts().map((item) => item.id)).toEqual([
      'plugin:first-plugin:first',
      'plugin:second-plugin:second',
    ]);
  });

  test('a plugin-specific local source permits only that installed plugin', () => {
    const projectHome = home();
    writePlugin(projectHome, 'first-plugin', 'first');
    writePlugin(projectHome, 'second-plugin', 'second');
    const service = new DistributionProfileService(projectHome, {
      id: 'plugin-one',
      registrySources: [
        {
          id: 'first-plugin',
          kind: 'local',
          source: 'plugins/first-plugin',
        },
      ],
    });
    expect(service.listLayouts().map((item) => item.id)).toEqual([
      'plugin:first-plugin:first',
    ]);
  });

  test.each([
    ['array override', []],
    ['null override', null],
    ['unknown field', { installed: true, surprise: false }],
    ['non-boolean installed', { installed: 'yes' }],
    ['non-boolean enabled', { enabled: 1 }],
  ])('rejects malformed lifecycle state: %s', (_name, override) => {
    const projectHome = home();
    mkdirSync(join(projectHome, 'config'), { recursive: true });
    writeFileSync(
      join(projectHome, 'config', 'distribution-lifecycle.json'),
      JSON.stringify({ version: 1, items: { 'builtin:coding': override } }),
    );
    expect(() =>
      new DistributionProfileService(projectHome).listLayouts(),
    ).toThrow('Distribution lifecycle state is invalid');
  });

  test('rejects a lifecycle items array', () => {
    const projectHome = home();
    mkdirSync(join(projectHome, 'config'), { recursive: true });
    writeFileSync(
      join(projectHome, 'config', 'distribution-lifecycle.json'),
      JSON.stringify({ version: 1, items: [] }),
    );
    expect(() =>
      new DistributionProfileService(projectHome).listLayouts(),
    ).toThrow('Distribution lifecycle state is invalid');
  });

  test('does not swallow invalid lifecycle state while projecting a plugin', () => {
    const projectHome = home();
    writePlugin(projectHome, 'team-layout', 'team');
    mkdirSync(join(projectHome, 'config'), { recursive: true });
    writeFileSync(
      join(projectHome, 'config', 'distribution-lifecycle.json'),
      JSON.stringify({
        version: 1,
        items: { 'plugin:team-layout:team': { enabled: 'yes' } },
      }),
    );
    const service = new DistributionProfileService(projectHome, {
      id: 'plugins',
      registrySources: [
        { id: 'installed-plugins', kind: 'local', source: 'plugins' },
      ],
    });
    expect(() => service.listLayouts()).toThrow(
      'Distribution lifecycle state is invalid',
    );
  });

  test('skips symlinked manifest and layout files that could escape the plugin root', () => {
    const projectHome = home();
    const outsideManifest = join(projectHome, 'outside-plugin.json');
    const outsideLayout = join(projectHome, 'outside-layout.json');
    writeFileSync(
      outsideManifest,
      JSON.stringify({
        name: 'manifest-link',
        version: '1.0.0',
        layout: { slug: 'manifest-link', source: 'layout.json' },
      }),
    );
    writeFileSync(
      outsideLayout,
      JSON.stringify({ name: 'Escaped', slug: 'layout-link', tabs: [] }),
    );
    const manifestLinkDir = join(projectHome, 'plugins', 'manifest-link');
    mkdirSync(manifestLinkDir, { recursive: true });
    symlinkSync(outsideManifest, join(manifestLinkDir, 'plugin.json'));
    writeFileSync(
      join(manifestLinkDir, 'layout.json'),
      JSON.stringify({
        name: 'Manifest Link',
        slug: 'manifest-link',
        tabs: [],
      }),
    );
    const layoutLinkDir = writePlugin(projectHome, 'layout-link');
    rmSync(join(layoutLinkDir, 'layout.json'));
    symlinkSync(outsideLayout, join(layoutLinkDir, 'layout.json'));
    const diagnostic = vi.spyOn(console, 'debug').mockImplementation(() => {});

    expect(
      new DistributionProfileService(projectHome)
        .listLayouts()
        .filter((item) => item.source === 'plugin'),
    ).toEqual([]);
    expect(diagnostic).toHaveBeenCalledTimes(2);
    diagnostic.mockRestore();
  });

  test('skips a malformed plugin with a diagnostic', () => {
    const projectHome = home();
    const pluginDir = join(projectHome, 'plugins', 'broken-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), '{not-json');
    const diagnostic = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const layouts = new DistributionProfileService(projectHome).listLayouts();
    expect(layouts.some((item) => item.source === 'plugin')).toBe(false);
    expect(layouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'builtin:coding',
          lifecycle: expect.objectContaining({ state: 'installed' }),
          enabled: true,
        }),
      ]),
    );
    expect(diagnostic).toHaveBeenCalledWith(
      'Failed to read installed plugin layout:',
      'broken-plugin',
      expect.anything(),
    );
    diagnostic.mockRestore();
  });

  test('rejects duplicate and unsafe profile sources without touching the network', () => {
    expect(() =>
      resolveDistributionProfile({
        id: 'bad',
        registrySources: [
          { id: 'same', kind: 'builtin' },
          { id: 'same', kind: 'builtin' },
        ],
      }),
    ).toThrow('Duplicate registry source id');
    expect(() =>
      resolveDistributionProfile({
        id: 'bad',
        registrySources: [
          { id: 'remote', kind: 'remote', source: 'file:///tmp/registry' },
        ],
      }),
    ).toThrow('must use http(s)');
    expect(() =>
      resolveDistributionProfile({
        id: 'bad',
        registrySources: [{ id: 'local', kind: 'local', source: '../escape' }],
      }),
    ).toThrow('safe relative path');
  });
});
