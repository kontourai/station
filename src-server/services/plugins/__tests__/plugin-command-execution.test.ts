import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIENT_ORIGIN_VERSION,
  type ClientOrigin,
} from '@kontourai/station-contracts/client-origin';
import {
  type OperationalEventEnvelope,
  validateOperationalEventEnvelope,
} from '@kontourai/station-contracts/operational-event';
import {
  PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION,
  type PluginManifest,
} from '@kontourai/station-contracts/plugin';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { pluginCommandGeneration } from '../plugin-command-contributions.js';
import { createPluginCommandExecutionAuthority } from '../plugin-command-execution.js';
import { withPluginContentLock } from '../plugin-content-integrity.js';
import { readPluginManifestFileSync } from '../plugin-manifest-loader.js';

const roots: string[] = [];
const origin: ClientOrigin = {
  version: CLIENT_ORIGIN_VERSION,
  actor: { kind: 'device', deviceId: 'phone-a' },
  reported: {
    version: CLIENT_ORIGIN_VERSION,
    surface: 'mobile',
    build: '1.2.3',
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-command-execution-'));
  roots.push(root);
  const pluginsDir = join(root, 'plugins');
  const pluginDir = join(pluginsDir, 'demo-plugin');
  mkdirSync(pluginDir, { recursive: true });
  const manifest = {
    name: 'demo-plugin',
    version: '1.0.0',
    extensions: {
      'io.kontourai.station': {
        schemaVersion: '1.0' as const,
        commands: [
          {
            version: '1.0' as const,
            id: 'demo-plugin.review',
            title: 'Review work',
            intent: {
              kind: 'seed-composer' as const,
              text: 'Private prompt text must not enter the receipt.',
            },
          },
        ],
      },
    },
  };
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest));
  return { pluginsDir, manifest };
}

function request(
  manifest: Pick<PluginManifest, 'name' | 'version' | 'extensions'>,
) {
  return {
    schemaVersion: PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION,
    requestId: 'request-a',
    pluginId: manifest.name,
    pluginVersion: manifest.version,
    commandGeneration: pluginCommandGeneration(manifest),
    commandId: 'demo-plugin.review',
    target: { kind: 'composer' as const, sessionId: 'session-a' },
    context: {
      activeChatSessionId: 'session-a',
      sessionId: 'session-a',
    },
  };
}

describe('plugin command execution authority', () => {
  test('persists a bounded actor/target receipt before admitting the UI effect', async () => {
    const { pluginsDir, manifest } = fixture();
    const append = vi.fn((value: unknown) => ({
      kind: 'appended' as const,
      journalSequence: 1,
      event: value as OperationalEventEnvelope,
    }));
    const authority = createPluginCommandExecutionAuthority({
      pluginsDir,
      publisher: { append },
      grantedPermissions: () => ({ kind: 'available', permissions: [] }),
      resolveRequirement: () => ({ kind: 'available' }),
    });

    const outcome = await authority.authorize(request(manifest), origin);

    expect(outcome).toMatchObject({
      kind: 'authorized',
      receipt: {
        pluginId: 'demo-plugin',
        pluginVersion: '1.0.0',
        commandId: 'demo-plugin.review',
        actor: { kind: 'device', deviceId: 'phone-a' },
        reportedSurface: 'mobile',
        target: { kind: 'composer', sessionId: 'session-a' },
        decision: 'authorized',
        outcome: 'admitted',
      },
    });
    expect(append).toHaveBeenCalledOnce();
    const event = append.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      type: 'station.plugin-command.execution/v1',
      delivery: 'durable',
      scopes: [{ kind: 'plugin', pluginId: 'demo-plugin' }],
      payload: {
        data: {
          decision: 'authorized',
          outcome: 'admitted',
        },
      },
    });
    expect(validateOperationalEventEnvelope(event)).toMatchObject({ ok: true });
    expect(JSON.stringify(event)).not.toContain('Private prompt text');
  });

  test('refuses and audits a stale command generation', async () => {
    const { pluginsDir, manifest } = fixture();
    const append = vi.fn((value: unknown) => ({
      kind: 'appended' as const,
      journalSequence: 1,
      event: value as OperationalEventEnvelope,
    }));
    const authority = createPluginCommandExecutionAuthority({
      pluginsDir,
      publisher: { append },
      grantedPermissions: () => ({ kind: 'available', permissions: [] }),
      resolveRequirement: () => ({ kind: 'available' }),
    });

    expect(
      await authority.authorize(
        { ...request(manifest), commandGeneration: '0'.repeat(64) },
        origin,
      ),
    ).toEqual({ kind: 'refused', reason: 'command-generation-changed' });
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        data: {
          decision: 'refused',
          outcome: 'refused',
          reason: 'command-generation-changed',
        },
      },
    });
  });

  test('admits no effect when durable audit storage is unavailable', async () => {
    const { pluginsDir, manifest } = fixture();
    const authority = createPluginCommandExecutionAuthority({
      pluginsDir,
      publisher: { append: () => ({ kind: 'unavailable' }) },
      grantedPermissions: () => ({ kind: 'available', permissions: [] }),
      resolveRequirement: () => ({ kind: 'available' }),
    });

    expect(await authority.authorize(request(manifest), origin)).toEqual({
      kind: 'unavailable',
    });
  });

  test('accepts a bounded non-SemVer Agent Plugins version', async () => {
    const { pluginsDir, manifest } = fixture();
    manifest.version = 'release candidate 1';
    writeFileSync(
      join(pluginsDir, manifest.name, 'plugin.json'),
      JSON.stringify(manifest),
    );
    const installed = readPluginManifestFileSync(
      join(pluginsDir, manifest.name, 'plugin.json'),
    );
    const authority = createPluginCommandExecutionAuthority({
      pluginsDir,
      publisher: {
        append: (event) => ({
          kind: 'appended',
          journalSequence: 1,
          event: event as OperationalEventEnvelope,
        }),
      },
      grantedPermissions: () => ({ kind: 'available', permissions: [] }),
      resolveRequirement: () => ({ kind: 'available' }),
    });

    await expect(
      authority.authorize(request(installed), origin),
    ).resolves.toMatchObject({
      kind: 'authorized',
      receipt: { pluginVersion: 'release candidate 1' },
    });
  });

  test('refuses an unresolved host-context requirement before admission', async () => {
    const { pluginsDir, manifest } = fixture();
    manifest.extensions['io.kontourai.station'].commands[0] = {
      ...manifest.extensions['io.kontourai.station'].commands[0],
      requires: ['project'],
    };
    writeFileSync(
      join(pluginsDir, manifest.name, 'plugin.json'),
      JSON.stringify(manifest),
    );
    const installed = readPluginManifestFileSync(
      join(pluginsDir, manifest.name, 'plugin.json'),
    );
    const append = vi.fn((event: unknown) => ({
      kind: 'appended' as const,
      journalSequence: 1,
      event: event as OperationalEventEnvelope,
    }));
    const resolveRequirement = vi.fn(() => ({ kind: 'missing' as const }));
    const authority = createPluginCommandExecutionAuthority({
      pluginsDir,
      publisher: { append },
      grantedPermissions: () => ({ kind: 'available', permissions: [] }),
      resolveRequirement,
    });

    await expect(
      authority.authorize(request(installed), origin),
    ).resolves.toEqual({
      kind: 'refused',
      reason: 'requirement-not-satisfied',
    });
    expect(resolveRequirement).toHaveBeenCalledWith(
      expect.objectContaining({ requirement: 'project' }),
    );
    expect(append).toHaveBeenCalledOnce();
  });

  test('requires a declared server module as well as its grant', async () => {
    const { pluginsDir, manifest } = fixture();
    manifest.extensions['io.kontourai.station'].commands[0] = {
      ...manifest.extensions['io.kontourai.station'].commands[0],
      requires: ['plugin-server'],
    };
    writeFileSync(
      join(pluginsDir, manifest.name, 'plugin.json'),
      JSON.stringify(manifest),
    );
    const installed = readPluginManifestFileSync(
      join(pluginsDir, manifest.name, 'plugin.json'),
    );
    const authority = createPluginCommandExecutionAuthority({
      pluginsDir,
      publisher: {
        append: (event) => ({
          kind: 'appended',
          journalSequence: 1,
          event: event as OperationalEventEnvelope,
        }),
      },
      grantedPermissions: () => ({
        kind: 'available',
        permissions: ['plugin.server'],
      }),
      resolveRequirement: () => ({ kind: 'available' }),
    });

    await expect(
      authority.authorize(request(installed), origin),
    ).resolves.toEqual({
      kind: 'refused',
      reason: 'requirement-not-satisfied',
    });
  });

  test('waits for the lifecycle lock and observes a completed uninstall', async () => {
    const { pluginsDir, manifest } = fixture();
    let release!: () => void;
    const held = withPluginContentLock(pluginsDir, manifest.name, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const append = vi.fn((event: unknown) => ({
      kind: 'appended' as const,
      journalSequence: 1,
      event: event as OperationalEventEnvelope,
    }));
    const authority = createPluginCommandExecutionAuthority({
      pluginsDir,
      publisher: { append },
      grantedPermissions: () => ({ kind: 'available', permissions: [] }),
      resolveRequirement: () => ({ kind: 'available' }),
    });
    const outcome = authority.authorize(request(manifest), origin);
    await Promise.resolve();
    expect(append).not.toHaveBeenCalled();
    rmSync(join(pluginsDir, manifest.name), { recursive: true });
    release();
    await held;

    await expect(outcome).resolves.toEqual({
      kind: 'refused',
      reason: 'plugin-not-installed',
    });
  });

  test('does not follow a symlinked installed plugin directory', async () => {
    const { pluginsDir, manifest } = fixture();
    const external = mkdtempSync(join(tmpdir(), 'plugin-command-external-'));
    roots.push(external);
    writeFileSync(join(external, 'plugin.json'), JSON.stringify(manifest));
    rmSync(join(pluginsDir, manifest.name), { recursive: true });
    symlinkSync(external, join(pluginsDir, manifest.name), 'dir');
    const append = vi.fn();
    const authority = createPluginCommandExecutionAuthority({
      pluginsDir,
      publisher: { append },
      grantedPermissions: () => ({ kind: 'available', permissions: [] }),
      resolveRequirement: () => ({ kind: 'available' }),
    });

    await expect(
      authority.authorize(request(manifest), origin),
    ).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(append).not.toHaveBeenCalled();
  });
});
