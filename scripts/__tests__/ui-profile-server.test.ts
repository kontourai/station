import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { startFixtureUi } from '../lib/ui-profile-server.mjs';

const ownership = vi.hoisted(() => ({
  execute: vi.fn(),
  signals: new Map<string, Set<() => void>>(),
}));

vi.mock('../lib/owned-process.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/owned-process.mjs')>()),
  executeOwnedCommand: ownership.execute,
  registerProcessSignal(signal: string, handler: () => void) {
    const listeners = ownership.signals.get(signal) ?? new Set();
    listeners.add(handler);
    ownership.signals.set(signal, listeners);
    return () => {
      listeners.delete(handler);
      if (!listeners.size) ownership.signals.delete(signal);
    };
  },
}));

function commandExecution() {
  let alive = true;
  let complete!: (result: { status: number | null; signal: null }) => void;
  const completion = new Promise<{ status: number | null; signal: null }>(
    (accept) => {
      complete = accept;
    },
  );
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
  const finish = (status: number | null = 0) => {
    alive = false;
    child.stdout.emit('end');
    child.stderr.emit('end');
    complete({ status, signal: null });
  };
  return {
    child,
    completion,
    isAlive: () => alive,
    terminate: vi.fn(async () => finish(null)),
    forceTerminate: vi.fn(async () => finish(null)),
    finish,
    retire: () => {
      alive = false;
    },
  };
}

const makeTempDir = trackTempDirs();
const commands: {
  args: string[];
  env: NodeJS.ProcessEnv;
  execution: ReturnType<typeof commandExecution>;
}[] = [];
let lane: Awaited<ReturnType<typeof startFixtureUi>> | undefined;
let output: string;
let blockBuild = false;
let previousExitCode: typeof process.exitCode;
const pending: Promise<unknown>[] = [];
const journey = {
  spec: 'tests/task-first-home.spec.ts',
  grep: 'profiles Home',
  ids: ['home-history'],
};
const sourceIdentity = { sourceRevision: 'sha', sourceDiffSha256: 'diff' };
const builtIndex = '<script src="/assets/app.js"></script>';

beforeEach(() => {
  output = makeTempDir('ui-profile-server-');
  previousExitCode = process.exitCode;
  blockBuild = false;
  commands.length = 0;
  ownership.signals.clear();
  ownership.execute.mockReset();
  ownership.execute.mockImplementation(
    (
      _executable: string,
      args: string[],
      _spawn: unknown,
      _label: string,
      options: { env: NodeJS.ProcessEnv },
    ) => {
      const execution = commandExecution();
      commands.push({ args, env: options.env, execution });
      if (args[0] === 'node_modules/vite/bin/vite.js' && !blockBuild) {
        mkdirSync(resolve(output, 'ui'), { recursive: true });
        writeFileSync(resolve(output, 'ui/index.html'), builtIndex);
      }
      if (
        (args[0] === 'node_modules/vite/bin/vite.js' && !blockBuild) ||
        args[0] === 'scripts/ui-bundle-budget.mjs'
      )
        queueMicrotask(() => execution.finish());
      return execution;
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('/assets/app.js')),
  );
});

afterEach(async () => {
  for (const command of commands) command.execution.finish();
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  await lane?.stop().catch(() => {});
  await Promise.all(pending.splice(0));
  lane = undefined;
  process.exitCode = previousExitCode;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('builds and records production mode at an absolute output path independent of the source drive', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  const root =
    process.platform === 'win32' ? 'Z:\\profile-source' : '/profile-source';
  lane = await startFixtureUi(root, output, sourceIdentity);
  const build = commands[0];
  const uiDirectory = resolve(output, 'ui');
  expect(build.env.NODE_ENV).toBe('production');
  expect(build.args.slice(1)).toEqual([
    'build',
    '--mode',
    'production',
    '--outDir',
    uiDirectory,
  ]);
  expect(build.env.STATION_BUILD_UI_DIR).toBe(uiDirectory);
  expect(commands[1].env.STATION_BUILD_UI_DIR).toBe(uiDirectory);
  expect(
    JSON.parse(readFileSync(join(output, 'build.provenance.json'), 'utf8')),
  ).toMatchObject({
    nodeEnv: 'production',
    mode: 'production',
    outDir: uiDirectory,
    args: build.args,
    ...sourceIdentity,
    indexSha256: createHash('sha256').update(builtIndex).digest('hex'),
  });
  expect(lane.buildProvenanceSha256).toBe(
    createHash('sha256')
      .update(readFileSync(join(output, 'build.provenance.json')))
      .digest('hex'),
  );
  const capture = lane.run(journey, output);
  expect(commands[3].env.STATION_JOURNEY_BUILD_PROVENANCE).toBe(
    resolve(output, 'build.provenance.json'),
  );
  commands[3].execution.finish();
  await capture;
  await lane.stop();
  expect(ownership.signals.size).toBe(0);
});

test.each(['SIGINT', 'SIGTERM'])(
  '%s waits for preview and browser tree settlement once before rejecting a capture',
  async (signal) => {
    lane = await startFixtureUi(process.cwd(), output, sourceIdentity);
    vi.useFakeTimers();
    let outcome: unknown;
    pending.push(
      lane.run(journey, output).catch((error: unknown) => {
        outcome = error;
      }),
    );
    const active = commands.slice(2);
    for (const command of active)
      command.execution.terminate.mockImplementation(async () => {});
    expect(ownership.signals.get(signal)?.size).toBe(2);
    for (const handler of [...ownership.signals.get(signal)!]) handler();
    for (const handler of [...ownership.signals.get(signal)!]) handler();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeUndefined();
    expect(ownership.signals.size).toBe(2);
    for (const command of active) {
      expect(command.execution.terminate).toHaveBeenCalledTimes(1);
      expect(command.execution.forceTerminate).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(5_100);
    expect(outcome).toBeInstanceOf(Error);
    for (const command of active) {
      expect(command.execution.forceTerminate).toHaveBeenCalledTimes(1);
      expect(command.execution.isAlive()).toBe(false);
    }
    expect(process.exitCode).toBe(signal === 'SIGINT' ? 130 : 143);
    await expect(lane.run(journey, output)).rejects.toThrow('interrupted');
    expect(commands).toHaveLength(4);
    await expect(lane.stop()).rejects.toThrow('interrupted');
    expect(ownership.signals.size).toBe(0);
  },
);

test.each(['SIGINT', 'SIGTERM'])(
  '%s cancels startup even if the build exits successfully during cleanup',
  async (signal) => {
    blockBuild = true;
    let outcome: unknown;
    pending.push(
      startFixtureUi(process.cwd(), output, sourceIdentity).catch(
        (error: unknown) => {
          outcome = error;
        },
      ),
    );
    commands[0].execution.terminate.mockImplementation(async () =>
      commands[0].execution.finish(0),
    );
    expect(ownership.signals.get(signal)?.size).toBe(1);
    for (const handler of [...ownership.signals.get(signal)!]) handler();
    await Promise.all(pending);
    expect(outcome).toBeInstanceOf(Error);
    expect(commands).toHaveLength(1);
    expect(ownership.signals.size).toBe(0);
  },
);

test('bounds command completion after tree settlement rather than hanging on output EOF', async () => {
  lane = await startFixtureUi(process.cwd(), output, sourceIdentity);
  vi.useFakeTimers();
  const preview = commands[2].execution;
  preview.terminate.mockImplementation(async () => preview.retire());
  let outcome: unknown;
  pending.push(
    lane.stop().catch((error: unknown) => {
      outcome = error;
    }),
  );
  await vi.advanceTimersByTimeAsync(5_100);
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(ownership.signals.size).toBe(0);
});

test('interruption during final preview cleanup cannot authorize a completed capture', async () => {
  lane = await startFixtureUi(process.cwd(), output, sourceIdentity);
  for (const handler of [...ownership.signals.get('SIGTERM')!]) handler();
  await expect(lane.stop()).rejects.toThrow('interrupted');
  expect(ownership.signals.size).toBe(0);
});
