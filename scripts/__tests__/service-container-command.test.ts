import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  claimHostOwner,
  readInstanceRegistry,
} from '@kontourai/station-shared/instance-registry';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { describe, expect, test } from 'vitest';
import { stop } from '../../packages/cli/src/commands/lifecycle.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { checkContainerHealth } from '../container-healthcheck.mjs';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../lib/owned-process.mjs';

// Run after ./station build --instance=container with
// STATION_CONTAINER_COMMAND_TEST=1 npm run test:focused -- <this file>.
// The explicit opt-in owns real server/UI listeners and existing container build
// output; missing builds fail rather than being counted as runtime evidence.
const enabled = process.env.STATION_CONTAINER_COMMAND_TEST === '1';
const makeTempDir = trackTempDirs();

async function listen(port: number): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function isolatedPorts(): Promise<{ port: number; uiPort: number }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const held: Server[] = [];
    try {
      const api = await listen(0);
      held.push(api);
      const address = api.address();
      if (!address || typeof address === 'string')
        throw new Error('no API port');
      if (address.port > 65532) continue;
      for (let offset = 1; offset <= 3; offset++) {
        held.push(await listen(address.port + offset));
      }
      const ui = await listen(0);
      held.push(ui);
      const uiAddress = ui.address();
      if (!uiAddress || typeof uiAddress === 'string')
        throw new Error('no UI port');
      return { port: address.port, uiPort: uiAddress.port };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    } finally {
      await Promise.all(
        held.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
    }
  }
  throw new Error('could not reserve an isolated five-port set');
}

async function runContainerCommand(heldBySidecar: boolean): Promise<void> {
  const root = process.cwd();
  const stationRoot = makeTempDir(
    relative(tmpdir(), join(root, '.station', 'container-command-')),
  );
  const home = join(stationRoot, 'instances', 'stable');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const { port, uiPort } = await isolatedPorts();
  expect(
    existsSync(join(root, 'dist-server-container', 'command-station.js')),
    'build container server first',
  ).toBe(true);
  expect(
    existsSync(join(root, 'dist-ui-container', 'index.html')),
    'build container UI first',
  ).toBe(true);
  const expectedSha = JSON.parse(
    readFileSync(
      join(root, 'dist-server-container', 'station-build.json'),
      'utf8',
    ),
  ).sha;
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const command: string[] = JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)![1]);
  const [executable, ...args] = command.map((arg) =>
    arg === '--base=/data/station'
      ? `--base=${home}`
      : arg === '--port=3141'
        ? `--port=${port}`
        : arg === '--ui-port=3000'
          ? `--ui-port=${uiPort}`
          : arg,
  );
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    STATION_HOME: home,
    STATION_ROOT: stationRoot,
    STATION_IMAGE_SHA: expectedSha,
    ALLOWED_ORIGINS: `http://127.0.0.1:${uiPort}`,
  };
  let sidecar: ReturnType<typeof spawn> | undefined;
  let execution: ReturnType<typeof executeOwnedProcess> | undefined;
  let output = '';
  try {
    expect(readInstanceRegistry(home).instances).toEqual({});
    if (heldBySidecar) {
      // Desktop prepares the home schema before taking its host claim.
      ensureStationHomeSchemaSync(home);
      sidecar = spawn(
        process.execPath,
        ['-e', "console.log('resident'); setInterval(() => {}, 1000)"],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await once(sidecar.stdout!, 'data');
      const birth = lookupProcessBirthFingerprint(sidecar.pid!);
      expect(birth, 'live holder needs a birth fingerprint').toBeTruthy();
      expect(
        claimHostOwner('desktop-holder', {
          home,
          type: 'sidecar',
          ownerPids: [sidecar.pid!],
          publish: () => ({
            port,
            type: 'sidecar',
            status: 'starting',
            pid: sidecar!.pid!,
            birth: birth!,
          }),
        }).won,
      ).toBe(true);
    }
    console.log(
      `container-command launch: ${executable} ${args.join(' ')} NODE_ENV=production STATION_HOME=${home} STATION_IMAGE_SHA=${expectedSha}`,
    );
    execution = executeOwnedProcess(
      executable,
      args,
      undefined,
      'container command',
      {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const supervisor = execution.child;
    supervisor.stdout!.on('data', (chunk: Buffer) => {
      output = (output + chunk).slice(-32768);
    });
    supervisor.stderr!.on('data', (chunk: Buffer) => {
      output = (output + chunk).slice(-32768);
    });
    supervisor.on('error', (error: Error) => {
      output += String(error);
    });
    if (heldBySidecar) {
      // An exit-on-refusal regression must fail as an exit, not a readiness timeout.
      await expect
        .poll(
          () => ({
            refused: output.includes('cannot own Station home'),
            exit: supervisor.exitCode,
            signal: supervisor.signalCode,
          }),
          { timeout: 30_000 },
        )
        .toEqual({ refused: true, exit: null, signal: null });
      await new Promise((resolve) => setTimeout(resolve, 6000));
      expect(supervisor.exitCode, output).toBeNull();
      expect(supervisor.signalCode, output).toBeNull();
      expect(
        readInstanceRegistry(home).instances.container,
        'Station must not start while held',
      ).toBeUndefined();
      await expect(
        fetch(`http://127.0.0.1:${uiPort}/__station/identity`, {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow();
      const exited = once(sidecar!, 'exit');
      sidecar!.kill();
      await exited;
    }
    const readyDeadline = Date.now() + 180_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      expect(
        supervisor.exitCode,
        `supervisor exited before readiness: ${output}`,
      ).toBeNull();
      expect(
        supervisor.signalCode,
        `supervisor exited before readiness: ${output}`,
      ).toBeNull();
      try {
        await checkContainerHealth({
          baseUrl: `http://127.0.0.1:${uiPort}`,
          expectedSha,
        });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    expect(ready, `container command did not become ready: ${output}`).toBe(
      true,
    );
    await expect
      .poll(() => readInstanceRegistry(home).instances.container?.status, {
        timeout: 10_000,
      })
      .toBe('running');
    const owner = readInstanceRegistry(home).instances.container;
    expect(owner).toMatchObject({
      type: 'service',
      status: 'running',
      port,
      uiPort,
    });
    expect(owner.pid).toEqual(expect.any(Number));
    expect(owner.birth).toBe(lookupProcessBirthFingerprint(owner.pid!));
    expect(
      claimHostOwner('concurrent-desktop', {
        home,
        type: 'sidecar',
        ownerPids: [process.pid],
        publish: () => null,
      }),
    ).toMatchObject({
      won: false,
      reason: 'host-owned',
      owners: [{ id: 'container', type: 'service', pid: owner.pid }],
    });
    console.log(
      `container-command ready: home=${home} api=${port} ui=${uiPort} owner=${owner.pid} sha=${expectedSha}; held=${heldBySidecar}`,
    );
  } finally {
    if (sidecar && sidecar.exitCode === null && sidecar.signalCode === null) {
      const exited = once(sidecar, 'exit');
      sidecar.kill();
      await exited;
    }
    if (execution) {
      const owner = readInstanceRegistry(home).instances.container;
      if (
        owner?.pid &&
        owner.birth === lookupProcessBirthFingerprint(owner.pid)
      ) {
        process.kill(owner.pid, 'SIGTERM');
        await waitForSuiteSettlement(execution, 30_000);
      }
      const cleanup = await terminateSuiteExecution(execution, {
        processLabel: 'container command',
        terminationGraceMs: 30_000,
        terminationForceMs: 5000,
        waitForSuiteSettlement,
      });
      expect(
        cleanup,
        'supervisor and owned process group must settle',
      ).toMatchObject({ settled: true, errors: [] });
      // start() owns detached server/UI children outside the source launcher's
      // process group. Reap by their real lifecycle identities before deleting
      // the fixture home or allowing Vitest to retire its temporary lock root.
      await stop({ instanceName: 'container', stateHome: home });
      expect(
        claimHostOwner('post-shutdown-desktop', {
          home,
          type: 'sidecar',
          ownerPids: [process.pid],
          publish: () => null,
        }),
        'teardown must release the home for the next host owner',
      ).toMatchObject({ won: true });
    }
  }
}

describe.skipIf(!enabled)('Dockerfile service command (#2961)', () => {
  test.skipIf(process.env.STATION_CONTAINER_COMMAND_CASE === 'held')(
    'fresh home without installed policy starts and becomes ready',
    () => runContainerCommand(false),
    240_000,
  );
  test.skipIf(process.env.STATION_CONTAINER_COMMAND_CASE === 'fresh')(
    'stays alive without Station while a live sidecar holds the home, then claims and starts',
    () => runContainerCommand(true),
    240_000,
  );
});
