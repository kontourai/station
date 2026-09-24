import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import {
  createStationTempDir,
  listStationTempEntries,
  removeStationTempDir,
} from '@kontourai/station-shared/temp-dir';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../../infra/process-utils.js';
import {
  type PionAdapterDependencies,
  type PionApplicationAdapterInput,
  pionProcessEnvironment,
  startPionApplicationAdapter,
  validatePionAdapterProfile,
} from '../pion-application-adapter.js';

const retained = new Set<string>();
afterEach(() => {
  for (const path of retained) rmSync(path, { recursive: true, force: true });
  retained.clear();
});
const input = (
  override: Partial<PionApplicationAdapterInput> = {},
): PionApplicationAdapterInput => ({
  executable: process.execPath,
  profile: 'diagnosticEcho',
  offer: { type: 'offer', sdp: 'offer' },
  certificatePem: 'certificate',
  privateKeyPem: 'key',
  turn: { url: 'turn:127.0.0.1:1', username: 'user', password: 'password' },
  accept: () => {},
  signal: new AbortController().signal,
  maxLifetimeMs: 30_000,
  ...override,
});
const base: PionAdapterDependencies = {
  createTemp: createStationTempDir,
  removeTemp: removeStationTempDir,
  spawn: spawnOwnedChild,
  terminate: terminateProcessTree,
  write: writeFileSync,
  now: Date.now,
};
function child(directory: string, application = false) {
  const value = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdio: unknown[];
    pid?: number;
    kill: () => boolean;
  };
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.stdio = application
    ? [null, value.stdout, value.stderr, new PassThrough(), new PassThrough()]
    : [null, value.stdout, value.stderr];
  value.kill = () => true;
  queueMicrotask(() => {
    writeFileSync(
      `${directory}/answer.json`,
      JSON.stringify({ type: 'answer', sdp: 'answer' }),
      { mode: 0o600 },
    );
    writeFileSync(
      `${directory}/version.json`,
      JSON.stringify({ pion: 'v4.2.20', go: 'go1.26.7' }),
      { mode: 0o600 },
    );
  });
  return value as unknown as ChildProcess;
}

describe('production Pion application adapter ownership', () => {
  test('startup cancellation preserves the caller reason after confirmed cleanup', async () => {
    const caller = new AbortController();
    const reason = new Error('caller retired admission');
    let directory = '';
    const released = vi.fn();
    const dependencies = {
      ...base,
      createTemp: async (label: string) => {
        directory = await createStationTempDir(label);
        retained.add(directory);
        return directory;
      },
      spawn: ((_command: string, _args: string[], options: { cwd: string }) => {
        const proc = child(options.cwd);
        queueMicrotask(() => caller.abort(reason));
        return { proc, release: released };
      }) as typeof spawnOwnedChild,
      terminate: vi.fn(async () => {}),
    };
    await expect(
      startPionApplicationAdapter(
        input({ signal: caller.signal }),
        dependencies,
      ),
    ).rejects.toBe(reason);
    expect(released).toHaveBeenCalledOnce();
    expect(existsSync(directory)).toBe(false);
  });

  test('startup cancellation retains an actual cleanup failure', async () => {
    const caller = new AbortController();
    const reason = new Error('caller retired admission');
    const cleanup = new Error('termination unconfirmed');
    const released = vi.fn();
    const dependencies = {
      ...base,
      createTemp: async (label: string) => {
        const directory = await createStationTempDir(label);
        retained.add(directory);
        return directory;
      },
      spawn: ((_command: string, _args: string[], options: { cwd: string }) => {
        const proc = child(options.cwd);
        queueMicrotask(() => caller.abort(reason));
        return { proc, release: released };
      }) as typeof spawnOwnedChild,
      terminate: vi.fn(async () => {
        throw cleanup;
      }),
    };
    await expect(
      startPionApplicationAdapter(
        input({ signal: caller.signal }),
        dependencies,
      ),
    ).rejects.toMatchObject({ errors: [reason, cleanup] });
    expect(released).not.toHaveBeenCalled();
  });

  test('child environment omits Station, account, provider and model secrets', () => {
    expect(
      pionProcessEnvironment({
        TMPDIR: '/tmp',
        LANG: 'C',
        STATION_OPERATOR_CREDENTIAL: 'canary',
        OPENAI_API_KEY: 'canary',
        ANTHROPIC_API_KEY: 'canary',
        HOME: '/private',
      }),
    ).toEqual({ TMPDIR: '/tmp', LANG: 'C' });
  });
  test('profiles and lifetime fail closed', () => {
    expect(() => validatePionAdapterProfile(undefined, undefined)).toThrow(
      'pion_profile_required',
    );
    expect(() => validatePionAdapterProfile('application', undefined)).toThrow(
      'pion_application_label_required',
    );
    expect(() =>
      validatePionAdapterProfile('diagnosticEcho', 'application'),
    ).toThrow('pion_diagnostic_profile_invalid');
  });
  test('untrusted executable is refused before temp allocation', async () => {
    const before = await listStationTempEntries('pion-application');
    await expect(
      startPionApplicationAdapter(input({ executable: 'relative' })),
    ).rejects.toThrow('pion_executable_invalid');
    expect(await listStationTempEntries('pion-application')).toEqual(before);
  });
  test.each(['write', 'spawn'] as const)(
    '%s failure removes allocated custody',
    async (fault) => {
      const removed = vi.fn(async (path: string) => removeStationTempDir(path));
      const dependencies = {
        ...base,
        removeTemp: removed,
        write:
          fault === 'write'
            ? ((() => {
                throw new Error('write failed');
              }) as typeof writeFileSync)
            : writeFileSync,
        spawn:
          fault === 'spawn'
            ? ((() => {
                throw new Error('spawn failed');
              }) as typeof spawnOwnedChild)
            : spawnOwnedChild,
      };
      await expect(
        startPionApplicationAdapter(input(), dependencies),
      ).rejects.toThrow(`${fault} failed`);
      expect(removed).toHaveBeenCalled();
    },
  );
  test('abort after allocation removes custody before launch', async () => {
    const controller = new AbortController();
    const spawn = vi.fn();
    const dependencies = {
      ...base,
      createTemp: async (label: string) => {
        const path = await createStationTempDir(label);
        controller.abort(new Error('stopped'));
        return path;
      },
      spawn,
    };
    await expect(
      startPionApplicationAdapter(
        input({ signal: controller.signal }),
        dependencies,
      ),
    ).rejects.toThrow('stopped');
    expect(spawn).not.toHaveBeenCalled();
  });
  test('abort before allocation never acquires custody', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    const createTemp = vi.fn();
    await expect(
      startPionApplicationAdapter(input({ signal: controller.signal }), {
        ...base,
        createTemp,
      }),
    ).rejects.toThrow('stopped');
    expect(createTemp).not.toHaveBeenCalled();
  });
  test('missing pipes and early exit converge on joined cleanup', async () => {
    for (const mode of ['pipes', 'exit'] as const) {
      const release = vi.fn();
      const terminate = vi.fn(async () => {});
      const dependencies = {
        ...base,
        spawn: ((_command: string, _args: string[], options: any) => {
          const proc = child(options.cwd, true);
          if (mode === 'pipes')
            Object.defineProperty(proc, 'stdio', { value: [] });
          else queueMicrotask(() => proc.emit('exit', 1, null));
          return { proc, release };
        }) as typeof spawnOwnedChild,
        terminate,
      };
      await expect(
        startPionApplicationAdapter(
          input({
            profile: 'application',
            applicationChannelLabel: 'station-app',
          }),
          dependencies,
        ),
      ).rejects.toThrow();
      expect(terminate).toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
    }
  });
  test('concurrent close shares shutdown and teardown failure retains authority', async () => {
    let directory = '';
    const release = vi.fn();
    const terminate = vi.fn(async () => {});
    const dependencies = {
      ...base,
      createTemp: async (label: string) => {
        directory = await createStationTempDir(label);
        retained.add(directory);
        return directory;
      },
      spawn: ((_c: string, _a: string[], options: any) => ({
        proc: child(options.cwd),
        release,
      })) as typeof spawnOwnedChild,
      terminate,
    };
    const adapter = await startPionApplicationAdapter(input(), dependencies);
    const first = adapter.close();
    const second = adapter.close();
    expect(first).toBe(second);
    await first;
    expect(terminate).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(existsSync(directory)).toBe(false);
    retained.delete(directory);
    const bad = {
      ...dependencies,
      terminate: vi.fn(async () => {
        throw new Error('unconfirmed');
      }),
    };
    const retainedAdapter = await startPionApplicationAdapter(input(), bad);
    await expect(retainedAdapter.close()).rejects.toThrow('unconfirmed');
    expect(release).toHaveBeenCalledOnce();
  });
  test('diagnostic echo exposes only bounded, validated message receipts', async () => {
    let directory = '';
    const dependencies = {
      ...base,
      createTemp: async (label: string) => {
        directory = await createStationTempDir(label);
        return directory;
      },
      spawn: ((_c: string, _a: string[], options: any) => ({
        proc: child(options.cwd),
        release: vi.fn(),
      })) as typeof spawnOwnedChild,
    };
    const adapter = await startPionApplicationAdapter(input(), dependencies);
    expect(adapter.readMessages()).toEqual([]);
    writeFileSync(
      `${directory}/messages.json`,
      JSON.stringify({ messages: ['echo'], local: 'relay', remote: 'relay' }),
      { mode: 0o600 },
    );
    expect(adapter.readMessages()).toEqual(['echo']);
    writeFileSync(
      `${directory}/messages.json`,
      JSON.stringify({
        messages: ['echo'],
        local: 'relay',
        remote: 'relay',
        secret: 'no',
      }),
      { mode: 0o600 },
    );
    expect(() => adapter.readMessages()).toThrow(
      'pion_diagnostic_messages_invalid',
    );
    await adapter.close();
  });
  test('configured deadline owns shutdown and missing-directory verification retains registry authority', async () => {
    let directory = '';
    const release = vi.fn();
    const dependencies = {
      ...base,
      createTemp: async (label: string) => {
        directory = await createStationTempDir(label);
        retained.add(directory);
        return directory;
      },
      spawn: ((_c: string, _a: string[], options: any) => ({
        proc: child(options.cwd),
        release,
      })) as typeof spawnOwnedChild,
    };
    const adapter = await startPionApplicationAdapter(
      input({ maxLifetimeMs: 1_000 }),
      dependencies,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await expect(adapter.close()).rejects.toThrow(
      'pion_application_lifetime_expired',
    );
    const retainedRelease = vi.fn();
    const noRemove = {
      ...dependencies,
      removeTemp: async () => {},
      spawn: ((_c: string, _a: string[], options: any) => ({
        proc: child(options.cwd),
        release: retainedRelease,
      })) as typeof spawnOwnedChild,
    };
    const second = await startPionApplicationAdapter(input(), noRemove);
    await expect(second.close()).rejects.toThrow(
      'pion_temp_cleanup_incomplete',
    );
    expect(retainedRelease).not.toHaveBeenCalled();
  });
});
