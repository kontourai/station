import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import { acquireStationHomeMaintenanceLease } from '@kontourai/station-shared/station-home-lifecycle';
import { describe, expect, test, vi } from 'vitest';
import { createBrokerCredentialBundle } from '../../src-server/services/connections/self-hosted-broker-service.js';
import { localLabEnvironment } from '../lib/local-collaboration-process.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../lib/owned-process.mjs';
import { initializeConnectorIdentity } from '../self-hosted-connector-identity.js';

const origin = 'https://station-client.example';
const readyPrefix = '{"event":"listening",';

async function bounded<T>(
  promise: Promise<T>,
  label: string,
  ms = 90_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded liveness bound`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(refuse: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'station-connector-startup-'));
  chmodSync(root, 0o700);
  const home = join(root, 'home');
  const osHome = join(root, 'os-home');
  const temp = join(root, 'tmp');
  for (const dir of [home, osHome, temp]) mkdirSync(dir, { mode: 0o700 });
  const bundle = createBrokerCredentialBundle();
  let registration: ServerResponse | undefined;
  let registerObserved!: () => void;
  const registered = new Promise<void>((resolve) => {
    registerObserved = resolve;
  });
  let pollObserved!: () => void;
  const polled = new Promise<void>((resolve) => {
    pollObserved = resolve;
  });
  const violations: string[] = [];
  let withdraws = 0;
  let scope: SelfHostedBrokerScopeV1;
  const broker = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 16 * 1024) request.destroy();
    });
    request.on('end', () => {
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      try {
        if (
          request.method !== 'POST' ||
          request.headers.authorization !==
            `Bearer ${bundle.connector.secret}` ||
          request.headers['x-broker-credential-id'] !== bundle.connector.id
        )
          throw new Error('unexpected connector request authority');
        const parsed = JSON.parse(body) as {
          scope: unknown;
          expectedRevision?: number;
        };
        expect(parsed.scope).toEqual(scope);
        switch (request.url) {
          case '/broker/v1/leases/register':
            registration = response;
            registerObserved();
            if (refuse) send(401, { error: 'refused' });
            return;
          case '/broker/v1/leases/renew':
            send(200, {
              revision: (parsed.expectedRevision ?? 1) + 1,
              expiresAt: Date.now() + 60_000,
            });
            return;
          case '/broker/v1/connections/offers':
            pollObserved();
            send(200, { offers: [] });
            return;
          case '/broker/v1/leases/withdraw':
            withdraws += 1;
            send(200, { withdrawn: true });
            return;
          default:
            throw new Error('unexpected broker fixture route');
        }
      } catch (error) {
        violations.push(
          error instanceof Error ? error.message : 'invalid broker request',
        );
        send(400, { error: 'fixture-refused' });
      }
    });
  });
  let owned: ReturnType<typeof executeOwnedCommand> | undefined;
  let capture: ReturnType<typeof captureOwnedProcessOutput> | undefined;
  let stopped = false;
  const stop = async () => {
    if (!owned || stopped) return;
    const result = await terminateSuiteExecution(owned, {
      waitForSuiteSettlement,
      terminationGraceMs: 15_000,
      terminationForceMs: 5_000,
      processLabel: 'connector startup Station',
    });
    expect(result.settled).toBe(true);
    expect(result.errors).toEqual([]);
    stopped = true;
  };
  const dispose = async () => {
    try {
      await stop();
    } finally {
      capture?.finish();
      broker.closeAllConnections();
      await bounded(
        new Promise<void>((resolveClose, reject) => {
          if (!broker.listening) {
            resolveClose();
            return;
          }
          broker.close((error) => (error ? reject(error) : resolveClose()));
        }),
        'broker cleanup',
        5_000,
      );
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    const { trust } = await initializeConnectorIdentity(home);
    scope = {
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
      routingGeneration: 1,
      browserOrigin: origin,
    };
    await new Promise<void>((resolveListen, reject) => {
      broker.once('error', reject);
      broker.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = broker.address();
    if (!address || typeof address === 'string')
      throw new Error('Broker port unavailable');
    const cert = join(root, 'cert.pem');
    const key = join(root, 'key.pem');
    execFileSync(
      'openssl',
      ['ecparam', '-genkey', '-name', 'prime256v1', '-out', key],
      { windowsHide: true, timeout: 30_000 },
    );
    chmodSync(key, 0o600);
    execFileSync(
      'openssl',
      [
        'req',
        '-new',
        '-x509',
        '-key',
        key,
        '-out',
        cert,
        '-days',
        '2',
        '-subj',
        '/CN=station-connector-fixture',
      ],
      { windowsHide: true, timeout: 30_000 },
    );
    chmodSync(cert, 0o600);
    const credentialsPath = join(root, 'credentials.json');
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        version: 'station-self-hosted-broker-credentials/v1',
        scope,
        bundle,
      }),
      { mode: 0o600 },
    );
    const executable = join(root, 'pion-noop');
    writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const configPath = join(root, 'connector.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 'station-self-hosted-connector/v1',
        brokerOrigin: `http://127.0.0.1:${address.port}`,
        applicationOrigin: origin,
        credentialsPath,
        pionExecutable: executable,
        certificatePath: cert,
        privateKeyPath: key,
        turn: {
          url: 'turns:turn.example:5349',
          username: 'fixture',
          password: 'fixture',
        },
      }),
      { mode: 0o600 },
    );
    const dotenv = join(root, 'launch.env');
    writeFileSync(dotenv, '', { mode: 0o600 });
    owned = executeOwnedCommand(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve(import.meta.dirname, '../../src-server/index.ts'),
      ],
      spawn,
      'connector startup Station',
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
          STATION_ROOT: join(root, 'station-root'),
          STATION_HOST: '127.0.0.1',
          PORT: '0',
          STATION_INSTANCE: 'connector-startup-fixture',
          STATION_INSTANCE_ID: 'connector-startup-fixture',
          STATION_STDOUT_HANDSHAKE: '1',
          STATION_BROKER_CONFIG_FILE: configPath,
          STATION_LOG_LEVEL: 'error',
          OTEL_SDK_DISABLED: 'true',
          AWS_EC2_METADATA_DISABLED: 'true',
          STATION_LOCAL_ACCOUNTS: '1',
          STATION_PROJECT_SHARING: '1',
          STATION_AUTHENTICATION_ORIGIN: origin,
          STATION_AUTHENTICATION_BROWSER_ORIGINS: origin,
          ALLOWED_ORIGINS: origin,
        },
      },
    );
    capture = captureOwnedProcessOutput(owned, { maxBytes: 512 * 1024 });
    const output = capture;
    const child = owned.child;
    if (!('stdout' in child) || !child.stdout)
      throw new Error('Station stdout unavailable');
    let readyLine: string | undefined;
    let pending = '';
    let readyObserved!: (line: string) => void;
    const ready = new Promise<string>((resolveReady) => {
      readyObserved = resolveReady;
    });
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      if (pending.length > 512 * 1024) {
        pending = '';
        return;
      }
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines)
        if (line.startsWith(readyPrefix)) {
          readyLine = line;
          readyObserved(line);
        }
    });
    const completion = owned.completion;
    const earlyExit = completion.then((result) => {
      throw new Error(
        `Station exited before expected observation (${result.status}): ${output.finish().stderr.text.slice(-3000)}`,
      );
    });
    void earlyExit.catch(() => {});
    return {
      home,
      completion,
      stop,
      dispose,
      violations,
      output,
      waitRegistration: () =>
        bounded(Promise.race([registered, earlyExit]), 'registration'),
      waitOfferPoll: () =>
        bounded(Promise.race([polled, earlyExit]), 'offer poll', 30_000),
      waitReady: () => bounded(Promise.race([ready, earlyExit]), 'readiness'),
      readyLine: () => readyLine,
      stationId: scope.stationId,
      withdraws: () => withdraws,
      releaseRegistration: () => {
        if (!registration) throw new Error('Registration was not requested');
        registration.writeHead(200, { 'Content-Type': 'application/json' });
        registration.end(
          JSON.stringify({
            registeredAt: Date.now(),
            revision: 1,
            expiresAt: Date.now() + 60_000,
          }),
        );
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

describe.skipIf(process.platform === 'win32')(
  'normal entrypoint broker lifecycle',
  () => {
    test('keeps local Station ready during registration, then polls and withdraws before releasing its home', async () => {
      const run = await fixture(false);
      try {
        await run.waitRegistration();
        const ready = JSON.parse(await run.waitReady()) as {
          port: number;
          host: string;
        };
        expect(ready.host).toBe('127.0.0.1');
        expect(ready.port).toBeGreaterThan(1024);
        expect(
          [3000, 3141].some(
            (port) => port >= ready.port && port < ready.port + 4,
          ),
        ).toBe(false);
        const local = await fetch(
          `http://127.0.0.1:${ready.port}/.well-known/station/v1`,
          { signal: AbortSignal.timeout(10_000) },
        );
        expect(local.status).toBe(200);
        expect(await local.json()).toMatchObject({
          environmentId: run.stationId,
        });
        // The fixture has not replied to registration yet. A successful
        // public handshake therefore proves local use is independent of it.
        run.releaseRegistration();
        await run.waitOfferPoll();
        await run.stop();
        const completion = await bounded(run.completion, 'shutdown');
        const diagnostic = run.output.finish();
        expect(
          completion.status,
          JSON.stringify({
            completion,
            withdraws: run.withdraws(),
            stderr: diagnostic.stderr.text.slice(-2000),
          }),
        ).toBe(0);
        expect(run.withdraws()).toBe(1);
        expect(run.violations).toEqual([]);
        expect(run.output.finish().truncated).toBe(false);
        const lease = acquireStationHomeMaintenanceLease(run.home);
        lease.release();
      } finally {
        await run.dispose();
      }
    }, 150_000);

    test('permanent broker refusal withdraws but leaves local Station usable', async () => {
      const run = await fixture(true);
      try {
        await run.waitRegistration();
        const ready = JSON.parse(await run.waitReady()) as { port: number };
        await vi.waitFor(() => expect(run.withdraws()).toBe(1), {
          timeout: 15_000,
        });
        const local = await fetch(
          `http://127.0.0.1:${ready.port}/.well-known/station/v1`,
          { signal: AbortSignal.timeout(10_000) },
        );
        expect(local.status).toBe(200);
        expect(await local.json()).toMatchObject({
          environmentId: run.stationId,
        });
        await run.stop();
        expect((await bounded(run.completion, 'shutdown')).status).toBe(0);
        expect(run.withdraws()).toBe(1);
        expect(run.violations).toEqual([]);
        expect(run.output.finish().truncated).toBe(false);
        const lease = acquireStationHomeMaintenanceLease(run.home);
        lease.release();
      } finally {
        await run.dispose();
      }
    }, 150_000);
  },
);
