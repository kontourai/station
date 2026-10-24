import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findFreePortBlock, findFreePortOutside } from './free-ports.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './owned-process.mjs';

/** Runs the real source entrypoint; the observer must prove export, not just boot. */
export async function withTelemetryStation(input, observe) {
  const directory = join(input.output, 'station');
  await mkdir(directory, { mode: 0o700 });
  const home = join(directory, 'home');
  const temp = join(directory, 'temp');
  const registry = join(directory, 'process-registry');
  for (const path of [home, temp, registry]) await mkdir(path, { mode: 0o700 });
  const port = await findFreePortBlock(4);
  assert(
    ![3000, 3141].some((reserved) => reserved >= port && reserved < port + 4),
  );
  const deniedPort = await findFreePortOutside(port, 4);
  assert.notEqual(deniedPort, input.collectorPort);
  const config = join(directory, 'launch.json');
  await writeFile(
    config,
    JSON.stringify({
      ports: [port, port + 1, port + 2, port + 3, input.collectorPort],
      deniedPort,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const dotenv = join(directory, 'empty.env');
  await writeFile(dotenv, '', { mode: 0o600, flag: 'wx' });
  const serviceName = `station-runtime-${input.owner}`;
  const effect = {
    label: 'real Station source process',
    state: 'intent',
    port,
  };
  await input.record(effect);
  const execution = executeOwnedProcess(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      join(input.root, 'scripts/lib/telemetry-station-child.mjs'),
      config,
    ],
    undefined,
    'telemetry Station',
    {
      cwd: input.root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        DOTENV_CONFIG_PATH: dotenv,
        TSX_TSCONFIG_PATH: join(input.root, 'tsconfig.json'),
        STATION_HOME: home,
        STATION_ROOT: join(directory, 'root'),
        STATION_TEMP_ROOT: temp,
        STATION_OWNED_PROCESS_REGISTRY: registry,
        STATION_INSTANCE: serviceName,
        STATION_INSTANCE_ID: serviceName,
        STATION_HOST: '127.0.0.1',
        PORT: String(port),
        STATION_STDOUT_HANDSHAKE: '1',
        STATION_LOG_LEVEL: 'error',
        DO_NOT_TRACK: '1',
        STATION_TELEMETRY_TIER: 'off',
        AWS_EC2_METADATA_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${input.collectorPort}`,
        STATION_OTEL_API_KEY: input.otelKey,
        OTEL_SERVICE_NAME: serviceName,
      },
    },
  );
  effect.state = 'started';
  effect.pid = execution.child.pid;
  const capture = captureOwnedProcessOutput(execution, {
    maxBytes: 3 * 1024 * 1024,
    onOverflow: () => {
      void execution.forceTerminate().catch(() => {});
    },
  });
  let line = '';
  let timer;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const parse = (chunk) => {
    line += chunk.toString('utf8');
    if (line.length > 64 * 1024) {
      line = '';
      rejectReady(new Error('Station readiness output exceeded its bound'));
      return;
    }
    let end = line.indexOf('\n');
    while (end !== -1) {
      const next = line.slice(0, end);
      line = line.slice(end + 1);
      try {
        const message = JSON.parse(next);
        if (message.event === 'listening') resolveReady(message);
      } catch {
        /* Ordinary Station log lines are not handshake messages. */
      }
      end = line.indexOf('\n');
    }
  };
  execution.child.stdout.on('data', parse);
  try {
    const [, listening] = await Promise.all([
      input.record(effect),
      Promise.race([
        ready,
        execution.completion.then(() => {
          throw new Error('Station exited before readiness');
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Station readiness deadline')),
            90_000,
          );
        }),
      ]),
    ]);
    clearTimeout(timer);
    assert.equal(listening.port, port);
    assert.equal(listening.host, '127.0.0.1');
    const result = await observe({ port, serviceName, home });
    assert(execution.isAlive(), 'Station exited during export qualification');
    return result;
  } finally {
    clearTimeout(timer);
    const cleanup = await terminateSuiteExecution(execution, {
      terminationGraceMs: 30_000,
      terminationForceMs: 5000,
      waitForSuiteSettlement,
    });
    execution.child.stdout.off('data', parse);
    const bytes = capture.finish();
    await writeFile(
      join(directory, 'process.log'),
      bytes.stdout.text + bytes.stderr.text,
      { mode: 0o600, flag: 'wx' },
    );
    effect.state = cleanup.settled ? 'stopped' : 'unsettled';
    effect.cleanup = cleanup;
    await input.record(effect);
    assert(
      cleanup.settled && !cleanup.escalated && !cleanup.errors.length,
      'Station process cleanup incomplete',
    );
    assert(
      !bytes.truncated && !bytes.invalidUtf8,
      'Station output evidence incomplete',
    );
  }
}
