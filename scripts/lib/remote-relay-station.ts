/** Private fixture supervisor. The ordinary Station retains all application authority. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import { readExistingEnvironmentSecurityRecord } from '@kontourai/station-shared/environment-security-record';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import { allocateFreePortBlock } from '../../src-server/runtime/bootstrap/allocate-port-block.js';
import { initializeConnectorIdentity } from '../self-hosted-connector-identity.js';
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

export const REMOTE_RELAY_DESCRIPTOR_VERSION = 'remote-relay-descriptor/v1';
export const REMOTE_RELAY_RUN_CONFIG_VERSION = 'remote-relay-run/v1';
const repo = resolve(import.meta.dirname, '../..');
const shaPattern = /^[a-f0-9]{40}$/;
function requirePath(path: string): void {
  assert(
    isAbsolute(path) && !/[\0\r\n]/.test(path),
    'remote_relay_path_invalid',
  );
}
function privateDirectory(path: string): void {
  requirePath(path);
  const stat = lstatSync(path);
  assert(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o777) === 0o700,
    'remote_relay_root_untrusted',
  );
}
function readPrivate(path: string): Buffer {
  requirePath(path);
  const link = lstatSync(path);
  assert(
    link.isFile() && !link.isSymbolicLink(),
    'remote_relay_file_untrusted',
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid?.() &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 65536 &&
        stat.dev === link.dev &&
        stat.ino === link.ino,
      'remote_relay_file_untrusted',
    );
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    assert(length <= 65536, 'remote_relay_file_oversized');
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
function writePrivate(path: string, value: string): void {
  writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
}
function canonicalOrigin(value: unknown): string {
  assert(typeof value === 'string', 'remote_relay_origin_invalid');
  const url = new URL(value);
  assert(
    url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))),
    'remote_relay_origin_invalid',
  );
  return value;
}
function validPort(value: unknown): asserts value is number {
  assert(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 1024 &&
      value <= 65531 &&
      ![3000, 3141].some((port) => port >= value && port < value + 4),
    'remote_relay_port_invalid',
  );
}
async function sourceIdentity() {
  const sourceSha = (
    await runLabCommand('git', ['rev-parse', 'HEAD'], repo)
  ).stdout.trim();
  assert(shaPattern.test(sourceSha), 'remote_relay_source_invalid');
  return {
    sourceSha,
    dirty: Boolean(
      (
        await runLabCommand('git', ['status', '--porcelain'], repo)
      ).stdout.trim(),
    ),
    fixtureSha256: createHash('sha256')
      .update(readFileSync(import.meta.filename))
      .digest('hex'),
  };
}
export interface RelayDescriptor {
  version: string;
  sourceSha: string;
  dirty: boolean;
  fixtureSha256: string;
  stationPort: number;
  stationId: string;
  trust: ApprovedStationConnectionTrust;
  keyId: string;
  dtlsCertificatePath: string;
  dtlsPrivateKeyPath: string;
}
export async function remoteRelayInit(
  runRoot: string,
): Promise<RelayDescriptor> {
  assert(process.platform !== 'win32', 'remote_relay_custody_unsupported');
  privateDirectory(runRoot);
  const identity = await sourceIdentity();
  const home = join(runRoot, 'home');
  mkdirSync(home, { mode: 0o700 });
  const { trust, keyId } = await initializeConnectorIdentity(home);
  const cert = join(runRoot, 'dtls-cert.pem');
  const key = join(runRoot, 'dtls-key.pem');
  // OpenSSL truncates these exclusive private files without broadening their mode.
  writePrivate(cert, '');
  writePrivate(key, '');
  await runLabCommand(
    'openssl',
    ['ecparam', '-genkey', '-name', 'prime256v1', '-out', key],
    repo,
  );
  await runLabCommand(
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
      '/CN=station-remote-fixture',
    ],
    repo,
  );
  readPrivate(cert);
  readPrivate(key);
  const stationPort = await allocateFreePortBlock('127.0.0.1');
  validPort(stationPort);
  const descriptor: RelayDescriptor = {
    version: REMOTE_RELAY_DESCRIPTOR_VERSION,
    ...identity,
    stationPort,
    stationId: trust.stationId,
    trust,
    keyId,
    dtlsCertificatePath: cert,
    dtlsPrivateKeyPath: key,
  };
  writePrivate(join(runRoot, 'descriptor.json'), JSON.stringify(descriptor));
  return descriptor;
}
export interface RelayRunConfig {
  version: string;
  runRoot: string;
  expectedSourceSha: string;
  stationPort: number;
  applicationOrigin: string;
  browserOrigin: string;
  brokerOrigin: string;
  connectorCredentialsPath: string;
  pionExecutable: string;
  turn: { url: string; username: string; password: string };
}
function parseConfig(bytes: Buffer): RelayRunConfig {
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  assert(
    raw && typeof raw === 'object' && !Array.isArray(raw),
    'remote_relay_config_invalid',
  );
  const c = raw as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(c).sort(),
    [
      'version',
      'runRoot',
      'expectedSourceSha',
      'stationPort',
      'applicationOrigin',
      'browserOrigin',
      'brokerOrigin',
      'connectorCredentialsPath',
      'pionExecutable',
      'turn',
    ].sort(),
  );
  assert(
    c.version === REMOTE_RELAY_RUN_CONFIG_VERSION &&
      typeof c.runRoot === 'string' &&
      typeof c.expectedSourceSha === 'string' &&
      shaPattern.test(c.expectedSourceSha),
    'remote_relay_config_invalid',
  );
  assert(
    typeof c.connectorCredentialsPath === 'string' &&
      typeof c.pionExecutable === 'string',
    'remote_relay_config_invalid',
  );
  for (const path of [c.runRoot, c.connectorCredentialsPath, c.pionExecutable])
    requirePath(path);
  validPort(c.stationPort);
  assert(
    c.turn && typeof c.turn === 'object' && !Array.isArray(c.turn),
    'remote_relay_config_invalid',
  );
  const turn = c.turn as Record<string, unknown>;
  assert.deepEqual(Object.keys(turn).sort(), ['password', 'url', 'username']);
  assert(
    typeof turn.url === 'string' &&
      /^turn:127\.0\.0\.1:\d{1,5}\?transport=tcp$/.test(turn.url) &&
      typeof turn.username === 'string' &&
      typeof turn.password === 'string' &&
      turn.username.length > 0 &&
      turn.password.length > 0 &&
      turn.username.length <= 512 &&
      turn.password.length <= 1024,
    'remote_relay_turn_invalid',
  );
  return {
    version: c.version,
    runRoot: c.runRoot,
    expectedSourceSha: c.expectedSourceSha,
    stationPort: c.stationPort,
    applicationOrigin: canonicalOrigin(c.applicationOrigin),
    browserOrigin: canonicalOrigin(c.browserOrigin),
    brokerOrigin: canonicalOrigin(c.brokerOrigin),
    connectorCredentialsPath: c.connectorCredentialsPath,
    pionExecutable: c.pionExecutable,
    turn: { url: turn.url, username: turn.username, password: turn.password },
  };
}
export async function remoteRelayRun(
  configPath: string,
): Promise<{ code: number; settled: boolean }> {
  assert(process.platform !== 'win32', 'remote_relay_custody_unsupported');
  const config = parseConfig(readPrivate(configPath));
  privateDirectory(config.runRoot);
  const identity = await sourceIdentity();
  assert.equal(
    identity.sourceSha,
    config.expectedSourceSha,
    'remote_relay_source_mismatch',
  );
  const descriptor = JSON.parse(
    readPrivate(join(config.runRoot, 'descriptor.json')).toString('utf8'),
  ) as RelayDescriptor;
  assert.equal(
    descriptor.sourceSha,
    identity.sourceSha,
    'remote_relay_source_mismatch',
  );
  assert.equal(
    descriptor.fixtureSha256,
    identity.fixtureSha256,
    'remote_relay_fixture_mismatch',
  );
  assert.equal(
    descriptor.stationPort,
    config.stationPort,
    'remote_relay_port_mismatch',
  );
  const home = join(config.runRoot, 'home');
  const security = readExistingEnvironmentSecurityRecord(home);
  assert.equal(
    security.environmentId,
    descriptor.stationId,
    'remote_relay_station_mismatch',
  );
  const connectorPath = join(config.runRoot, 'connector.json');
  writePrivate(
    connectorPath,
    JSON.stringify({
      version: 'station-self-hosted-connector/v1',
      applicationOrigin: config.applicationOrigin,
      brokerOrigin: config.brokerOrigin,
      certificatePath: join(config.runRoot, 'dtls-cert.pem'),
      privateKeyPath: join(config.runRoot, 'dtls-key.pem'),
      credentialsPath: config.connectorCredentialsPath,
      pionExecutable: config.pionExecutable,
      turn: config.turn,
    }),
  );
  const osHome = join(config.runRoot, 'os-home');
  const temp = join(config.runRoot, 'tmp');
  mkdirSync(osHome, { mode: 0o700 });
  mkdirSync(temp, { mode: 0o700 });
  const dotenv = join(config.runRoot, 'launch.env');
  writePrivate(dotenv, '');
  const execution = executeOwnedCommand(
    process.execPath,
    ['--import', 'tsx', join(repo, 'src-server/index.ts')],
    spawn,
    'remote relay Station',
    {
      cwd: repo,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...localLabEnvironment(),
        DOTENV_CONFIG_PATH: dotenv,
        TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json'),
        HOME: osHome,
        USERPROFILE: osHome,
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
        XDG_CONFIG_HOME: join(osHome, 'config'),
        XDG_CACHE_HOME: join(osHome, 'cache'),
        STATION_HOME: home,
        STATION_ROOT: join(config.runRoot, 'station-root'),
        STATION_HOST: '127.0.0.1',
        PORT: String(config.stationPort),
        STATION_INSTANCE: 'remote-relay-fixture',
        STATION_INSTANCE_ID: 'remote-relay-fixture',
        STATION_BUILD_SHA: identity.sourceSha,
        STATION_STDOUT_HANDSHAKE: '1',
        STATION_SUPERVISOR_PID: String(process.pid),
        STATION_SUPERVISOR_BIRTH:
          lookupProcessBirthFingerprint(process.pid) ?? '',
        STATION_LOCAL_ACCOUNTS: '1',
        STATION_PROJECT_SHARING: '1',
        STATION_AUTHENTICATION_ORIGIN: config.applicationOrigin,
        STATION_AUTHENTICATION_BROWSER_ORIGINS: config.browserOrigin,
        ALLOWED_ORIGINS: `${config.applicationOrigin},${config.browserOrigin}`,
        STATION_BROKER_CONFIG_FILE: connectorPath,
        STATION_LOG_LEVEL: 'error',
        OTEL_SDK_DISABLED: 'true',
        AWS_EC2_METADATA_DISABLED: 'true',
      },
    },
  );
  const capture = captureOwnedProcessOutput(execution, {
    maxBytes: 1024 * 1024,
  });
  let resolveLifetime!: (result: { code: number; settled: boolean }) => void;
  const lifetime = new Promise<{ code: number; settled: boolean }>(
    (resolve) => {
      resolveLifetime = resolve;
    },
  );
  let stopping: Promise<void> | undefined;
  const stdout =
    'stdout' in execution.child ? execution.child.stdout : undefined;
  let ready = false;
  let buffered = '';
  const stop = (code: number): void => {
    stopping ??= Promise.resolve()
      .then(async () => {
        clearTimeout(timer);
        stdout?.off('data', onData);
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        process.stdin.off('end', onEof);
        process.stdin.pause();
        process.stdin.unref?.();
        let settled = false;
        try {
          const result = await terminateSuiteExecution(execution, {
            waitForSuiteSettlement,
            terminationGraceMs: 10_000,
            terminationForceMs: 5_000,
            processLabel: 'remote relay Station',
          });
          settled =
            result.settled && result.errors.length === 0 && !result.escalated;
          if (settled) {
            const child = await execution.completion;
            settled = child.status === 0 && !child.error && !child.signal;
          }
          const output = capture.finish();
          writePrivate(
            join(config.runRoot, 'station.log'),
            `${output.stdout.text}\n${output.stderr.text}`,
          );
          if (output.truncated || output.invalidUtf8) settled = false;
        } catch {
          settled = false;
        }
        resolveLifetime({ code: settled ? code : 1, settled });
      })
      .catch(() => resolveLifetime({ code: 1, settled: false }));
  };
  const onEof = () => stop(0);
  const onSignal = () => stop(1);
  const onOutputError = () => stop(1);
  const onData = (chunk: Buffer) => {
    if (ready || stopping) return;
    buffered += chunk.toString('utf8');
    if (Buffer.byteLength(buffered) > 1024 * 1024) {
      stop(1);
      return;
    }
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{"event":"listening",')) continue;
      try {
        assert.deepEqual(JSON.parse(line), {
          event: 'listening',
          port: config.stationPort,
          host: '127.0.0.1',
        });
        ready = true;
        clearTimeout(timer);
        process.stdout.write(
          `${JSON.stringify({ event: 'remote-relay-ready', port: config.stationPort, stationId: descriptor.stationId, supervisorPid: process.pid, ...identity })}\n`,
        );
      } catch {
        stop(1);
      }
      return;
    }
  };
  const timer = setTimeout(() => stop(1), 90_000);
  stdout?.on('data', onData);
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.stdout.on('error', onOutputError);
  process.stdin.once('end', onEof);
  process.stdin.resume();
  if (!stdout || process.stdin.readableEnded) stop(1);
  void execution.completion.then(
    (result) => {
      if (!stopping)
        stop(result.status && result.status > 0 ? result.status : 1);
    },
    () => stop(1),
  );
  return lifetime;
}
const invoked =
  process.argv[1]?.endsWith('/remote-relay-station.ts') ||
  process.argv[1]?.endsWith('/remote-relay-station.js');
if (invoked) {
  try {
    const [mode, path] = process.argv.slice(2);
    assert(
      process.argv.length === 4 && path && (mode === 'init' || mode === 'run'),
      'remote_relay_arguments_invalid',
    );
    if (mode === 'init')
      process.stdout.write(`${JSON.stringify(await remoteRelayInit(path))}\n`);
    else process.exitCode = (await remoteRelayRun(path)).code;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error(
      JSON.stringify({
        status: 'refused',
        reason: /^remote_relay_[a-z_]+$/.test(message)
          ? message
          : 'remote_relay_unavailable',
      }),
    );
    process.exitCode = 1;
  }
}
