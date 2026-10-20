import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  captureLoggerLines,
  stopLoggerCaptures,
} from '../../../__test-utils__/logger-capture.js';
import { readCurrentWorkspacePaneCatalog } from '../../projects/workspace-pane-catalog.js';
import {
  DistributionProfileService,
  resolveDistributionProfile,
} from '../distribution-profile-service.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

/**
 * Fails the n-th durable write from now (1 = the next), as a full disk or a
 * lost rename would.
 */
const durableWrite = vi.hoisted(() => ({ failAt: 0 }));
vi.mock('@kontourai/station-shared/durable-json-file', async (original) => {
  const actual =
    await original<
      typeof import('@kontourai/station-shared/durable-json-file')
    >();
  return {
    ...actual,
    writeJsonDurably: (...args: Parameters<typeof actual.writeJsonDurably>) => {
      if (durableWrite.failAt > 0) {
        durableWrite.failAt -= 1;
        if (durableWrite.failAt === 0)
          throw new Error('injected durable write failure');
      }
      return actual.writeJsonDurably(...args);
    },
  };
});
// A capture is process-wide, and every use in this file asserts BEFORE its own
// `stop()`. Without this, one failing assertion leaks the sink — and any raised
// debug level — into every test after it.
afterEach(stopLoggerCaptures);

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
    durableWrite.failAt = 0;
    vi.restoreAllMocks();
    homes
      .splice(0)
      .forEach((value) => rmSync(value, { recursive: true, force: true }));
  });

  test('resolving a built-in does not read unrelated plugin payloads', () => {
    const projectHome = home();
    const other = join(
      realpathSync(writePlugin(projectHome, 'other-plugin')),
      'server.mjs',
    );
    writeFileSync(other, 'export const value = 1;');
    const service = new DistributionProfileService(projectHome);
    vi.mocked(readFileSync).mockClear();
    expect(service.resolveForCatalog('builtin:coding').item.id).toBe(
      'builtin:coding',
    );
    expect(
      vi.mocked(readFileSync).mock.calls.filter(([path]) => path === other),
    ).toHaveLength(0);
  });

  test('a known plugin layout reads only its own payload once', () => {
    const projectHome = home();
    const other = join(
      realpathSync(writePlugin(projectHome, 'other-plugin')),
      'server.mjs',
    );
    const selected = join(
      realpathSync(writePlugin(projectHome, 'selected-plugin', 'selected')),
      'server.mjs',
    );
    writeFileSync(other, 'export const value = 1;');
    writeFileSync(selected, 'export const value = 2;');
    const service = new DistributionProfileService(projectHome);
    vi.mocked(readFileSync).mockClear();
    expect(
      service.resolveForCatalog('plugin:selected-plugin:selected').definition
        .slug,
    ).toBe('selected');
    expect(
      vi.mocked(readFileSync).mock.calls.filter(([path]) => path === other),
    ).toHaveLength(0);
    expect(
      vi.mocked(readFileSync).mock.calls.filter(([path]) => path === selected),
    ).toHaveLength(1);
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
          // History was never sealed: no generation a host could admit.
          lifecycleGeneration: null,
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

  test('refuses a manually relocated plugin before publishing divergent identity claims', () => {
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
    expect(
      new DistributionProfileService(
        projectHome,
      ).listPluginWorkspacePaneContributions(),
    ).toEqual([]);
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
    // Every builtin the policy did NOT hide, in `listLayouts`' own
    // name order — not just the one the policy names. #2065 added a fourth
    // builtin (`builtin:review`) and this list silently grew by a row, which
    // is the whole reason it is asserted exhaustively: the claim is that a
    // policy hides exactly what it names and leaves the rest installable, and
    // an expectation naming one row cannot tell "the others are hidden" from
    // "the others were never there".
    expect(service.listLayouts()).toEqual([
      expect.objectContaining({
        id: 'builtin:review',
        lifecycle: expect.objectContaining({ state: 'installable' }),
        enabled: false,
      }),
      expect.objectContaining({
        id: 'builtin:tasks',
        lifecycle: expect.objectContaining({ state: 'installable' }),
        enabled: false,
      }),
    ]);
    // Named, not merely implied by the exhaustive list above — that list
    // fails first on any membership change, so read these as what the
    // exhaustive expectation MEANS rather than as independent coverage of a
    // future builtin. (They are reached only when the list already agrees.)
    const visibleIds = service.listLayouts().map((item) => item.id);
    expect(visibleIds).not.toContain('builtin:coding');
    expect(visibleIds).not.toContain('builtin:session-board');
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
    const debug = captureLoggerLines('debug');
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
        debug
          .at('debug')
          .some((line) =>
            message.test(String((line.error as Error)?.message ?? line.msg)),
          ),
      ).toBe(true);
    } finally {
      debug.stop();
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

  // #1446. Every example plugin layout omits `type`; defaulting it to 'chat'
  // made the app treat each installed example as the full-viewport Chat
  // placement and unmount its ambient regions. The definition carries the
  // author's own word when present and 'custom' — the manual create route's
  // default — when absent.
  test('a plugin layout without a type resolves as custom, and a declared type is kept', () => {
    const projectHome = home();
    writePlugin(projectHome, 'typeless-layout', 'typeless');
    const typedDir = writePlugin(projectHome, 'typed-layout', 'typed');
    writeFileSync(
      join(typedDir, 'layout.json'),
      JSON.stringify({
        name: 'typed-layout',
        slug: 'typed',
        type: 'session-board',
        tabs: [],
      }),
    );
    const service = new DistributionProfileService(projectHome);

    expect(
      service.resolveForApply('plugin:typeless-layout:typeless').definition
        .type,
    ).toBe('custom');
    expect(
      service.resolveForApply('plugin:typed-layout:typed').definition.type,
    ).toBe('session-board');
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
    const diagnostic = captureLoggerLines('debug');

    expect(
      new DistributionProfileService(projectHome)
        .listLayouts()
        .filter((item) => item.source === 'plugin'),
    ).toEqual([]);
    expect(diagnostic.at('debug')).toHaveLength(2);
    diagnostic.stop();
  });

  test('skips a malformed plugin with a diagnostic', () => {
    const projectHome = home();
    const pluginDir = join(projectHome, 'plugins', 'broken-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), '{not-json');
    const diagnostic = captureLoggerLines('debug');

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
    expect(diagnostic.at('debug')).toContainEqual(
      expect.objectContaining({
        msg: 'Failed to read installed plugin layout',
        plugin: 'broken-plugin',
        error: expect.anything(),
      }),
    );
    diagnostic.stop();
  });

  test('one pane catalog observes each package once and the next request sees new bytes', async () => {
    const projectHome = realpathSync(home());
    const pluginDir = writePlugin(projectHome, 'catalog-cost');
    const payload = join(pluginDir, 'payload.txt');
    writeFileSync(payload, 'first');
    const service = new DistributionProfileService(projectHome);
    vi.mocked(readFileSync).mockClear();
    const first = readCurrentWorkspacePaneCatalog(
      await service.captureCatalog(),
      'project-a',
    );
    expect(
      first.contributions.some(
        (item) => item.sourceIdentity.id === 'catalog-cost',
      ),
    ).toBe(true);
    expect(
      vi.mocked(readFileSync).mock.calls.filter(([path]) => path === payload),
    ).toHaveLength(1);
    const manifestPath = join(pluginDir, 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, version: '2.0.0' }),
    );
    vi.mocked(readFileSync).mockClear();
    const next = readCurrentWorkspacePaneCatalog(
      await service.captureCatalog(),
      'project-a',
    );
    expect(
      next.contributions.find(
        (item) => item.sourceIdentity.id === 'catalog-cost',
      )?.contribution.version,
    ).toBe('2.0.0');
    expect(
      vi.mocked(readFileSync).mock.calls.filter(([path]) => path === payload),
    ).toHaveLength(1);
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

  describe('a plugin contribution’s lifecycle generation', () => {
    const LAYOUT = 'plugin:lifecycle-layout:lifecycle';
    const ISSUED = /^digest:sha256:[a-f0-9]+:[a-f0-9]{32}\.r\d+$/;
    const generationOf = (service: DistributionProfileService) =>
      service.resolveForCatalog(LAYOUT).item.contribution.lifecycleGeneration;
    const lifecyclePath = (projectHome: string) =>
      join(projectHome, 'config', 'distribution-lifecycle.json');
    const readDocument = (projectHome: string) =>
      JSON.parse(readFileSync(lifecyclePath(projectHome), 'utf-8'));
    const writeDocument = (projectHome: string, value: unknown) =>
      writeFileSync(lifecyclePath(projectHome), JSON.stringify(value));
    /** Every generation one test saw issued; none may ever repeat. */
    const issuedLedger = () => {
      const issued: string[] = [];
      return {
        issued,
        record(generation: string | null | undefined) {
          if (generation === null) return;
          expect(generation).toMatch(ISSUED);
          expect(issued).not.toContain(generation);
          issued.push(generation as string);
        },
      };
    };
    /** Sealed at start, then installed, disabled, enabled again. */
    const cycled = (projectHome: string) => {
      writePlugin(projectHome, 'lifecycle-layout', 'lifecycle');
      const service = new DistributionProfileService(projectHome);
      expect(service.sealLifecycleHistory()).toBe('sealed');
      const ledger = issuedLedger();
      ledger.record(generationOf(service));
      service.setEnabled(LAYOUT, false);
      ledger.record(generationOf(service));
      service.setEnabled(LAYOUT, true);
      ledger.record(generationOf(service));
      expect(ledger.issued).toHaveLength(3);
      return { service, ledger };
    };

    test('is issued only under sealed history, and a seal is kept', () => {
      const projectHome = home();
      writePlugin(projectHome, 'lifecycle-layout', 'lifecycle');
      const service = new DistributionProfileService(projectHome);
      // Nothing was sealed: no generation a host could admit.
      expect(generationOf(service)).toBeNull();
      expect(service.sealLifecycleHistory()).toBe('sealed');
      const sealed = generationOf(service);
      expect(sealed).toMatch(/:[a-f0-9]{32}\.r0$/);
      expect(service.sealLifecycleHistory()).toBe('already-sealed');
      expect(generationOf(new DistributionProfileService(projectHome))).toBe(
        sealed,
      );
    });

    test('changes when its enablement changes, and not when the same value is written again', () => {
      const projectHome = home();
      const { service, ledger } = cycled(projectHome);
      const enabledAgain = ledger.issued[2];
      service.setEnabled(LAYOUT, true);
      expect(generationOf(service)).toBe(enabledAgain);
      // A new service reads the same durable generation.
      expect(generationOf(new DistributionProfileService(projectHome))).toBe(
        enabledAgain,
      );
    });

    test('changes when the installation is replaced at the same version', () => {
      const projectHome = home();
      const pluginDir = writePlugin(
        projectHome,
        'lifecycle-layout',
        'lifecycle',
      );
      new DistributionProfileService(projectHome).sealLifecycleHistory();
      const before = generationOf(new DistributionProfileService(projectHome));
      const manifest = JSON.parse(
        readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'),
      );
      writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({ ...manifest, description: 'Reinstalled' }),
      );
      const after = generationOf(new DistributionProfileService(projectHome));
      expect(manifest.version).toBe('1.2.3');
      expect(after).toMatch(ISSUED);
      expect(after).not.toBe(before);
    });

    // Lost history — the document removed, or reset — is no generation until
    // a new epoch is sealed, so the generation from before the first change
    // never comes back.
    test('lost history never brings an earlier generation back, however often it is lost', () => {
      const projectHome = home();
      const { service, ledger } = cycled(projectHome);
      for (let loss = 0; loss < 2; loss += 1) {
        rmSync(lifecyclePath(projectHome));
        expect(generationOf(service)).toBeNull();
        expect(service.sealLifecycleHistory()).toBe('sealed');
        ledger.record(generationOf(service));
        service.setEnabled(LAYOUT, false);
        ledger.record(generationOf(service));
        service.setEnabled(LAYOUT, true);
        ledger.record(generationOf(service));
      }
      expect(ledger.issued).toHaveLength(9);
    });

    test('revisions that cannot be read are no generation, refuse changes, are not sealed over, and never repeat one', () => {
      const projectHome = home();
      const { service, ledger } = cycled(projectHome);
      for (let fault = 0; fault < 2; fault += 1) {
        const healthy = readDocument(projectHome);
        writeDocument(projectHome, {
          ...healthy,
          revisions: { epoch: 'corrupt', items: {} },
        });
        expect(generationOf(service)).toBeNull();
        const document = readFileSync(lifecyclePath(projectHome), 'utf-8');
        expect(() => service.setEnabled(LAYOUT, false)).toThrow(
          'Distribution lifecycle revisions are invalid',
        );
        expect(service.sealLifecycleHistory()).toBe('invalid');
        expect(readFileSync(lifecyclePath(projectHome), 'utf-8')).toBe(
          document,
        );
        // Repaired by removing the unreadable member: a new epoch is sealed.
        const { revisions: _revisions, ...withoutRevisions } = healthy;
        writeDocument(projectHome, withoutRevisions);
        expect(generationOf(service)).toBeNull();
        expect(service.sealLifecycleHistory()).toBe('sealed');
        ledger.record(generationOf(service));
        service.setEnabled(LAYOUT, false);
        ledger.record(generationOf(service));
        service.setEnabled(LAYOUT, true);
        ledger.record(generationOf(service));
      }
    });

    test('an older server’s rewrite, which drops the revisions, is no generation until a new epoch, however often it happens', () => {
      const projectHome = home();
      const { service, ledger } = cycled(projectHome);
      for (let rewrite = 0; rewrite < 2; rewrite += 1) {
        const { version, items } = readDocument(projectHome);
        writeDocument(projectHome, { version, items });
        expect(generationOf(service)).toBeNull();
        expect(service.resolveForCatalog(LAYOUT).item.enabled).toBe(true);
        expect(service.sealLifecycleHistory()).toBe('sealed');
        ledger.record(generationOf(service));
        service.setEnabled(LAYOUT, false);
        ledger.record(generationOf(service));
        service.setEnabled(LAYOUT, true);
        ledger.record(generationOf(service));
      }
    });

    // Whichever durable write of the change fails, the enablement and the
    // generation agree afterwards, and the change, retried, is a new
    // generation: none is left stale by a change that half happened.
    test.each([1, 2])(
      'when durable write %i of a change fails, the enablement and the generation still agree, and a retry advances both',
      (failing) => {
        const projectHome = home();
        const { service, ledger } = cycled(projectHome);
        const enabled = generationOf(service);
        durableWrite.failAt = failing;
        try {
          service.setEnabled(LAYOUT, false);
        } catch (error) {
          expect(String(error)).toContain('injected durable write failure');
        }
        durableWrite.failAt = 0;
        const disabledNow = !service.resolveForCatalog(LAYOUT).item.enabled;
        if (disabledNow) ledger.record(generationOf(service));
        else expect(generationOf(service)).toBe(enabled);
        service.setEnabled(LAYOUT, false);
        expect(service.resolveForCatalog(LAYOUT).item.enabled).toBe(false);
        const retried = generationOf(service);
        if (!disabledNow) ledger.record(retried);
        expect(retried).toMatch(ISSUED);
        // After a restart, the same.
        expect(generationOf(new DistributionProfileService(projectHome))).toBe(
          retried,
        );
      },
    );

    test('keeps the override items in the shape an older server reads', () => {
      const projectHome = home();
      const { service } = cycled(projectHome);
      service.setEnabled(LAYOUT, false);
      service.setEnabled(LAYOUT, true);
      const document = readDocument(projectHome);
      // An older server checks `version` and every `items` entry (only
      // `installed` and `enabled`, booleans) and ignores other members.
      expect(Object.keys(document).sort()).toEqual([
        'items',
        'revisions',
        'version',
      ]);
      expect(document.version).toBe(1);
      expect(document.items).toEqual({ [LAYOUT]: { enabled: true } });
      expect(document.revisions).toEqual({
        epoch: expect.stringMatching(/^[a-f0-9]{32}$/),
        items: { [LAYOUT]: 4 },
      });
    });

    test('is carried by a pane-only plugin’s contributions', () => {
      const projectHome = home();
      writePanePlugin(projectHome, 'review-plugin');
      const service = new DistributionProfileService(projectHome);
      expect(
        service.listPluginWorkspacePaneContributions()[0]?.contribution
          .lifecycleGeneration,
      ).toBeNull();
      service.sealLifecycleHistory();
      expect(
        service.listPluginWorkspacePaneContributions()[0]?.contribution
          .lifecycleGeneration,
      ).toMatch(/^digest:sha256:[a-f0-9]+:[a-f0-9]{32}\.r0$/);
    });
  });
});
