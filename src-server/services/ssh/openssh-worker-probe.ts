import { spawn } from 'node:child_process';
import { requireOpenSshAlias } from './openssh-config.js';

export const SSH_WORKER_PROTOCOL_VERSION = 1;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface OpenSshWorkerProbeResult {
  protocolVersion: number;
  nodeVersion: string;
  platform: string;
  arch: string;
  remoteHome: string;
  remoteProjectPath: string;
  environmentId: string;
  instanceId: string;
  sha: string;
  bootId: string;
}

export interface OpenSshWorkerProbeInput {
  alias: string;
  controlPath: string;
  remoteProjectPath: string;
  remotePort: number;
  timeoutMs?: number;
}

export type OpenSshWorkerProbeRunner = (
  input: OpenSshWorkerProbeInput,
) => Promise<OpenSshWorkerProbeResult>;

interface ProbeProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type RunProbeProcess = (input: {
  args: readonly string[];
  stdin: string;
  timeoutMs: number;
}) => Promise<ProbeProcessResult>;

const REMOTE_WORKER_SOURCE = String.raw`
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fail = (reason) => {
  process.stderr.write(JSON.stringify({ protocolVersion: 1, error: reason }));
  process.exit(1);
};

const main = async () => {
  let input;
  try {
    input = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8'));
  } catch {
    fail('invalid-probe-payload');
  }
  if (!input || input.protocolVersion !== 1) fail('unsupported-probe-protocol');
  if (!Number.isInteger(input.remotePort) || input.remotePort < 1 || input.remotePort > 65535) {
    fail('invalid-remote-port');
  }
  if (typeof input.remoteProjectPath !== 'string' || !input.remoteProjectPath || input.remoteProjectPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.remoteProjectPath)) {
    fail('invalid-project-path');
  }
  const requested = input.remoteProjectPath === '~'
    ? os.homedir()
    : input.remoteProjectPath.startsWith('~/')
      ? path.join(os.homedir(), input.remoteProjectPath.slice(2))
      : input.remoteProjectPath;
  let remoteProjectPath;
  try {
    remoteProjectPath = fs.realpathSync(requested);
    if (!fs.statSync(remoteProjectPath).isDirectory()) fail('project-not-directory');
  } catch {
    fail('project-unavailable');
  }
  let handshake;
  let identity;
  try {
    const base = 'http://127.0.0.1:' + input.remotePort;
    const [handshakeResponse, identityResponse] = await Promise.all([
      fetch(base + '/.well-known/station/v1'),
      fetch(base + '/api/system/identity'),
    ]);
    if (!handshakeResponse.ok || !identityResponse.ok) fail('station-unavailable');
    handshake = await handshakeResponse.json();
    identity = await identityResponse.json();
  } catch {
    fail('station-unavailable');
  }
  if (!handshake || typeof handshake.environmentId !== 'string') fail('invalid-environment-identity');
  if (!identity || typeof identity.instanceId !== 'string' || typeof identity.sha !== 'string' || typeof identity.bootId !== 'string') {
    fail('invalid-build-identity');
  }
  process.stdout.write(JSON.stringify({
    protocolVersion: 1,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    remoteHome: os.homedir(),
    remoteProjectPath,
    environmentId: handshake.environmentId,
    instanceId: identity.instanceId,
    sha: identity.sha,
    bootId: identity.bootId,
  }));
};

main().catch(() => fail('worker-failed'));
`;

function safeRemotePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('Remote Station port must be between 1 and 65535');
  }
  return value;
}

function encodeProbePayload(input: OpenSshWorkerProbeInput): string {
  if (
    !input.remoteProjectPath ||
    input.remoteProjectPath.length > 4096 ||
    [...input.remoteProjectPath].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error('Remote project path is invalid');
  }
  return Buffer.from(
    JSON.stringify({
      protocolVersion: SSH_WORKER_PROTOCOL_VERSION,
      remoteProjectPath: input.remoteProjectPath,
      remotePort: safeRemotePort(input.remotePort),
    }),
    'utf8',
  ).toString('base64url');
}

export function buildOpenSshWorkerProbeArgs(
  input: OpenSshWorkerProbeInput,
): string[] {
  const alias = requireOpenSshAlias(input.alias);
  return [
    '-S',
    input.controlPath,
    '-T',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'RemoteCommand=none',
    '--',
    alias,
    'node',
    '-',
    encodeProbePayload(input),
  ];
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
    throw new Error('OpenSSH worker response exceeded the output limit');
  }
  return next;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function runSystemProbeProcess(input: {
  args: readonly string[];
  stdin: string;
  timeoutMs: number;
}): Promise<ProbeProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...input.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ProbeProcessResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('OpenSSH worker probe timed out'));
    }, input.timeoutMs);
    child.once('error', () =>
      finish(new Error('OpenSSH worker is unavailable')),
    );
    child.stdout.on('data', (chunk) => {
      try {
        stdout = appendBounded(stdout, chunk);
      } catch (error) {
        child.kill('SIGKILL');
        finish(error as Error);
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        stderr = appendBounded(stderr, chunk);
      } catch (error) {
        child.kill('SIGKILL');
        finish(error as Error);
      }
    });
    child.once('close', (exitCode) =>
      finish({ stdout, stderr, exitCode: exitCode ?? 1 }),
    );
    child.stdin.end(input.stdin);
  });
}

function parseWorkerResponse(
  result: ProbeProcessResult,
): OpenSshWorkerProbeResult {
  if (result.exitCode !== 0) {
    let reason = 'worker-unavailable';
    try {
      const parsed = JSON.parse(result.stderr) as { error?: unknown };
      if (typeof parsed.error === 'string') reason = parsed.error;
    } catch {}
    throw new Error(`Remote Station worker failed: ${reason}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error('Remote Station worker returned invalid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remote Station worker returned an invalid response');
  }
  const response = value as Record<string, unknown>;
  const stringFields: Array<[string, number]> = [
    ['nodeVersion', 128],
    ['platform', 128],
    ['arch', 128],
    ['remoteHome', 4096],
    ['remoteProjectPath', 4096],
    ['environmentId', 256],
    ['instanceId', 256],
    ['sha', 128],
    ['bootId', 256],
  ];
  if (
    response.protocolVersion !== SSH_WORKER_PROTOCOL_VERSION ||
    stringFields.some(
      ([field, maximum]) =>
        typeof response[field] !== 'string' ||
        response[field].length === 0 ||
        response[field].length > maximum ||
        hasControlCharacters(response[field]),
    )
  ) {
    throw new Error('Remote Station worker response is incompatible');
  }
  return response as unknown as OpenSshWorkerProbeResult;
}

export function createSystemOpenSshWorkerProbeRunner(
  runProcess: RunProbeProcess = runSystemProbeProcess,
): OpenSshWorkerProbeRunner {
  return async (input) => {
    const result = await runProcess({
      args: buildOpenSshWorkerProbeArgs(input),
      stdin: REMOTE_WORKER_SOURCE,
      timeoutMs: input.timeoutMs ?? 30_000,
    });
    return parseWorkerResponse(result);
  };
}
