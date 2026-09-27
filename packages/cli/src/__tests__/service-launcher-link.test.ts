import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readInstanceRegistry,
  upsertInstance,
} from '@kontourai/station-shared/instance-registry';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  createServiceLauncherLink,
  readServiceLauncherContext,
  SERVICE_LAUNCHER_ENV,
  type ServiceLauncherContext,
  serviceUpdatePaths,
  writeServiceUpdateRequest,
} from '../commands/service-launcher-link.js';
import {
  handOffServiceLivenessToLauncher,
  publishServiceLivenessRecord,
} from '../commands/service-liveness.js';
import { superviseService } from '../commands/service-run.js';

const makeTempDir = trackTempDirs();

function linkHarness(
  role: 'active' | 'trial',
  stage = vi.fn(async () => '1.1.0'),
) {
  const installRoot = makeTempDir('station-link-');
  const context: ServiceLauncherContext = {
    protocol: 1,
    installRoot,
    version: '1.0.0',
    role,
    ...(role === 'trial' ? { updateId: 'u-1' } : {}),
  };
  const sent: unknown[] = [];
  let deliver: (message: unknown) => void = () => undefined;
  let disconnect: () => void = () => undefined;
  const handOffLiveness = vi.fn();
  const gone = vi.fn();
  const link = createServiceLauncherLink(
    {
      context,
      send: (message) => sent.push(message),
      onMessage: (listener) => {
        deliver = listener;
      },
      onDisconnect: (listener) => {
        disconnect = listener;
      },
      handOffLiveness,
      stage,
      log: () => undefined,
    },
    gone,
  );
  const result = () => {
    try {
      return JSON.parse(
        readFileSync(serviceUpdatePaths(installRoot).result, 'utf8'),
      );
    } catch {
      return undefined;
    }
  };
  return {
    installRoot,
    link,
    sent,
    deliver: (message: unknown) => deliver(message),
    disconnect: () => disconnect(),
    handOffLiveness,
    gone,
    stage,
    result,
  };
}

describe('the versioned child of the service launcher (#2675 D)', () => {
  test('reads only a well-formed launcher context', () => {
    expect(readServiceLauncherContext({})).toBeNull();
    expect(
      readServiceLauncherContext({ [SERVICE_LAUNCHER_ENV]: '{"protocol":2}' }),
    ).toBeNull();
    expect(
      readServiceLauncherContext({
        [SERVICE_LAUNCHER_ENV]: JSON.stringify({
          protocol: 1,
          installRoot: '/i',
          version: '1.0.0',
          role: 'active',
        }),
      }),
    ).toMatchObject({ role: 'active', version: '1.0.0' });
  });

  test('an active child stages a queued request once and asks the launcher for a trial', async () => {
    const harness = linkHarness('active');
    const request = writeServiceUpdateRequest(harness.installRoot);
    // A second request while one is queued is refused.
    expect(() => writeServiceUpdateRequest(harness.installRoot)).toThrow(
      /already requested/,
    );
    harness.link.tick();
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.sent).toEqual([
        {
          type: 'request-update',
          targetVersion: '1.1.0',
          requestId: request.id,
        },
      ]),
    );
    expect(harness.stage).toHaveBeenCalledTimes(1);
    expect(existsSync(serviceUpdatePaths(harness.installRoot).request)).toBe(
      false,
    );

    // Accepted: the liveness entry goes to the launcher before the child is
    // stopped, and the launcher is told so.
    harness.deliver({
      type: 'update-accepted',
      updateId: 'u-9',
      launcherPid: 4242,
    });
    expect(harness.handOffLiveness).toHaveBeenCalledWith(4242);
    expect(harness.sent.at(-1)).toEqual({
      type: 'handoff-ready',
      updateId: 'u-9',
    });
    expect(existsSync(serviceUpdatePaths(harness.installRoot).processing)).toBe(
      false,
    );
  });

  test('records a rejected or failed request where the server reads it', async () => {
    const rejected = linkHarness('active');
    const first = writeServiceUpdateRequest(rejected.installRoot);
    rejected.link.tick();
    await vi.waitFor(() => expect(rejected.sent).toHaveLength(1));
    rejected.deliver({ type: 'update-rejected', reason: 'no' });
    expect(rejected.result()).toMatchObject({
      requestId: first.id,
      status: 'rejected',
      reason: 'no',
    });

    const failed = linkHarness(
      'active',
      vi.fn(async () => {
        throw new Error('manifest signature is invalid');
      }),
    );
    const second = writeServiceUpdateRequest(failed.installRoot);
    failed.link.tick();
    await vi.waitFor(() =>
      expect(failed.result()).toMatchObject({
        requestId: second.id,
        status: 'failed',
        reason: 'manifest signature is invalid',
      }),
    );
    expect(failed.sent).toEqual([]);
    // A later request is picked up again.
    writeServiceUpdateRequest(failed.installRoot);
  });

  test('a version already staged is requested without staging it again', async () => {
    const harness = linkHarness('active');
    const staged = join(harness.installRoot, 'versions', '1.2.0');
    mkdirSync(join(staged, 'bin'), { recursive: true });
    writeFileSync(join(staged, 'bin', 'station.mjs'), '');
    writeFileSync(join(staged, '.station-install-complete'), 'abc\n');
    writeServiceUpdateRequest(harness.installRoot, '1.2.0');
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.sent).toMatchObject([
        { type: 'request-update', targetVersion: '1.2.0' },
      ]),
    );
    expect(harness.stage).not.toHaveBeenCalled();
  });

  test('a trial reports prepared, never picks up requests, and stops when the launcher is gone', () => {
    const harness = linkHarness('trial');
    writeServiceUpdateRequest(harness.installRoot);
    harness.link.tick();
    expect(harness.stage).not.toHaveBeenCalled();
    harness.link.onReady();
    expect(harness.sent).toEqual([{ type: 'prepared', updateId: 'u-1' }]);
    harness.disconnect();
    expect(harness.gone).toHaveBeenCalledTimes(1);
  });

  test('hands the liveness entry to the launcher only while this supervisor owns it', () => {
    const home = makeTempDir('station-link-home-');
    upsertInstance(
      'svc',
      {
        port: 3242,
        type: 'service',
        env: { ALLOWED_ORIGINS: 'https://paired.example' },
      },
      home,
    );
    const target = {
      instanceName: 'svc',
      home,
      serverPort: 3242,
      uiPort: 5274,
    };
    // Not published by this process: left alone.
    handOffServiceLivenessToLauncher(target, process.ppid);
    expect(readInstanceRegistry(home).instances.svc.pid).toBeUndefined();

    publishServiceLivenessRecord(target, true);
    handOffServiceLivenessToLauncher(target, process.ppid);
    const entry = readInstanceRegistry(home).instances.svc;
    expect(entry.pid).toBe(process.ppid);
    expect(entry.status).toBe('running');
    expect(entry.env).toEqual({ ALLOWED_ORIGINS: 'https://paired.example' });
    // The retiring supervisor's retract no longer clears it.
    publishServiceLivenessRecord(target, false);
    expect(readInstanceRegistry(home).instances.svc.pid).toBe(process.ppid);
  });

  test('the supervisor reports prepared only after readiness and checks for requests each tick', async () => {
    const order: string[] = [];
    const link = {
      context: {} as ServiceLauncherContext,
      onReady: vi.fn(() => order.push('ready')),
      tick: vi.fn(() => order.push('tick')),
    };
    const ticks: Array<() => void> = [];
    await superviseService(
      {
        baseDir: makeTempDir('station-link-supervisor-'),
        homeSource: '--base',
        host: '127.0.0.1',
        instanceName: 'svc',
        serverPort: 3242,
        uiPort: 5274,
      },
      {
        collect: vi.fn().mockResolvedValue({
          bootId: 'b',
          found: true,
          healthy: true,
          instanceId: 'svc',
          sha: 'abc',
          server: { listening: true, pid: 1, probe: 'ok', reachable: true },
          ui: { listening: true, pid: 2, probe: 'ok', reachable: true },
        }) as never,
        desktopCompanion: { check: vi.fn() },
        exit: vi.fn(),
        launcherLink: link,
        listListeningPids: () => [],
        onSignal: vi.fn(),
        processIsAlive: () => true,
        publishServiceLiveness: vi.fn((live: boolean) => {
          if (live) order.push('published');
        }),
        setTimer: vi.fn((callback: () => void) => {
          ticks.push(callback);
          return 1 as never;
        }),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      },
    );
    expect(order).toEqual(['published', 'ready', 'tick']);
    ticks.shift()?.();
    await vi.waitFor(() => expect(link.tick).toHaveBeenCalledTimes(2));
  });
});
