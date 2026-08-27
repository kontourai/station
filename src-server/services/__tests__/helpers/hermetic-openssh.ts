import { execFile, spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { connect as connectTcp, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Connection,
  type ParsedKey,
  Server as SshServer,
  utils,
} from 'ssh2';
import { WebSocketServer } from 'ws';
import type {
  OpenSshCommandResult,
  OpenSshCommandRunner,
} from '../../ssh/openssh-config.js';
import { OpenSshEnvironmentAdapter } from '../../ssh/openssh-environment-adapter.js';
import {
  createSystemOpenSshWorkerProbeRunner,
  type OpenSshWorkerProbeResult,
} from '../../ssh/openssh-worker-probe.js';

const USERNAME = 'station-fixture';
const TARGET_ALIAS = 'station-fixture-target';
const JUMP_ALIAS = 'station-fixture-jump';
const TARGET_HOST_KEY_ALIAS = 'station-fixture-target-key';
const JUMP_HOST_KEY_ALIAS = 'station-fixture-jump-key';
const ENVIRONMENT_ID = '33333333-3333-4333-8333-333333333333';
const INSTANCE_ID = 'hermetic-openssh-fixture';
const BOOT_ID = '44444444-4444-4444-8444-444444444444';
const BUILD_SHA = '3'.repeat(40);
const MAX_PROCESS_OUTPUT = 512 * 1024;
const MAX_KEY_GENERATION_ATTEMPTS = 32;

type TrustMode = 'trusted' | 'missing' | 'changed';

interface CreateAdapterOptions {
  trust: TrustMode;
  reservePorts?: readonly number[];
  workerNodeVersion?: string;
}

interface ForwardRequest {
  destination: string;
  port: number;
}

interface RunningSshServer {
  server: SshServer;
  port: number;
  connections: Set<Connection>;
}

interface FixtureKeys {
  client: ReturnType<typeof utils.generateKeyPairSync>;
  jump: ReturnType<typeof utils.generateKeyPairSync>;
  target: ReturnType<typeof utils.generateKeyPairSync>;
  wrong: ReturnType<typeof utils.generateKeyPairSync>;
}

type FixtureKeyPair = ReturnType<typeof utils.generateKeyPairSync>;
type FixtureKeyGenerator = (comment: string) => FixtureKeyPair;

interface FixtureSshFiles {
  clientKeyPath: string;
  configFiles: Record<TrustMode, string>;
}

type ProcessResult = OpenSshCommandResult;

export interface HermeticOpenSshFixture {
  readonly directory: string;
  readonly targetAlias: string;
  readonly jumpAlias: string;
  readonly targetSshPort: number;
  readonly remotePort: number;
  readonly remoteProjectPath: string;
  readonly environmentId: string;
  readonly jumpForwardRequests: ForwardRequest[];
  readonly targetForwardRequests: ForwardRequest[];
  readonly secretMaterial: string[];
  createAdapter(options: CreateAdapterOptions): OpenSshEnvironmentAdapter;
  dropTargetConnections(): void;
  close(): Promise<void>;
}

function exactBuffer(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function parsePublicKey(value: string): ParsedKey {
  const parsed = utils.parseKey(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

function knownHostLine(alias: string, publicKey: string): string {
  return `${alias} ${publicKey.trim().split(/\s+/).slice(0, 2).join(' ')}`;
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function listen(server: NetServer): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture server did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: NetServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createHttpServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function fixtureJsonResponse(
  pathname: string,
  projectPath: string | null,
): unknown | undefined {
  const responses: Record<string, unknown> = {
    '/.well-known/station/v1': {
      schemaVersion: 1,
      environmentId: ENVIRONMENT_ID,
      authentication: { scheme: 'bearer', protocolVersion: 1 },
      transports: { http: 1, sse: 1, websocket: 1 },
    },
    '/api/system/identity': {
      environmentId: ENVIRONMENT_ID,
      instanceId: INSTANCE_ID,
      sha: BUILD_SHA,
      bootId: BOOT_ID,
    },
    '/api/system/status': { ready: true, fixture: 'http' },
    '/api/files': {
      path: projectPath,
      content: 'export const transported = true;\n',
    },
  };
  return responses[pathname];
}

function handleStationRequest(
  remoteProjectPath: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const fixtureResponse = fixtureJsonResponse(
    url.pathname,
    url.searchParams.get('path'),
  );
  if (fixtureResponse !== undefined) {
    json(response, fixtureResponse);
    return;
  }
  if (url.pathname === '/api/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    response.end(
      `event: station.fixture\ndata: ${JSON.stringify({ remoteProjectPath })}\n\n`,
    );
    return;
  }
  if (
    url.pathname === '/api/orchestration/sessions' &&
    request.method === 'POST'
  ) {
    json(response, { sessionId: 'fixture-session', status: 'running' });
    return;
  }
  response.writeHead(404).end();
}

function createStationServer(remoteProjectPath: string): {
  server: ReturnType<typeof createHttpServer>;
  webSockets: WebSocketServer;
} {
  const server = createHttpServer((request, response) =>
    handleStationRequest(remoteProjectPath, request, response),
  );
  const webSockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path !== '/terminal' && path !== '/api/orchestration/ws') {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request);
    });
  });
  webSockets.on('connection', (socket, request) => {
    const terminal = request.url === '/terminal';
    socket.send(
      JSON.stringify(
        terminal
          ? { channel: 'terminal', data: 'fixture-shell' }
          : { channel: 'runtime-session', status: 'streaming' },
      ),
    );
  });
  return { server, webSockets };
}

function authenticate(client: Connection, allowedKey: ParsedKey): void {
  client.on('authentication', (context) => {
    if (
      context.method !== 'publickey' ||
      context.username !== USERNAME ||
      context.key.algo !== allowedKey.type ||
      !exactBuffer(context.key.data, allowedKey.getPublicSSH())
    ) {
      context.reject();
      return;
    }
    if (
      context.signature &&
      (!context.blob ||
        allowedKey.verify(context.blob, context.signature, context.hashAlgo) !==
          true)
    ) {
      context.reject();
      return;
    }
    context.accept();
  });
}

function attachTcpForwarding(
  client: Connection,
  allowedPort: number,
  requests: ForwardRequest[],
): void {
  client.on('tcpip', (accept, reject, info) => {
    requests.push({ destination: info.destIP, port: info.destPort });
    if (info.destIP !== '127.0.0.1' || info.destPort !== allowedPort) {
      reject();
      return;
    }
    const outbound = connectTcp(
      { host: '127.0.0.1', port: allowedPort },
      () => {
        const channel = accept();
        channel.pipe(outbound).pipe(channel);
      },
    );
    outbound.once('error', () => reject());
  });
}

function attachWorkerExecution(
  client: Connection,
  remoteProjectPath: string,
): void {
  client.on('session', (acceptSession) => {
    const session = acceptSession();
    session.once('exec', (accept, reject, info) => {
      const match = /^node - ([A-Za-z0-9_-]+)$/.exec(info.command);
      if (!match) {
        reject();
        return;
      }
      const channel = accept();
      const child = spawn(process.execPath, ['-', match[1]], {
        cwd: remoteProjectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.once('error', (error: NodeJS.ErrnoException) => {
        // The SSH channel can close after the worker has already exited. A
        // broken pipe is then expected teardown; other stream errors still
        // terminate the child and flow through its normal close handling.
        if (error.code !== 'EPIPE') child.kill('SIGKILL');
      });
      channel.pipe(child.stdin);
      child.stdout.pipe(channel, { end: false });
      child.stderr.pipe(channel.stderr, { end: false });
      child.once('close', (code) => {
        channel.exit(code ?? 1);
        channel.end();
      });
      child.once('error', () => {
        channel.exit(1);
        channel.end();
      });
    });
  });
}

async function startSshServer(input: {
  hostPrivateKey: string;
  allowedClientKey: ParsedKey;
  forwardPort: number;
  forwardRequests: ForwardRequest[];
  remoteProjectPath?: string;
}): Promise<RunningSshServer> {
  const connections = new Set<Connection>();
  const server = new SshServer(
    { hostKeys: [input.hostPrivateKey], ident: 'station-hermetic-fixture' },
    (client) => {
      connections.add(client);
      client.once('close', () => connections.delete(client));
      authenticate(client, input.allowedClientKey);
      client.on('ready', () => {
        attachTcpForwarding(client, input.forwardPort, input.forwardRequests);
        if (input.remoteProjectPath) {
          attachWorkerExecution(client, input.remoteProjectPath);
        } else {
          client.on('session', (_accept, reject) => reject());
        }
      });
      client.on('error', () => undefined);
    },
  );
  const port = await listen(server);
  return { server, port, connections };
}

function createConfig(input: {
  clientKeyPath: string;
  knownHostsPath: string;
  globalKnownHostsPath: string;
  jumpPort: number;
  targetPort: number;
}): string {
  const shared = (hostKeyAlias: string) => `
  User ${USERNAME}
  IdentityFile ${input.clientKeyPath}
  IdentitiesOnly yes
  IdentityAgent none
  UserKnownHostsFile ${input.knownHostsPath}
  GlobalKnownHostsFile ${input.globalKnownHostsPath}
  StrictHostKeyChecking yes
  HostKeyAlias ${hostKeyAlias}
  BatchMode yes
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PreferredAuthentications publickey
  ForwardAgent no
  ForwardX11 no
  RequestTTY no
  LogLevel ERROR
`;
  return `Host ${JUMP_ALIAS}
  HostName 127.0.0.1
  Port ${input.jumpPort}${shared(JUMP_HOST_KEY_ALIAS)}

Host ${TARGET_ALIAS}
  HostName 127.0.0.1
  Port ${input.targetPort}
  ProxyJump ${JUMP_ALIAS}${shared(TARGET_HOST_KEY_ALIAS)}
`;
}

export async function runSshProcess(input: {
  sshPath: string;
  configPath: string;
  args: readonly string[];
  stdin?: string;
  timeoutMs: number;
}): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      input.sshPath,
      ['-F', input.configPath, ...input.args],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (result: ProcessResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const append = (current: string, chunk: Buffer): string => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT) {
        child.kill('SIGKILL');
        finish(new Error('Hermetic OpenSSH output exceeded its limit'));
        return current;
      }
      return current + chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => finish(error));
    child.stdin.once('error', (error: NodeJS.ErrnoException) => {
      // A fast host-key rejection or remote worker exit can close ssh before
      // it consumes the probe payload. Preserve ssh's bounded exit result and
      // diagnostics instead of leaking a late EPIPE into Vitest's process.
      const closedPipe =
        error.code === 'EPIPE' ||
        (process.platform === 'win32' && error.code === 'EOF');
      if (!closedPipe) finish(error);
    });
    child.once('close', (exitCode) =>
      finish({ stdout, stderr, exitCode: exitCode ?? 1 }),
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Hermetic OpenSSH process timed out'));
    }, input.timeoutMs);
    if (input.stdin === undefined) child.stdin.end();
    else child.stdin.end(input.stdin);
  });
}

function createRunner(
  sshPath: string,
  configPath: string,
): OpenSshCommandRunner {
  return async (args) => {
    const result = await runSshProcess({
      sshPath,
      configPath,
      args,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || 'OpenSSH command failed');
    }
    return result;
  };
}

function createAdapter(input: {
  sshPath: string;
  configPath: string;
  reservePorts?: readonly number[];
  workerNodeVersion?: string;
}): OpenSshEnvironmentAdapter {
  const ports = [...(input.reservePorts ?? [])];
  const probe = createSystemOpenSshWorkerProbeRunner((request) =>
    runSshProcess({
      sshPath: input.sshPath,
      configPath: input.configPath,
      args: request.args,
      stdin: request.stdin,
      timeoutMs: request.timeoutMs,
    }),
  );
  return new OpenSshEnvironmentAdapter({
    run: createRunner(input.sshPath, input.configPath),
    spawn: (args) =>
      spawn(input.sshPath, ['-F', input.configPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      }),
    reservePort: async () => ports.shift() ?? reserveLoopbackPort(),
    probeWorker: async (request): Promise<OpenSshWorkerProbeResult> => {
      const result = await probe(request);
      return input.workerNodeVersion
        ? { ...result, nodeVersion: input.workerNodeVersion }
        : result;
    },
    pollIntervalMs: 20,
  });
}

async function assertSystemOpenSsh(sshPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(sshPath, ['-V'], (error) => (error ? reject(error) : resolve()));
  });
}

export function generateFixtureKeyPair(
  comment: string,
  generate: FixtureKeyGenerator = (value) =>
    utils.generateKeyPairSync('ed25519', { comment: value }),
): FixtureKeyPair {
  for (let attempt = 1; attempt <= MAX_KEY_GENERATION_ATTEMPTS; attempt += 1) {
    const key = generate(comment);
    if (
      !(utils.parseKey(key.private) instanceof Error) &&
      !(utils.parseKey(key.public) instanceof Error)
    ) {
      return key;
    }
  }
  throw new Error(
    `Could not generate a parseable Ed25519 fixture key after ${MAX_KEY_GENERATION_ATTEMPTS} attempts`,
  );
}

function generateFixtureKeys(): FixtureKeys {
  return {
    client: generateFixtureKeyPair('station-client-fixture'),
    jump: generateFixtureKeyPair('station-jump-fixture'),
    target: generateFixtureKeyPair('station-target-fixture'),
    wrong: generateFixtureKeyPair('station-wrong-fixture'),
  };
}

async function writeFixtureSshFiles(input: {
  directory: string;
  keys: FixtureKeys;
  jumpPort: number;
  targetPort: number;
}): Promise<FixtureSshFiles> {
  const clientKeyPath = join(input.directory, 'client-key');
  const globalKnownHostsPath = join(input.directory, 'global-known-hosts');
  await writeFile(clientKeyPath, input.keys.client.private, { mode: 0o600 });
  await writeFile(globalKnownHostsPath, '', { mode: 0o600 });
  const trustedHosts = [
    knownHostLine(JUMP_HOST_KEY_ALIAS, input.keys.jump.public),
    knownHostLine(TARGET_HOST_KEY_ALIAS, input.keys.target.public),
  ];
  const hostFiles: Record<TrustMode, string> = {
    trusted: join(input.directory, 'known-hosts-trusted'),
    missing: join(input.directory, 'known-hosts-missing'),
    changed: join(input.directory, 'known-hosts-changed'),
  };
  await Promise.all([
    writeFile(hostFiles.trusted, `${trustedHosts.join('\n')}\n`, {
      mode: 0o600,
    }),
    writeFile(hostFiles.missing, `${trustedHosts[0]}\n`, { mode: 0o600 }),
    writeFile(
      hostFiles.changed,
      `${trustedHosts[0]}\n${knownHostLine(TARGET_HOST_KEY_ALIAS, input.keys.wrong.public)}\n`,
      { mode: 0o600 },
    ),
  ]);
  const configFiles = {} as Record<TrustMode, string>;
  for (const trust of ['trusted', 'missing', 'changed'] as const) {
    const path = join(input.directory, `ssh-config-${trust}`);
    await writeFile(
      path,
      createConfig({
        clientKeyPath,
        knownHostsPath: hostFiles[trust],
        globalKnownHostsPath,
        jumpPort: input.jumpPort,
        targetPort: input.targetPort,
      }),
      { mode: 0o600 },
    );
    configFiles[trust] = path;
  }
  return { clientKeyPath, configFiles };
}

export async function startHermeticOpenSshFixture(): Promise<HermeticOpenSshFixture> {
  const sshPath = process.env.STATION_TEST_SSH_PATH ?? 'ssh';
  await assertSystemOpenSsh(sshPath);
  const directory = await mkdtemp(join(tmpdir(), 'station-openssh-fixture-'));
  const requestedProjectPath = join(directory, 'remote-project');
  await mkdir(requestedProjectPath, { recursive: true });
  const remoteProjectPath = await realpath(requestedProjectPath);

  const keys = generateFixtureKeys();

  const station = createStationServer(remoteProjectPath);
  const remotePort = await listen(station.server);
  const targetForwardRequests: ForwardRequest[] = [];
  const target = await startSshServer({
    hostPrivateKey: keys.target.private,
    allowedClientKey: parsePublicKey(keys.client.public),
    forwardPort: remotePort,
    forwardRequests: targetForwardRequests,
    remoteProjectPath,
  });
  const jumpForwardRequests: ForwardRequest[] = [];
  const jump = await startSshServer({
    hostPrivateKey: keys.jump.private,
    allowedClientKey: parsePublicKey(keys.client.public),
    forwardPort: target.port,
    forwardRequests: jumpForwardRequests,
  });

  const { clientKeyPath, configFiles } = await writeFixtureSshFiles({
    directory,
    keys,
    jumpPort: jump.port,
    targetPort: target.port,
  });

  return {
    directory,
    targetAlias: TARGET_ALIAS,
    jumpAlias: JUMP_ALIAS,
    targetSshPort: target.port,
    remotePort,
    remoteProjectPath,
    environmentId: ENVIRONMENT_ID,
    jumpForwardRequests,
    targetForwardRequests,
    secretMaterial: [
      keys.client.private.trim(),
      clientKeyPath,
      ...Object.values(configFiles),
    ],
    createAdapter: (options) =>
      createAdapter({
        sshPath,
        configPath: configFiles[options.trust],
        reservePorts: options.reservePorts,
        workerNodeVersion: options.workerNodeVersion,
      }),
    dropTargetConnections: () => {
      for (const connection of target.connections) connection.end();
    },
    close: async () => {
      for (const connection of target.connections) connection.end();
      for (const connection of jump.connections) connection.end();
      station.webSockets.close();
      await Promise.all([
        closeServer(target.server),
        closeServer(jump.server),
        closeServer(station.server),
      ]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
