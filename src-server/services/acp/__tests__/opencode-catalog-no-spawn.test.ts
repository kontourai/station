import { describe, expect, test, vi } from 'vitest';

const launched = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      launched.calls.push(`spawn:${String(args[0])}`);
      return actual.spawn(...args);
    },
    execFile: (...args: unknown[]) => {
      launched.calls.push(`execFile:${String(args[0])}`);
      return (actual.execFile as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { acpRuntimeCatalogStatus } from '../../connections/connection-service-helpers.js';
import {
  openCodeModelImageInput,
  refreshOpenCodeModelCapabilities,
} from '../opencode-model-capabilities.js';

describe('the catalog read is not on a spawn path', () => {
  const status = {
    id: 'opencode',
    handshakeObservedAt: '2026-10-01T00:00:00.000Z',
    configOptions: [
      { category: 'model', options: [{ value: 'a/b', name: 'B' }] },
    ],
  } as never;

  test('acpRuntimeCatalogStatus launches nothing, with an empty or a filled cache', async () => {
    acpRuntimeCatalogStatus(status);
    await refreshOpenCodeModelCapabilities(
      { id: 'opencode', name: 'OpenCode', command: 'opencode', enabled: true },
      {
        run: async () => ({
          ok: true,
          stdout:
            'a/b\n{\n  "capabilities": { "input": { "image": true } }\n}\n',
        }),
      },
    );
    expect(openCodeModelImageInput('opencode', 'a/b')).toBe(true);
    const models = acpRuntimeCatalogStatus(status).models;
    expect(models[0]?.capabilities?.imageInput).toBe(true);
    expect(launched.calls).toEqual([]);
  });

  test('control: the same instrumentation does see a real listing launch', async () => {
    const { runOpenCodeModelListing } = await import(
      '../opencode-model-capabilities.js'
    );
    await runOpenCodeModelListing(process.execPath, {
      argvPrefix: ['-e', 'process.exit(0)', '--'],
      resolveCommand: async (command) => command,
      env: async () => process.env,
    });
    expect(launched.calls.some((call) => call.startsWith('spawn:'))).toBe(true);
  });
});
