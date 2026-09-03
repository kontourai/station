import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANONICAL_PLUGIN_ID_PATTERN } from '@kontourai/station-contracts/plugin';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ContextSafetyError } from '../../orchestration/context-safety.js';
import { DistributionProfileService } from '../distribution-profile-service.js';
import { readPluginManifestFile } from '../plugin-manifest-loader.js';

const STATION_EXTENSION = 'io.kontourai.station';

describe('plugin-manifest-loader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plugin-manifest-loader-'));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  test('allows benign security-themed manifest metadata', async () => {
    const manifestPath = join(dir, 'plugin.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          name: 'security-helper',
          version: '1.0.0',
          description:
            'Review sandbox policy and hidden system prompt exposure risks.',
        },
        null,
        2,
      ),
    );

    await expect(readPluginManifestFile(manifestPath)).resolves.toEqual(
      expect.objectContaining({
        name: 'security-helper',
      }),
    );
  });

  describe('Station command contributions', () => {
    async function loadCommands(
      commands: unknown[],
      manifest: Record<string, unknown> = {},
    ) {
      const manifestPath = join(dir, 'plugin.json');
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: 'demo-plugin',
          version: '1.0.0',
          ...manifest,
          extensions: { [STATION_EXTENSION]: { commands } },
        }),
      );
      return readPluginManifestFile(manifestPath);
    }

    const navigateCommand = {
      version: '1.0',
      id: 'demo-plugin.open-settings',
      title: 'Open settings',
      subtitle: 'Review Station settings',
      icon: 'plugin',
      keywords: ['settings', 'review'],
      requires: ['project'],
      intent: { kind: 'navigate', surfaceId: 'settings' },
    };

    test('normalizes a manifest-only command without executable plugin code', async () => {
      await expect(loadCommands([navigateCommand])).resolves.toMatchObject({
        extensions: {
          [STATION_EXTENSION]: {
            commands: [navigateCommand],
          },
        },
      });
    });

    test('gives iframe and trusted packages the same inert command shape', async () => {
      const iframe = await loadCommands([navigateCommand], {
        entrypoint: 'src/index.tsx',
      });
      const trusted = await loadCommands([navigateCommand], {
        serverModule: 'server.mjs',
      });
      expect(iframe.extensions?.[STATION_EXTENSION]).toEqual(
        trusted.extensions?.[STATION_EXTENSION],
      );
    });

    test.each([
      [
        'unknown intent',
        { ...navigateCommand, intent: { kind: 'run-code' } },
        /intent\.kind is unknown/,
      ],
      [
        'invalid icon',
        { ...navigateCommand, icon: '<svg onload=alert(1)>' },
        /icon is invalid/,
      ],
      [
        'excessive title',
        { ...navigateCommand, title: 'x'.repeat(81) },
        /title must be trimmed text between 1 and 80/,
      ],
      [
        'hostile URL allowlist',
        {
          ...navigateCommand,
          argument: {
            kind: 'url',
            label: 'URL',
            allowedHosts: ['*.example.com'],
          },
        },
        /allowedHosts\[0\] must be an exact host/,
      ],
      [
        'unused argument',
        {
          ...navigateCommand,
          argument: { kind: 'text', label: 'Query' },
        },
        /argument is declared but unused/,
      ],
    ])('rejects %s', async (_name, command, error) => {
      await expect(loadCommands([command])).rejects.toThrow(error);
    });

    test('rejects duplicate owner-qualified command ids', async () => {
      await expect(
        loadCommands([navigateCommand, navigateCommand]),
      ).rejects.toThrow(/contains duplicate id 'demo-plugin\.open-settings'/);
    });
  });

  // archive#4307: `manifest.name` is a STORE KEY (plugin-overrides, grants,
  // the provider resolver, the installed-plugin registry) and the manifest's
  // own `name` wins over the directory it was installed into. It was
  // validated only as a non-empty string, so `"name": "__proto__"` reached
  // `overrides[name]`, where the lookup answered `Object.prototype` — truthy,
  // so the `if (!overrides[name])` initializer was SKIPPED — and the write
  // hit the prototype setter: caller-controlled settings landed on
  // `Object.prototype` while `JSON.stringify` serialized an object with no
  // such own key, so the route reported success and nothing persisted.
  //
  // Both axes are exercised in both directions: a canonical name is accepted,
  // and each rejected shape is rejected for the reason it should be. The
  // reserved-key axis is NOT redundant with the canonical-id axis —
  // `constructor` and `prototype` both SATISFY CANONICAL_PLUGIN_ID_PATTERN.
  describe('manifest name is a store key, not a display string (station#4307)', () => {
    async function loadName(name: string) {
      const manifestPath = join(dir, 'plugin.json');
      writeFileSync(
        manifestPath,
        JSON.stringify({ name, version: '1.0.0' }, null, 2),
      );
      return readPluginManifestFile(manifestPath);
    }

    test('rejects the prototype-pollution name __proto__', async () => {
      await expect(loadName('__proto__')).rejects.toThrow(
        /not a canonical plugin id/,
      );
    });

    test.each(['constructor', 'prototype'])(
      'rejects the reserved object key %s, which the canonical-id pattern accepts',
      async (name) => {
        // Guard the premise of this test: if the canonical pattern ever
        // started refusing these, the reserved-key axis would be untested
        // rather than redundant.
        expect(CANONICAL_PLUGIN_ID_PATTERN.test(name)).toBe(true);
        await expect(loadName(name)).rejects.toThrow(
          /is a reserved object key and cannot name a plugin/,
        );
      },
    );

    test.each(['Name With Spaces', 'Upper-Case', 'has_underscore', '../evil'])(
      'rejects the non-canonical name %s',
      async (name) => {
        await expect(loadName(name)).rejects.toThrow(
          /not a canonical plugin id/,
        );
      },
    );

    test('accepts a canonical plugin id', async () => {
      await expect(loadName('my-plugin-1')).resolves.toEqual(
        expect.objectContaining({ name: 'my-plugin-1' }),
      );
    });
  });

  // archive#4307 review: a DECLARED SETTING's key is a store key too. It is
  // written into `overrides[plugin].settings` by `PUT /:name/settings` and
  // read back into the map handed to a plugin server module as
  // `config.get`/`config.all` — and nothing inspected it. A manifest declaring
  // `{"key": "__proto__"}` reparented that map on the first loop iteration,
  // with no store write anywhere: the plugin then read attacker-declared
  // values for keys no operator could see or remove.
  describe('a declared settings key is a store key too (station#4307)', () => {
    async function loadSettings(settings: unknown) {
      const manifestPath = join(dir, 'plugin.json');
      writeFileSync(
        manifestPath,
        JSON.stringify({ name: 'demo', settings, version: '1.0.0' }, null, 2),
      );
      return readPluginManifestFile(manifestPath);
    }

    test.each(['__proto__', 'constructor', 'prototype'])(
      'rejects a settings field keyed %s',
      async (key) => {
        await expect(
          loadSettings([{ default: { polluted: 'yes' }, key }]),
        ).rejects.toThrow(
          new RegExp(
            `settings\\[0\\]\\.key '${key}' is a reserved object key and cannot name a setting`,
          ),
        );
      },
    );

    test('names the offending index rather than the first field', async () => {
      await expect(
        loadSettings([{ key: 'endpoint' }, { key: '__proto__' }]),
      ).rejects.toThrow(/settings\[1\]\.key '__proto__'/);
    });

    test('accepts the ordinary camelCase field keys real manifests declare', async () => {
      // Deliberately only the reserved names are refused here: settings keys
      // are field names (`apiKey`), not canonical plugin ids, so the
      // canonical-id axis does not apply to them.
      await expect(
        loadSettings([
          { key: 'apiKey', label: 'API key', type: 'string' },
          { key: 'model_name' },
        ]),
      ).resolves.toEqual(
        expect.objectContaining({
          settings: [
            expect.objectContaining({ key: 'apiKey' }),
            expect.objectContaining({ key: 'model_name' }),
          ],
        }),
      );
    });
  });

  test('blocks manifests that use hidden unicode channels', async () => {
    const manifestPath = join(dir, 'plugin.json');
    writeFileSync(
      manifestPath,
      `{\n  "name": "unsafe-plugin",\n  "version": "1.0.0",\n  "description": "safe\u200Btext"\n}\n`,
    );

    await expect(readPluginManifestFile(manifestPath)).rejects.toBeInstanceOf(
      ContextSafetyError,
    );
  });

  test('normalizes a versioned direct Workspace Pane declaration', async () => {
    const manifestPath = join(dir, 'plugin.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'review-plugin',
        version: '1.0.0',
        workspacePanes: [
          {
            version: '1.0',
            id: 'review-queue',
            name: 'Review Queue',
            rendererId: 'review-plugin.review-queue',
            renderer: { kind: 'plugin-component', name: 'review-queue' },
            placement: { supportedRegions: ['secondary'] },
            modes: [{ id: 'default', contextRequirement: { project: true } }],
            provenance: { origin: 'plugin', pluginId: 'review-plugin' },
            lifecycle: { stage: 'stable' },
          },
        ],
      }),
    );
    await expect(readPluginManifestFile(manifestPath)).resolves.toMatchObject({
      workspacePanes: [
        {
          version: '1.0',
          id: 'review-queue',
          provenance: { origin: 'plugin', pluginId: 'review-plugin' },
        },
      ],
    });
  });

  test('the production catalog consumes the canonical pane-manifest parser across its acceptance corpus', async () => {
    const pluginDir = join(dir, 'plugins', 'review-plugin');
    const manifestPath = join(pluginDir, 'plugin.json');
    const pane = {
      version: '1.0',
      id: 'review-queue',
      name: 'Review Queue',
      rendererId: 'review-plugin.review-queue',
      renderer: { kind: 'plugin-component', name: 'review-queue' },
      placement: { supportedRegions: ['secondary'] },
      modes: [{ id: 'default' }],
      provenance: { origin: 'plugin', pluginId: 'review-plugin' },
      lifecycle: { stage: 'stable' },
    };
    const corpus: Array<{
      name: string;
      manifest: Record<string, unknown>;
      accepted: boolean;
    }> = [
      {
        name: 'valid modern declaration',
        manifest: {
          name: 'review-plugin',
          version: '1.0.0',
          workspacePanes: [pane],
        },
        accepted: true,
      },
      {
        name: 'mixed modern and legacy declarations',
        manifest: {
          name: 'review-plugin',
          version: '1.0.0',
          layout: { slug: 'review', source: 'layout.json' },
          workspacePanes: [pane],
        },
        accepted: false,
      },
      {
        name: 'wrong provenance origin',
        manifest: {
          name: 'review-plugin',
          version: '1.0.0',
          workspacePanes: [{ ...pane, provenance: { origin: 'builtin' } }],
        },
        accepted: false,
      },
      {
        name: 'wrong provenance plugin id',
        manifest: {
          name: 'review-plugin',
          version: '1.0.0',
          workspacePanes: [
            {
              ...pane,
              provenance: { origin: 'plugin', pluginId: 'other-plugin' },
            },
          ],
        },
        accepted: false,
      },
      {
        name: 'duplicate pane ids',
        manifest: {
          name: 'review-plugin',
          version: '1.0.0',
          workspacePanes: [pane, pane],
        },
        accepted: false,
      },
      {
        name: 'missing manifest version',
        manifest: { name: 'review-plugin', workspacePanes: [pane] },
        accepted: false,
      },
      {
        name: 'missing pane id',
        manifest: {
          name: 'review-plugin',
          version: '1.0.0',
          workspacePanes: [{ ...pane, id: undefined }],
        },
        accepted: false,
      },
    ];

    mkdirSync(pluginDir, { recursive: true });
    for (const fixture of corpus) {
      writeFileSync(manifestPath, JSON.stringify(fixture.manifest));
      const parsed = await readPluginManifestFile(manifestPath)
        .then((manifest) => ({ accepted: true as const, manifest }))
        .catch(() => ({ accepted: false as const }));
      const catalogEntries = new DistributionProfileService(
        dir,
      ).listPluginWorkspacePaneContributions();

      expect(parsed.accepted, fixture.name).toBe(fixture.accepted);
      expect(catalogEntries.length > 0, fixture.name).toBe(fixture.accepted);
      if (parsed.accepted) {
        expect(catalogEntries[0]?.descriptor, fixture.name).toEqual(
          parsed.manifest.workspacePanes?.[0],
        );
      }
    }
  });

  test.each(['contextRequirement', 'dockability'] as const)(
    'rejects retired Workspace Pane field %s with a migration message',
    async (field) => {
      const manifestPath = join(dir, 'plugin.json');
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: 'review-plugin',
          version: '1.0.0',
          workspacePanes: [
            {
              version: '1.0',
              id: 'review-queue',
              name: 'Review Queue',
              rendererId: 'review-plugin.review-queue',
              renderer: { kind: 'plugin-component', name: 'review-queue' },
              placement: { supportedRegions: ['secondary'] },
              modes: [{ id: 'default' }],
              [field]: field === 'contextRequirement' ? { project: true } : {},
              provenance: { origin: 'plugin', pluginId: 'review-plugin' },
              lifecycle: { stage: 'stable' },
            },
          ],
        }),
      );
      await expect(readPluginManifestFile(manifestPath)).rejects.toThrow(
        new RegExp(`${field}.*modes`),
      );
    },
  );

  test.each([
    [{ version: '2.0' }, 'is invalid'],
    [
      {
        version: '1.0',
        id: 'review-queue',
        name: 'Review Queue',
        rendererId: 'review-plugin.review-queue',
        renderer: { kind: 'plugin-component', name: 'review-queue' },
        placement: { supportedRegions: ['secondary'] },
        modes: [{ id: 'default' }],
        provenance: { origin: 'plugin', pluginId: 'impostor' },
        lifecycle: { stage: 'stable' },
      },
      'provenance must name plugin',
    ],
  ])(
    'fails closed for malformed or misattributed pane %#',
    async (pane, error) => {
      const manifestPath = join(dir, 'plugin.json');
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: 'review-plugin',
          version: '1.0.0',
          workspacePanes: [pane],
        }),
      );
      await expect(readPluginManifestFile(manifestPath)).rejects.toThrow(error);
    },
  );

  test('rejects duplicate direct Pane ids and mixed legacy/direct manifests', async () => {
    const manifestPath = join(dir, 'plugin.json');
    const pane = {
      version: '1.0',
      id: 'review-queue',
      name: 'Review Queue',
      rendererId: 'review-plugin.review-queue',
      renderer: { kind: 'plugin-component', name: 'review-queue' },
      placement: { supportedRegions: ['secondary'] },
      modes: [{ id: 'default' }],
      provenance: { origin: 'plugin', pluginId: 'review-plugin' },
      lifecycle: { stage: 'stable' },
    };
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'review-plugin',
        version: '1.0.0',
        workspacePanes: [pane, pane],
      }),
    );
    await expect(readPluginManifestFile(manifestPath)).rejects.toThrow(
      "duplicate id 'review-queue'",
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'review-plugin',
        version: '1.0.0',
        layout: { slug: 'review', source: 'layout.json' },
        workspacePanes: [pane],
      }),
    );
    await expect(readPluginManifestFile(manifestPath)).rejects.toThrow(
      'cannot be combined with legacy layout declarations',
    );
  });

  test('normalizes strict operational event subscription declarations', async () => {
    const manifestPath = join(dir, 'plugin.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'review-plugin',
        version: '1.0.0',
        serverModule: 'server.mjs',
        operationalEventSubscriptions: [
          {
            id: 'runtime-ready',
            version: '1.0.0',
            eventTypes: ['station.runtime.lifecycle/v1'],
            requiredScopes: [{ kind: 'project', projectId: 'project-1' }],
          },
        ],
      }),
    );

    await expect(readPluginManifestFile(manifestPath)).resolves.toMatchObject({
      operationalEventSubscriptions: [
        {
          id: 'runtime-ready',
          projection: 'metadata',
          requiredScopes: [{ kind: 'project', projectId: 'project-1' }],
        },
      ],
    });
  });

  test.each([
    [
      { id: 'runtime-ready', version: '1.0.0', eventTypes: [] },
      'eventTypes is invalid',
    ],
    [
      {
        id: 'runtime-ready',
        version: '1.0.0',
        eventTypes: ['station.runtime.lifecycle/v1'],
        requiredScopes: [{ kind: 'project', projectId: '../outside' }],
      },
      'requiredScopes is invalid',
    ],
    [
      {
        id: 'runtime-ready',
        version: '1.0.0',
        eventTypes: ['station.runtime.lifecycle/v1'],
        projection: 'raw',
      },
      'projection is invalid',
    ],
  ])(
    'rejects malformed operational event subscription %#',
    async (subscription, error) => {
      const manifestPath = join(dir, 'plugin.json');
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: 'review-plugin',
          version: '1.0.0',
          serverModule: 'server.mjs',
          operationalEventSubscriptions: [subscription],
        }),
      );
      await expect(readPluginManifestFile(manifestPath)).rejects.toThrow(error);
    },
  );

  test('requires one server module and unique subscription identities', async () => {
    const manifestPath = join(dir, 'plugin.json');
    const subscription = {
      id: 'runtime-ready',
      version: '1.0.0',
      eventTypes: ['station.runtime.lifecycle/v1'],
    };
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'review-plugin',
        version: '1.0.0',
        operationalEventSubscriptions: [subscription],
      }),
    );
    await expect(readPluginManifestFile(manifestPath)).rejects.toThrow(
      'require a serverModule',
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'review-plugin',
        version: '1.0.0',
        serverModule: 'server.mjs',
        operationalEventSubscriptions: [subscription, subscription],
      }),
    );
    await expect(readPluginManifestFile(manifestPath)).rejects.toThrow(
      "duplicate id 'runtime-ready'",
    );
  });
});
