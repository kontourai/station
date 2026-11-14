import { once } from 'node:events';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { expect, onTestFinished, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import * as voiceRoutes from '../../../routes/operations/voice.js';
import { HomeWriterOwner } from '../../../services/ssh/home-writer-owner.js';
import { allocateFreePortBlock } from '../allocate-port-block.js';
import type { RuntimePublicationParticipant } from '../runtime-publication-participant.js';
import { StationRuntime } from '../station-runtime.js';

const temp = trackTempDirs();

test.each(['shutdown', 'failed initialization', 'close failure'] as const)(
  'real runtime %s releases its voice port without closing an unrelated listener',
  async (scenario) => {
    const home = fs.realpathSync(temp('runtime-voice-owner-'));
    vi.stubEnv('STATION_HOME', home);
    vi.stubEnv('STATION_INSTANCE_ID', 'voice-owner-regression');
    vi.stubEnv('STATION_DISABLE_LOGIN_PATH_RESOLVE', '1');
    vi.stubEnv('PATH', '/bin:/usr/bin:/usr/sbin:/sbin');
    vi.stubEnv('DO_NOT_TRACK', '1');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    ensureStationHomeSchemaSync(home);
    const config = new ConfigLoader({ projectHomeDir: home });
    const existing = await config.loadAppConfig();
    await config.saveAppConfig({
      ...existing,
      defaultModel: '',
      defaultLLMProvider: '',
      lanDiscoveryEnabled: false,
      telemetryEnabled: false,
    });
    await config.dispose();
    const port = await allocateFreePortBlock('127.0.0.1');
    const unrelated = createServer();
    unrelated.listen(0, '127.0.0.1');
    await once(unrelated, 'listening');
    const originalAttach = voiceRoutes.attachVoiceWebSocket;
    let rejectKit: ((error: Error) => void) | undefined;
    const captured: { listener: ReturnType<typeof originalAttach> } = {
      listener: null,
    };
    let attached!: () => void;
    const attachment = new Promise<void>((resolve) => {
      attached = resolve;
    });
    const attach = vi
      .spyOn(voiceRoutes, 'attachVoiceWebSocket')
      .mockImplementation((...args) => {
        const listener = originalAttach(...args);
        if (args[0] === port + 2) {
          captured.listener = listener;
          if (scenario === 'failed initialization') {
            const actualKit = Reflect.get(
              runtime,
              'kitLifecycleReady',
            ) as Promise<unknown>;
            const fault = new Promise<never>((_resolve, reject) => {
              rejectKit = reject;
            });
            const joined = Promise.all([actualKit, fault]);
            void joined.catch(() => undefined);
            Reflect.set(runtime, 'kitLifecycleReady', joined);
          }
          attached();
        }
        return listener;
      });
    const runtime = new StationRuntime({
      projectHomeDir: home,
      port,
      host: '127.0.0.1',
      logLevel: 'error',
    });
    const rebound = createServer();
    let shutdown = false;
    try {
      const starting = runtime.initialize();
      await Promise.race([attachment, starting]);
      const listener = captured.listener;
      expect(
        listener,
        'real runtime must bind its voice listener',
      ).toBeTruthy();
      if (!listener) throw new Error('Voice listener missing');
      if (!listener.address()) await once(listener, 'listening');
      expect(listener.address()).toMatchObject({
        port: port + 2,
        address: '127.0.0.1',
      });
      if (rejectKit) {
        rejectKit(new Error('injected failure after voice bind'));
        await expect(starting).rejects.toThrow(
          'injected failure after voice bind',
        );
      } else {
        await starting;
      }
      if (scenario === 'close failure') {
        const fault = vi
          .spyOn(listener, 'close')
          .mockImplementationOnce((callback) => {
            callback?.(new Error('injected voice close failure'));
          });
        try {
          const failure = await runtime.shutdown().then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(inspect(failure, { depth: 8 })).toContain(
            'injected voice close failure',
          );
          expect(() => acquireStationHomeMaintenanceLease(home)).toThrow(
            StationHomeActiveError,
          );
        } finally {
          fault.mockRestore();
        }
        await runtime.shutdown();
        shutdown = true;
      } else if (scenario === 'shutdown') {
        await runtime.shutdown();
        shutdown = true;
      }
      await new Promise<void>((resolve, reject) => {
        rebound.once('error', reject);
        rebound.listen(port + 2, '127.0.0.1', resolve);
      });
      expect(rebound.listening).toBe(true);
      expect(unrelated.listening).toBe(true);
    } finally {
      if (!shutdown) await runtime.shutdown();
      if (captured.listener?.address())
        await new Promise<void>((resolve, reject) =>
          captured.listener!.close((error) =>
            error ? reject(error) : resolve(),
          ),
        );
      if (rebound.listening)
        await new Promise<void>((resolve, reject) =>
          rebound.close((error) => (error ? reject(error) : resolve())),
        );
      if (unrelated.listening)
        await new Promise<void>((resolve, reject) =>
          unrelated.close((error) => (error ? reject(error) : resolve())),
        );
      const runtimeLoader = Reflect.get(
        runtime,
        'configLoader',
      ) as ConfigLoader;
      await runtimeLoader.whenWatcherClosed();
      attach.mockRestore();
      vi.unstubAllEnvs();
    }
  },
  120_000,
);

test('real bootstrap holds home and storage until admitted publication completes', async () => {
  const home = temp('runtime-publication-real-');
  const runtime = new StationRuntime({ projectHomeDir: home });
  const participant = Reflect.get(
    runtime,
    'runtimePublicationParticipant',
  ) as RuntimePublicationParticipant;
  let resume!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const bodyDone = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const close = vi.spyOn(
    Reflect.get(runtime, 'orchestrationEventStore'),
    'close',
  );
  const path = join(home, 'publication.json');
  const publication = participant.run(async (lease) => {
    entered();
    await barrier;
    await publishJsonFileWithOwnedLock(
      path,
      { revision: 1 },
      {
        finalizeCommit: () => {
          lease.assertCurrent();
          return undefined;
        },
      },
    );
  });
  await bodyDone;
  const shutdown = runtime.shutdown();
  const repeatedShutdown = runtime.shutdown();
  expect(close).not.toHaveBeenCalled();
  expect(() => participant.acquire()).toThrow('publication');
  expect(() => acquireStationHomeMaintenanceLease(home)).toThrow(
    StationHomeActiveError,
  );
  resume();
  await publication;
  await Promise.all([shutdown, repeatedShutdown]);
  expect(close).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ revision: 1 });
  const maintenance = acquireStationHomeMaintenanceLease(home);
  maintenance.release();
}, 30_000);

test('shutdown retries an uncertain real home writer release before closing storage', async () => {
  const home = temp('runtime-publication-cleanup-real-');
  const runtime = new StationRuntime({ projectHomeDir: home });
  const participant = Reflect.get(
    runtime,
    'runtimePublicationParticipant',
  ) as RuntimePublicationParticipant;
  const close = vi.spyOn(
    Reflect.get(runtime, 'orchestrationEventStore'),
    'close',
  );
  const parent = participant.acquire();
  const writer = await HomeWriterOwner.forHome(home);
  const hold = await writer.acquire();
  let released = false;
  const cleanup = participant.retainCleanup(async () => {
    parent.assertReleasable();
    if (!released) {
      await hold.release();
      released = true;
    }
    parent.release();
  });
  const remove = fs.rmSync;
  const fault = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (String(path).includes('.home-writer.mutation.guard.stale-'))
      throw new Error('injected home release failure');
    return remove(path, options);
  });
  syncBuiltinESMExports();
  try {
    await expect(cleanup()).rejects.toThrow('injected home release failure');
    expect(close).not.toHaveBeenCalled();
    expect(() => acquireStationHomeMaintenanceLease(home)).toThrow(
      StationHomeActiveError,
    );
  } finally {
    fault.mockRestore();
    syncBuiltinESMExports();
  }
  await runtime.shutdown();
  expect(close).toHaveBeenCalledOnce();
  const maintenance = acquireStationHomeMaintenanceLease(home);
  maintenance.release();
}, 30_000);

test('unsettled publication leaves storage and home held until shutdown is retried', async () => {
  const home = temp('runtime-publication-pending-');
  const runtime = new StationRuntime({ projectHomeDir: home });
  const participant = Reflect.get(
    runtime,
    'runtimePublicationParticipant',
  ) as RuntimePublicationParticipant;
  const eventStore = Reflect.get(runtime, 'orchestrationEventStore');
  const close = vi.spyOn(eventStore, 'close');
  let resume!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const publication = participant.run(async () => {
    entered();
    await barrier;
  });
  await started;
  try {
    await expect(runtime.shutdown()).rejects.toMatchObject({
      code: 'runtime_publication_pending',
    });
    expect(close).not.toHaveBeenCalled();
    expect(() => acquireStationHomeMaintenanceLease(home)).toThrow(
      StationHomeActiveError,
    );
    expect(() => participant.acquire()).toThrow('publication');
  } finally {
    resume();
  }
  await publication;
  await runtime.shutdown();
  expect(close).toHaveBeenCalledOnce();
  const maintenance = acquireStationHomeMaintenanceLease(home);
  maintenance.release();
}, 30_000);
