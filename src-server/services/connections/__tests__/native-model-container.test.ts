import { ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { PassThrough, type Writable } from 'node:stream';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../../infra/process-utils.js';
import { NativeModelContainer } from '../native-model-container.js';

vi.mock('../../infra/process-utils.js', () => ({
  spawnOwnedChild: vi.fn(),
  terminateProcessTree: vi.fn(),
}));

const temp = trackTempDirs({ lifetime: 'file' });
const imageId = `sha256:${'a'.repeat(64)}`;
const containerId = 'b'.repeat(64);

afterEach(() => vi.resetAllMocks());

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
  execStopGate,
}: {
  failExecRetirement?: boolean;
  execStopGate?: Promise<void>;
} = {}) {
  const execStopEntered = gate();
  const active = new Map<
    object,
    { operation: string; process: ReturnType<typeof processFixture> }
  >();
  const execs: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const removals: string[] = [];
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
          running = true;
          child.proc.stdout.write(
            '{"type":"ready","port":12345,"uid":10000}\n',
          );
          break;
        case 'exec': {
          execs.push({ args: parameters, env: options?.env ?? {} });
          const chunks: Buffer[] = [];
          child.proc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
          child.proc.stdin.on('end', () =>
            child.finish(Buffer.concat(chunks).toString()),
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
  const controller = NativeModelContainer.prepare({
    namespaceId: 'fixed-text-fixture',
    imageId,
    dockerExecutable: '/fixture/docker',
    endpoint: 'unix:///fixture/docker.sock',
    controllerRoot: realpathSync(temp('native-text-owner-')),
    request() {
      throw new Error('Fixture exec must not make model requests');
    },
  });
  onTestFinished(() => controller.close());
  await controller.start();
  return {
    controller,
    execs,
    removals,
    active,
    execStopEntered: execStopEntered.promise,
  };
}

function writePrompt(stdin: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdin.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

test('competing fixed text launches deliver exactly one private stdin prompt in the owned namespace', async () => {
  const f = await fixture();
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
