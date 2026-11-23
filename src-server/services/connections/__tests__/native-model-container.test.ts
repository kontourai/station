import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, type Writable } from 'node:stream';
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../../infra/process-utils.js';
import {
  NativeModelContainer,
  type NativeModelContainerOptions,
} from '../native-model-container.js';

vi.mock('../../infra/process-utils.js', () => ({
  spawnOwnedChild: vi.fn(),
  terminateProcessTree: vi.fn(),
}));

const temp = trackTempDirs({ lifetime: 'file' });
const imageId = `sha256:${'a'.repeat(64)}`;
const containerId = 'b'.repeat(64);
const fixtureExecutableDigest = 'c'.repeat(64);

beforeEach(() => vi.resetAllMocks());

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

function processFixture() {
  const proc = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let closed = false;
  return {
    proc,
    finish(stdout = '', code: number | null = 0) {
      if (closed) return;
      closed = true;
      proc.stdout.end(stdout);
      proc.stderr.end();
      proc.emit('close', code, code === null ? 'SIGTERM' : null);
    },
  };
}

async function fixture({
  failExecRetirement = false,
  execExitCode = 0,
  execStopGate,
  delegationRpc,
  request = () => {
    throw new Error('Fixture exec must not make model requests');
  },
}: {
  failExecRetirement?: boolean;
  execExitCode?: number;
  execStopGate?: Promise<void>;
  delegationRpc?: NativeModelContainerOptions['delegationRpc'];
  request?: NativeModelContainerOptions['request'];
} = {}) {
  const execStopEntered = gate();
  const active = new Map<
    object,
    { operation: string; process: ReturnType<typeof processFixture> }
  >();
  const execs: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const removals: string[] = [];
  const producerReads: string[][] = [];
  let worker: ReturnType<typeof processFixture> | undefined;
  let running = false;
  let label: string | undefined;
  vi.mocked(spawnOwnedChild).mockImplementation((_, args, options) => {
    const [, , , , operation, ...parameters] = args;
    const child = processFixture();
    active.set(child.proc, { operation, process: child });
    queueMicrotask(() => {
      switch (operation) {
        case 'info':
          child.finish('fixture-daemon');
          break;
        case 'create':
          label = parameters[parameters.indexOf('--label') + 1]?.split('=')[1];
          child.finish(containerId);
          break;
        case 'inspect':
          child.finish(
            JSON.stringify({
              Id: containerId,
              Image: imageId,
              Config: {
                User: '10000:10001',
                Labels: { 'station.native-model-owner': label },
              },
              State: { Running: running },
              HostConfig: {
                NetworkMode: 'none',
                ReadonlyRootfs: true,
                Privileged: false,
                CapAdd: null,
                CapDrop: ['ALL'],
                SecurityOpt: ['no-new-privileges:true'],
                PidMode: '',
                IpcMode: 'private',
                Memory: 536870912,
                MemorySwap: 536870912,
                NanoCpus: 1_000_000_000,
                PidsLimit: 64,
                Binds: null,
                Devices: null,
                DeviceRequests: null,
                VolumesFrom: null,
                Tmpfs: { '/home/native': '', '/tmp': '', '/workspace': '' },
                LogConfig: { Type: 'none' },
              },
              NetworkSettings: { Networks: running ? { none: {} } : {} },
              Mounts: [],
            }),
          );
          break;
        case 'start':
          worker = child;
          running = true;
          child.proc.stdout.write(
            '{"type":"ready","port":12345,"uid":10000}\n',
          );
          break;
        case 'exec': {
          if (!parameters.includes('--interactive')) {
            producerReads.push(parameters);
            if (parameters.includes('--eval'))
              child.finish(fixtureExecutableDigest);
            else if (parameters.at(-1) === '--version')
              child.finish(
                parameters.at(-2) === '/station/claude'
                  ? '2.1.322 (Claude Code)'
                  : 'codex-cli 0.135.0',
              );
            else child.finish('', 1);
            break;
          }
          execs.push({ args: parameters, env: options?.env ?? {} });
          const chunks: Buffer[] = [];
          child.proc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
          child.proc.stdin.on('end', () =>
            child.finish(Buffer.concat(chunks).toString(), execExitCode),
          );
          break;
        }
        case 'rm':
          removals.push(parameters.at(-1) ?? '');
          running = false;
          child.finish(containerId);
          break;
        default:
          child.proc.emit(
            'error',
            new Error(`Unexpected Docker operation ${operation}`),
          );
          child.finish('', 1);
      }
    });
    return {
      proc: child.proc,
      release: () => active.delete(child.proc),
    };
  });
  vi.mocked(terminateProcessTree).mockImplementation(async (handle) => {
    const child = active.get(handle);
    if (!child) throw new Error('Unowned process');
    if (child.operation === 'exec') {
      execStopEntered.resolve();
      await execStopGate;
      if (failExecRetirement) {
        failExecRetirement = false;
        throw new Error('fixture exec cleanup unconfirmed');
      }
    }
    child.process.finish('', null);
  });
  const options: NativeModelContainerOptions = {
    namespaceId: 'fixed-text-fixture',
    imageId,
    dockerExecutable: '/fixture/docker',
    endpoint: 'unix:///fixture/docker.sock',
    controllerRoot: realpathSync(temp('native-text-owner-')),
    request,
    delegationRpc,
  };
  const controller = NativeModelContainer.prepare(options);
  onTestFinished(() => controller.close());
  await controller.start();
  return {
    controller,
    options,
    execs,
    removals,
    active,
    producerReads,
    requestModel: async () => {
      if (!worker) throw new Error('Fixture worker has not started');
      const { stdin, stdout } = worker.proc;
      const id = randomUUID();
      const ended = new Promise<void>((resolve) => {
        const onData = (chunk: Buffer) => {
          const frame = JSON.parse(chunk.toString('utf8'));
          if (frame.type !== 'end' || frame.id !== id) return;
          stdin.off('data', onData);
          resolve();
        };
        stdin.on('data', onData);
      });
      stdout.write(
        JSON.stringify({
          type: 'request',
          id,
          method: 'POST',
          path: '/v1/messages',
          headers: [],
          body: Buffer.from('{}').toString('base64'),
        }) + '\n',
      );
      await ended;
    },
    execStopEntered: execStopEntered.promise,
  };
}

function writePrompt(stdin: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdin.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

test('competing fixed text launches deliver exactly one private stdin prompt in the owned namespace', async () => {
  const f = await fixture({ delegationRpc: unusedBroker });
  const prompt = 'private fixture prompt ☃';
  const token = f.controller.connection().token;
  const write = vi.fn((stdin: Writable) => writePrompt(stdin, prompt));
  const input = {
    engine: 'claude' as const,
    modelId: 'fixture-model',
    signal: new AbortController().signal,
    writePrompt: write,
  };
  const results = await Promise.allSettled([
    f.controller.startText(input),
    f.controller.startText(input),
  ]);
  const admitted = results.find((result) => result.status === 'fulfilled');
  expect(admitted).toBeDefined();
  const refused = results.find((result) => result.status === 'rejected');
  expect(refused?.reason).toEqual(new Error('native_text_admission_closed'));
  const run = admitted?.value;
  expect(await run?.result).toMatchObject({ stdout: prompt });
  await run?.settled;
  expect(write).toHaveBeenCalledTimes(1);
  expect(f.execs).toHaveLength(1);
  const [exec] = f.execs;
  expect(exec.args).toEqual(
    expect.arrayContaining([containerId, '/station/claude']),
  );
  expect(JSON.stringify(exec.args)).not.toContain(prompt);
  expect(JSON.stringify(exec.env)).not.toContain(prompt);
  expect(JSON.stringify(exec.args)).not.toContain(token);
  expect(exec.env.ANTHROPIC_AUTH_TOKEN).toBe(token);
  expect(exec.env.STATION_NATIVE_RPC_KEY).toBeUndefined();
  expect(exec.args).not.toContain('--mcp-config');
  await f.controller.close();
  expect(f.removals).toEqual([containerId]);
  expect(f.active.size).toBe(0);
});

test('the fixed text result survives an independently failed exec settlement and explicit retry', async () => {
  const f = await fixture({ failExecRetirement: true });
  const run = await f.controller.startText({
    engine: 'codex',
    modelId: 'fixture-model',
    modelCatalogPath: '/station/fixture-models.json',
    signal: new AbortController().signal,
    writePrompt: (stdin) => writePrompt(stdin, 'fixed text'),
  });
  const result = await run.result;
  expect(result).toMatchObject({
    stdout: 'fixed text',
    terminal: { code: 0, signal: null },
  });
  await expect(run.settled).rejects.toThrow('fixture exec cleanup unconfirmed');
  expect(f.controller.inspect().nativeText).toEqual({
    submitted: true,
    settled: false,
  });
  expect(f.removals).toEqual([]);
  await f.controller.close();
  expect(f.controller.inspect().nativeText).toEqual({
    submitted: true,
    settled: true,
  });
  expect(f.removals).toEqual([containerId]);
  expect(f.active.size).toBe(0);
  await expect(run.result).resolves.toBe(result);
});

test('container retirement closes model admission during a held exec stop', async () => {
  const stop = gate();
  const prompt = gate();
  onTestFinished(() => {
    stop.resolve();
    prompt.resolve();
  });
  const f = await fixture({ execStopGate: stop.promise });
  const run = await f.controller.startText({
    engine: 'claude',
    modelId: 'fixture-model',
    signal: new AbortController().signal,
    writePrompt: () => prompt.promise,
  });
  const closing = f.controller.close();
  try {
    await f.execStopEntered;
    expect(f.controller.inspect().modelChannel?.admissionClosed).toBe(true);
  } finally {
    stop.resolve();
    prompt.resolve();
    await closing;
  }
  await expect(run.result).rejects.toThrow('native_text_closed');
  expect(f.removals).toEqual([containerId]);
  expect(f.active.size).toBe(0);
});

function unusedBroker(): never {
  throw new Error('Fixture exec must not call the delegation broker');
}

test('brokered launch refuses if the worker was started without the broker', async () => {
  const f = await fixture();
  f.options.delegationRpc = unusedBroker;
  await expect(
    f.controller.startBrokeredText({
      engine: 'claude',
      modelId: 'fixture-model',
      signal: new AbortController().signal,
      writePrompt: (stdin) => writePrompt(stdin, 'unexpected launch'),
    }),
  ).rejects.toThrow('native_delegation_rpc_unavailable');
  expect(f.execs).toHaveLength(0);
});

test.each(['claude', 'codex'] as const)(
  'explicit %s launch binds the mounted relay without disclosing its key in argv',
  async (engine) => {
    const f = await fixture({ delegationRpc: unusedBroker });
    const connection = f.controller.connection();
    const input = {
      engine,
      modelId: 'fixture-model',
      signal: new AbortController().signal,
      writePrompt: (stdin: Writable) =>
        writePrompt(stdin, 'bounded fixture prompt'),
    };
    const run = await f.controller.startBrokeredText(input);
    expect(await run.result).toMatchObject({
      stdout: 'bounded fixture prompt',
    });
    await run.settled;
    await expect(f.controller.captureTextExecutionReceipt()).rejects.toThrow(
      'native_text_completion_unavailable',
    );
    await expect(f.controller.startText(input)).rejects.toThrow(
      'native_text_admission_closed',
    );
    expect(f.execs).toHaveLength(1);
    const [exec] = f.execs;
    expect(exec.env.STATION_NATIVE_RPC_KEY).toBe(connection.token);
    expect(exec.env.STATION_NATIVE_RPC_URL).toBe(
      `${connection.baseUrl}/station/delegation-rpc/v1`,
    );
    expect(exec.args.some((value) => value.includes(connection.token))).toBe(
      false,
    );
    expect(exec.args).toContain(`/station/${engine}`);
    if (engine === 'claude') {
      const config = exec.args[exec.args.indexOf('--mcp-config') + 1];
      expect(JSON.parse(config)).toEqual({
        mcpServers: {
          station_delegation: {
            type: 'stdio',
            command: '/usr/local/bin/node',
            args: [
              '/station/native-model-worker.mjs',
              '--delegation-rpc-client',
            ],
          },
        },
      });
      expect(exec.args).toContain('--strict-mcp-config');
      expect(exec.args[exec.args.indexOf('--allowedTools') + 1]).toBe(
        'mcp__station_delegation__*',
      );
    } else {
      const config = exec.args.find((value) =>
        value.startsWith('mcp_servers.station_delegation='),
      );
      expect(config).toContain('/station/native-model-worker.mjs');
      expect(config).toContain('--delegation-rpc-client');
      expect(config).toContain(
        'env_vars=["STATION_NATIVE_RPC_URL","STATION_NATIVE_RPC_KEY"]',
      );
      expect(config).toContain('required=true');
    }
  },
);

test('retains exact producer and single-request completion facts for the original owner', async () => {
  const f = await fixture({
    request: () => ({
      response: Promise.resolve(new Response(null, { status: 204 })),
      settled: Promise.resolve(),
      invokeDelivery: async (write) => {
        write();
      },
    }),
  });
  const nativeSessionId = randomUUID();
  const output = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: nativeSessionId,
    result: 'Private controlled result',
    permission_denials: [],
  });
  const run = await f.controller.startText({
    engine: 'claude',
    modelId: 'fixture-model',
    signal: new AbortController().signal,
    writePrompt: async (stdin) => {
      await f.requestModel();
      await writePrompt(stdin, output);
    },
  });
  await run.settled;
  const producer = await f.controller.captureTextProducerReceipt();
  expect(await f.controller.captureTextProducerReceipt()).toBe(producer);
  expect(f.producerReads).toHaveLength(2);
  expect(f.producerReads[0]?.at(-1)).toBe('/station/claude');
  expect(f.producerReads[1]?.slice(-2)).toEqual([
    '/station/claude',
    '--version',
  ]);
  const completed = await f.controller.captureTextExecutionReceipt();
  expect(f.controller.inspectTextExecutionReceipt(completed)).toMatchObject({
    containerId,
    imageId,
    nativeSessionId,
    requestedModelId: 'fixture-model',
    terminal: { code: 0, signal: null },
  });
  expect(() =>
    f.controller.inspectTextExecutionReceipt({ ...completed }),
  ).toThrow('native_text_receipt_owner_mismatch');
  expect(() =>
    f.controller.inspectTextProducerReceipt({ ...producer }),
  ).toThrow('native_text_producer_receipt_unavailable');
  await f.controller.close();
  expect(f.controller.inspectTextProducerReceipt(producer)).toMatchObject({
    containerId,
    imageId,
    executablePath: '/station/claude',
    executableSha256: fixtureExecutableDigest,
    cliVersion: '2.1.322',
  });
});

test('a failed brokered exec retains bounded private output before reporting settlement', async () => {
  const f = await fixture({ delegationRpc: unusedBroker, execExitCode: 1 });
  const expected = 'Fixture output before the first model request';
  const run = await f.controller.startBrokeredText({
    engine: 'claude',
    modelId: 'fixture-model',
    signal: new AbortController().signal,
    writePrompt: (stdin) => writePrompt(stdin, expected),
  });
  await expect(run.result).rejects.toThrow('native_text_failed');
  await run.settled;
  const path = join(
    f.controller.inspect().journalDirectory,
    'native-text-output.json',
  );
  const record = JSON.parse(readFileSync(path, 'utf8'));
  expect(record).toMatchObject({
    containerId,
    brokered: true,
    terminal: { code: 1, signal: null },
    bytesReceived: Buffer.byteLength(expected),
    truncated: false,
  });
  expect(Buffer.from(record.stdoutBase64, 'base64').toString('utf8')).toBe(
    expected,
  );
  expect(f.controller.inspect().modelChannel?.requests).toBe(0);
});
