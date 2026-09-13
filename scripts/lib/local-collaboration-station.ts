import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PUBLIC_STATION_PROOF_PATH,
  STATION_PROOF_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { readEnvironmentSecurityRecord } from '@kontourai/station-shared/environment-security-record';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import {
  createStationProofNonce,
  verifyStationEnvironmentProof,
} from '../../packages/connect/src/core/environmentProof.js';
import {
  allocateFreePortBlock,
  reserveContiguousBlock,
} from '../../src-server/runtime/bootstrap/allocate-port-block.js';
import { restrictAccountLabTcp } from './local-collaboration-network.mjs';
import {
  localLabEnvironment,
  runLabCommand,
} from './local-collaboration-process.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './owned-process.mjs';
import { defaultCoordinatorRoot } from './verification-request-identity.mjs';

/** One account scenario owns its listener plan through stop/restart. */
export async function acquireAccountLabPorts() {
  const directory = join(defaultCoordinatorRoot(), 'fixture-locks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'account-lab.lock');
  const release = await acquireFileMutationLockAsync(path, {
    timeoutMs: 60000,
  });
  const owned = readFileSync(path);
  return async () => {
    await release();
    try {
      if (readFileSync(path).equals(owned))
        throw new Error('Account lab listener lease did not release');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}

interface StationInput {
  directory: string;
  name: string;
  hostname: '127.0.0.1' | 'localhost';
  allowedProbePort: number;
  blockedProbePort: number;
  probeNonce: string;
  port?: number;
}

/** Boots the real entrypoint; no replacement routes, users, grants or providers. */
export async function startAccountLabStation(
  input: StationInput,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let stopOnFailure: (() => Promise<void>) | undefined;
  try {
    signal.throwIfAborted();
    const sourceSha = (
      await runLabCommand(
        'git',
        ['rev-parse', 'HEAD'],
        resolve(import.meta.dirname, '../..'),
      )
    ).stdout.trim();
    assert.match(sourceSha, /^[a-f0-9]{40}$/);
    const port = input.port ?? (await allocateFreePortBlock('127.0.0.1'));
    if (input.port) {
      const held = await reserveContiguousBlock('127.0.0.1', port, 4);
      if (!held)
        throw new Error(
          'The lab Station restart ports are no longer available',
        );
      await Promise.all(
        held.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    }
    assert(
      ![3000, 3141].some((reserved) => reserved >= port && reserved < port + 4),
    );
    const base = `http://${input.hostname}:${port}`;
    const home = join(input.directory, 'home');
    const osHome = join(input.directory, 'os-home');
    const temp = join(input.directory, 'tmp');
    for (const path of [input.directory, home, osHome, temp])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    const bootId = randomUUID();
    const config = join(input.directory, `launch-${bootId}.json`);
    const dotenv = join(input.directory, `launch-${bootId}.env`);
    writeFileSync(dotenv, '', { mode: 0o600, flag: 'wx' });
    writeFileSync(
      config,
      JSON.stringify({
        port,
        allowedProbePort: input.allowedProbePort,
        blockedProbePort: input.blockedProbePort,
        probeNonce: input.probeNonce,
      }),
      { mode: 0o600, flag: 'wx' },
    );
    const execution = executeOwnedCommand(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve(import.meta.dirname, 'local-collaboration-station.ts'),
        '--account-station-child',
        config,
      ],
      spawn,
      'account lab Station',
      {
        cwd: resolve(import.meta.dirname, '../..'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...localLabEnvironment(),
          DOTENV_CONFIG_PATH: dotenv,
          TSX_TSCONFIG_PATH: resolve(
            import.meta.dirname,
            '../../tsconfig.json',
          ),
          HOME: osHome,
          USERPROFILE: osHome,
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
          XDG_CONFIG_HOME: join(osHome, 'config'),
          XDG_CACHE_HOME: join(osHome, 'cache'),
          STATION_HOME: home,
          STATION_ROOT: join(input.directory, 'station-root'),
          STATION_HOST: '127.0.0.1',
          PORT: String(port),
          STATION_INSTANCE: input.name,
          STATION_INSTANCE_ID: input.name,
          STATION_BOOT_ID: bootId,
          STATION_STDOUT_HANDSHAKE: '1',
          STATION_BUILD_SHA: sourceSha,
          STATION_SUPERVISOR_PID: String(process.pid),
          STATION_SUPERVISOR_BIRTH:
            lookupProcessBirthFingerprint(process.pid) ?? '',
          STATION_LOCAL_ACCOUNTS: '1',
          STATION_PROJECT_SHARING: '1',
          STATION_AUTHENTICATION_ORIGIN: base,
          ALLOWED_ORIGINS: base,
          STATION_LOG_LEVEL: 'error',
          OTEL_SDK_DISABLED: 'true',
          AWS_EC2_METADATA_DISABLED: 'true',
        },
      },
    );
    const stdout =
      'stdout' in execution.child ? execution.child.stdout : undefined;
    const capture = captureOwnedProcessOutput(execution, {
      maxBytes: 1024 * 1024,
    });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      const result = await terminateSuiteExecution(execution, {
        waitForSuiteSettlement,
        terminationGraceMs: 5000,
        terminationForceMs: 5000,
        processLabel: 'account lab Station',
      });
      const output = capture.finish();
      writeFileSync(
        join(input.directory, `process-${bootId}.log`),
        `${output.stdout.text}\n${output.stderr.text}`,
        { mode: 0o600 },
      );
      if (
        !result.settled ||
        result.errors.length ||
        output.truncated ||
        output.invalidUtf8
      )
        throw new Error(
          'Account lab Station cleanup or output did not satisfy its ownership contract',
        );
    };
    stopOnFailure = stop;
    await new Promise<void>((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              'Account lab Station readiness exceeded its liveness bound',
            ),
          ),
        60000,
      );
      const aborted = () =>
        finish(new Error('Account lab Station startup interrupted'));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        stdout?.off('data', data);
        if (error) reject(error);
        else resolve();
      };
      const data = (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        if (buffered.length > 1024 * 1024) {
          finish(new Error('Account lab readiness output exceeded its bound'));
          return;
        }
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('{"event":"listening",')) continue;
          try {
            const ready = JSON.parse(line);
            assert.deepEqual(ready, {
              event: 'listening',
              port,
              host: '127.0.0.1',
            });
            finish();
          } catch {
            finish(
              new Error('Account lab received incompatible Station readiness'),
            );
          }
        }
      };
      stdout?.on('data', data);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      void execution.completion.then(() =>
        finish(new Error('Account lab Station exited during startup')),
      );
    });
    const security = readEnvironmentSecurityRecord(
      join(home, 'security', 'environment.json'),
    );
    const nonce = createStationProofNonce();
    const proof = await fetch(`${base}${PUBLIC_STATION_PROOF_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
        nonce,
      }),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    assert.equal(proof.status, 200);
    assert.equal(
      await verifyStationEnvironmentProof({
        credential: security.credential,
        environmentId: security.environmentId,
        nonce,
        response: await proof.json(),
      }),
      true,
    );
    const response = await fetch(`${base}/api/system/identity`, {
      headers: { Authorization: `Bearer ${security.credential}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    assert.equal(response.status, 200);
    const identity = (await response.json()) as {
      bootId?: unknown;
      instanceId?: unknown;
      sha?: unknown;
      shaSource?: unknown;
    };
    assert.equal(identity.bootId, bootId);
    assert.equal(identity.instanceId, input.name);
    assert.equal(identity.sha, sourceSha);
    assert.equal(identity.shaSource, 'checkout');
    return {
      base,
      home,
      port,
      bootId,
      pid: execution.child.pid,
      stationId: security.environmentId,
      operator: {
        credential: security.credential,
        credentialOrigin: base,
        requireCredential: true,
        headers: { Origin: base },
        redirect: 'error' as const,
        timeoutMs: 15000,
        maxResponseBytes: 128 * 1024,
        signal,
      },
      stop,
    };
  } catch (error) {
    try {
      await stopOnFailure?.();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Account lab startup and cleanup failed',
      );
    }
    throw error;
  }
}

if (process.argv[2] === '--account-station-child') {
  const raw: unknown = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  assert(raw && typeof raw === 'object');
  const input = raw as {
    port: number;
    allowedProbePort: number;
    blockedProbePort: number;
    probeNonce: string;
  };
  for (const port of [
    input.port,
    input.allowedProbePort,
    input.blockedProbePort,
  ])
    assert(Number.isSafeInteger(port) && port > 1024 && port < 65533);
  assert(
    typeof input.probeNonce === 'string' &&
      /^[a-f0-9]{64}$/.test(input.probeNonce),
  );
  assert(input.blockedProbePort !== input.allowedProbePort);
  restrictAccountLabTcp([
    input.allowedProbePort,
    ...Array.from({ length: 4 }, (_, offset) => input.port + offset),
  ]);
  const allowed = await fetch(
    `http://127.0.0.1:${input.allowedProbePort}/probe`,
    { signal: AbortSignal.timeout(5000) },
  );
  assert.equal(await allowed.text(), input.probeNonce);
  await assert.rejects(
    fetch(`http://127.0.0.1:${input.blockedProbePort}/probe`, {
      signal: AbortSignal.timeout(5000),
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      'code' in error.cause &&
      error.cause.code === 'ACCOUNT_LAB_TCP_REFUSED',
  );
  const lifetime = setTimeout(
    () => process.kill(process.pid, 'SIGTERM'),
    300000,
  );
  lifetime.unref();
  await import('../../src-server/index.js');
}
