import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const makeTempDir = trackTempDirs();
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
});
const runner = resolve('scripts/run-biome.mjs');
function fixture() {
  const directory = makeTempDir('station-biome-runner-');
  const script = join(directory, 'probe.mjs');
  writeFileSync(
    script,
    'console.log("ready:"+process.env.BIOME_THREADS);process.stdin.once("data",()=>process.exit(Number(process.argv[2]??0)));',
  );
  return { directory, script };
}
function start(directory: string, script: string, code = 0) {
  const child = spawn(process.execPath, [runner, script, String(code)], {
    env: {
      ...process.env,
      BIOME_BINARY: process.execPath,
      BIOME_THREADS: '64',
      STATION_BIOME_SLOT_DIR: join(directory, 'slots'),
    },
    windowsHide: true,
    stdio: 'pipe',
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', (data) => {
    output += data;
  });
  child.stderr!.on('data', (data) => {
    output += data;
  });
  return { child, output: () => output };
}

test('two independent runners serialize Biome and propagate its failure with bounded threads', async () => {
  const { directory, script } = fixture();
  const first = start(directory, script, 7);
  await vi.waitFor(() => expect(first.output()).toContain('ready:2'));
  const second = start(directory, script);
  await vi.waitFor(() =>
    expect(second.output()).toContain('waiting for a host Biome slot'),
  );
  expect(second.output()).not.toContain('ready:');
  const firstExit = once(first.child, 'exit');
  first.child.stdin!.write('finish');
  expect((await firstExit)[0]).toBe(7);
  await vi.waitFor(() => expect(second.output()).toContain('ready:2'));
  const secondExit = once(second.child, 'exit');
  second.child.stdin!.write('finish');
  expect((await secondExit)[0]).toBe(0);
});

test.skipIf(process.platform === 'win32')(
  'a killed slot holder cannot leave Biome alive or starve its successor',
  async () => {
    const { directory, script } = fixture();
    const first = start(directory, script);
    await vi.waitFor(() => expect(first.output()).toContain('ready:2'));
    const exit = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await exit;
    const second = start(directory, script);
    await vi.waitFor(() => expect(second.output()).toContain('ready:2'));
    const secondExit = once(second.child, 'exit');
    second.child.stdin!.write('finish');
    expect((await secondExit)[0]).toBe(0);
  },
);
