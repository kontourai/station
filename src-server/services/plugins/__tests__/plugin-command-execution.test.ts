import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION } from '@kontourai/station-contracts/plugin';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { pluginCommandGeneration } from '../plugin-command-contributions.js';
import { createPluginCommandExecutionAuthority } from '../plugin-command-execution.js';

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

function request(manifest: ReturnType<typeof fixture>['manifest']) {
  return {
    schemaVersion: PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION,
    requestId: 'request-a',
    pluginId: manifest.name,
    pluginVersion: manifest.version,
    commandGeneration: pluginCommandGeneration(manifest),
    commandId: 'demo-plugin.review',
    target: { kind: 'composer' as const, sessionId: 'session-a' },
  };
}

describe('plugin command execution authority', () => {
  test('persists a bounded actor/target receipt before admitting the UI effect', () => {
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
    });

    const outcome = authority.authorize(request(manifest), origin);

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

  test('refuses and audits a stale command generation', () => {
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
    });

    expect(
      authority.authorize(
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

  test('admits no effect when durable audit storage is unavailable', () => {
    const { pluginsDir, manifest } = fixture();
    const authority = createPluginCommandExecutionAuthority({
      pluginsDir,
      publisher: { append: () => ({ kind: 'unavailable' }) },
      grantedPermissions: () => ({ kind: 'available', permissions: [] }),
    });

    expect(authority.authorize(request(manifest), origin)).toEqual({
      kind: 'unavailable',
    });
  });
});
