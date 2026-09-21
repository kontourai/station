import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type ApplicationChannel,
  createApplicationChannelFetch,
} from '@kontourai/station-connect/application-channel';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import { createSelfHostedBrokerPionRuntime } from '../../src-server/runtime/bootstrap/self-hosted-broker-pion-runtime.js';
import { startPionApplicationAdapter } from '../../src-server/services/connections/pion-application-adapter.js';
import type { BrokerCredentialBundle } from '../../src-server/services/connections/self-hosted-broker-service.js';
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

export interface SelfHostedBrokerLabInput {
  directory: string;
  browserOrigin: string;
  applicationOrigin: string;
  stationId: string;
  enrollmentId: string;
  routingGeneration?: number;
  heartbeatMs?: number;
  renewMs?: number;
  pollMs?: number;
  executable: string;
  certificatePem: string;
  privateKeyPem: string;
  turn: { url: string; username: string; password: string };
  trust: {
    current(): ApprovedStationConnectionTrust | null;
    isCurrent(value: ApprovedStationConnectionTrust): boolean;
  };
  issuer: { issue(binding: StationConnectionProofBinding): Promise<string> };
  openApplicationChannel: () =>
    | ApplicationChannel
    | Promise<ApplicationChannel>;
  signal: AbortSignal;
}

/** Run the actual broker CLI in its own process, with no Station application keys. */
export async function startSelfHostedBrokerLab(
  input: SelfHostedBrokerLabInput,
) {
  input.signal.throwIfAborted();
  const home = join(input.directory, 'self-hosted-broker');
  mkdirSync(home, { mode: 0o700, recursive: true });
  const scope: SelfHostedBrokerScopeV1 = {
    stationId: input.stationId,
    enrollmentId: input.enrollmentId,
    routingGeneration: input.routingGeneration ?? 1,
    browserOrigin: input.browserOrigin,
  };
  const credentialsPath = join(home, 'credentials.json');
  const configPath = join(home, 'config.json');
  const config = {
    version: 'station-self-hosted-broker/v1',
    databasePath: join(home, 'broker.sqlite'),
    credentialsPath,
    port: 0,
    provision: [scope],
  };
  const cli = resolve('scripts/self-hosted-broker.ts');
  writeFileSync(configPath, JSON.stringify(config), {
    flag: 'wx',
    mode: 0o600,
  });
  await runLabCommand(
    process.execPath,
    ['--import', 'tsx', cli, 'init', configPath],
    process.cwd(),
  );
  input.signal.throwIfAborted();
  const record = JSON.parse(readFileSync(credentialsPath, 'utf8')) as {
    bundle: BrokerCredentialBundle;
  };
  writeFileSync(configPath, JSON.stringify({ ...config, provision: [] }), {
    mode: 0o600,
  });
  const execution = executeOwnedCommand(
    process.execPath,
    ['--import', 'tsx', cli, 'serve', configPath],
    spawn,
    'self-hosted broker lab',
    {
      cwd: process.cwd(),
      env: localLabEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const capture = captureOwnedProcessOutput(execution, { maxBytes: 64 * 1024 });
  let runtime: ReturnType<typeof createSelfHostedBrokerPionRuntime> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const errors: unknown[] = [];
      try {
        await runtime?.shutdown();
      } catch (error) {
        errors.push(error);
      }
      try {
        const result = await terminateSuiteExecution(execution, {
          waitForSuiteSettlement,
          terminationGraceMs: 2_000,
          terminationForceMs: 3_000,
          processLabel: 'self-hosted broker lab',
        });
        if (!result.settled || result.errors.length)
          throw new Error('Broker process cleanup unconfirmed');
      } catch (error) {
        errors.push(error);
      }
      const output = capture.finish();
      writeFileSync(
        join(home, 'process.log'),
        `${output.stdout.text}\n${output.stderr.text}`,
        { mode: 0o600 },
      );
      if (output.truncated || output.invalidUtf8)
        errors.push(new Error('Broker output exceeded its bound'));
      if (errors.length)
        throw new AggregateError(errors, 'Broker lab cleanup failed');
    })());
  try {
    const stdout =
      'stdout' in execution.child ? execution.child.stdout : undefined;
    if (!stdout) throw new Error('Broker readiness stream unavailable');
    const port = await new Promise<number>((resolvePort, reject) => {
      let text = '';
      let finished = false;
      const finish = (error?: unknown, value?: number) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        stdout.off('data', data);
        input.signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolvePort(value!);
      };
      const aborted = () =>
        finish(input.signal.reason ?? new Error('Broker startup aborted'));
      const data = (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (Buffer.byteLength(text) > 64 * 1024)
          return finish(new Error('Broker readiness exceeded bound'));
        for (const line of text.split('\n').slice(0, -1)) {
          if (!line.startsWith('STATION_SELF_HOSTED_BROKER ')) continue;
          try {
            const value = JSON.parse(
              line.slice('STATION_SELF_HOSTED_BROKER '.length),
            );
            if (
              value.host !== '127.0.0.1' ||
              !Number.isInteger(value.port) ||
              value.port <= 0 ||
              value.port > 65535
            )
              throw new Error('Broker readiness invalid');
            finish(undefined, value.port);
          } catch (error) {
            finish(error);
          }
        }
      };
      const timer = setTimeout(
        () => finish(new Error('Broker startup timed out')),
        15_000,
      );
      stdout.on('data', data);
      input.signal.addEventListener('abort', aborted, { once: true });
      if (input.signal.aborted) aborted();
      void execution.completion.then(
        () => finish(new Error('Broker exited before readiness')),
        finish,
      );
    });
    const brokerOrigin = `http://127.0.0.1:${port}`;
    const adapterMetadata: Array<{
      provenance: Awaited<
        ReturnType<typeof startPionApplicationAdapter>
      >['provenance'];
      pair(): ReturnType<
        Awaited<
          ReturnType<typeof startPionApplicationAdapter>
        >['peer']['getSelectedCandidatePair']
      >;
    }> = [];
    const observingStart: typeof startPionApplicationAdapter = async (
      options,
    ) => {
      const adapter = await startPionApplicationAdapter(options);
      adapterMetadata.push({
        provenance: adapter.provenance,
        pair: () => adapter.peer.getSelectedCandidatePair(),
      });
      return adapter;
    };
    const channelFetch = createApplicationChannelFetch({
      origin: input.applicationOrigin,
      signal: input.signal,
      open: async () => input.openApplicationChannel(),
      assertCurrent: () => input.signal.throwIfAborted(),
    });
    runtime = createSelfHostedBrokerPionRuntime(
      {
        brokerOrigin,
        applicationOrigin: input.applicationOrigin,
        scope,
        connectorCredential: record.bundle.connector,
        executable: input.executable,
        certificatePem: input.certificatePem,
        privateKeyPem: input.privateKeyPem,
        turn: input.turn,
        trust: input.trust,
        issuer: input.issuer,
        heartbeatMs: input.heartbeatMs ?? 5_000,
        renewMs: input.renewMs ?? 10_000,
        pollMs: input.pollMs ?? 1_000,
        maxPeerLifetimeMs: 300_000,
        maxPeers: 8,
      },
      {
        signal: input.signal,
        // Keep the Request's stream, abort signal and explicit headers intact.
        fetch: (request) => channelFetch(request),
      },
      { startAdapter: observingStart },
    );
    await runtime.start();
    const readLease = async () => {
      const response = await fetch(
        `${brokerOrigin}/broker/v1/stations/status`,
        {
          method: 'POST',
          headers: {
            Origin: input.browserOrigin,
            Authorization: `Bearer ${record.bundle.routing.secret}`,
            'X-Broker-Credential-Id': record.bundle.routing.id,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scope }),
          signal: AbortSignal.timeout(5_000),
          redirect: 'error',
        },
      );
      if (!response.ok)
        throw new Error(`broker_request_refused_${response.status}`);
      return (await response.json()) as {
        state: string;
        routingGeneration: number;
        expiresAt: number;
      };
    };
    return {
      brokerOrigin,
      scope,
      routing: { ...record.bundle.routing },
      adapterMetadata,
      readLease,
      preflight: async () => {
        const response = await fetch(
          `${brokerOrigin}/broker/v1/stations/status`,
          {
            method: 'OPTIONS',
            headers: {
              Origin: input.browserOrigin,
              'Access-Control-Request-Method': 'POST',
              'Access-Control-Request-Headers':
                'Authorization, Content-Type, X-Broker-Credential-Id',
            },
            signal: AbortSignal.timeout(5_000),
            redirect: 'error',
          },
        );
        return {
          status: response.status,
          allowOrigin: response.headers.get('access-control-allow-origin'),
        };
      },
      withdraw: () => runtime!.shutdown(),
      stop,
    };
  } catch (primary) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([primary, cleanup], 'Broker lab startup failed');
    }
    throw primary;
  }
}
