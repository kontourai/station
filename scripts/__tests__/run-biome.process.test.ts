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
    'import{existsSync}from"node:fs";console.log("ready:"+process.env.BIOME_THREADS);setInterval(()=>{if(existsSync(process.argv[3]))process.exit(Number(process.argv[2]??0))},20);',
  );
  return { directory, script };
}
function start(directory: string, script: string, code = 0) {
  const release = join(directory, `release-${children.length}`);
  const child = spawn(
    process.execPath,
    [runner, script, String(code), release],
    {
      env: {
        ...process.env,
        BIOME_BINARY: process.execPath,
        BIOME_THREADS: '64',
        STATION_TYPECHECK_SLOT_HELD: 'inherited-compiler-pool#0',
        STATION_BIOME_SLOT_DIR: join(directory, 'slots'),
      },
      windowsHide: true,
      stdio: 'pipe',
    },
  );
  children.push(child);
  let output = '';
  child.stdout!.on('data', (data) => {
    output += data;
  });
  child.stderr!.on('data', (data) => {
    output += data;
  });
  return {
    child,
    output: () => output,
    finish: () => writeFileSync(release, ''),
  };
}

test('two independent runners serialize Biome and propagate its failure with bounded threads', async () => {
  const { directory, script } = fixture();
  const first = start(directory, script, 7);
  await vi.waitFor(() => expect(first.output()).toContain('ready:2'), {
    timeout: 15_000,
  });
  const second = start(directory, script);
  await vi.waitFor(
    () => expect(second.output()).toContain('waiting for a host Biome slot'),
    { timeout: 15_000 },
  );
  expect(second.output()).not.toContain('ready:');
  const firstExit = once(first.child, 'exit');
  first.finish();
  expect((await firstExit)[0]).toBe(7);
  await vi.waitFor(() => expect(second.output()).toContain('ready:2'), {
    timeout: 15_000,
  });
  const secondExit = once(second.child, 'exit');
  second.finish();
  expect((await secondExit)[0]).toBe(0);
}, 60_000);

test.skipIf(process.platform === 'win32')(
  'a killed slot holder cannot leave Biome alive or starve its successor',
  async () => {
    const { directory, script } = fixture();
    const first = start(directory, script);
    await vi.waitFor(() => expect(first.output()).toContain('ready:2'), {
      timeout: 10_000,
    });
    const exit = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await exit;
    const second = start(directory, script);
    await vi.waitFor(() => expect(second.output()).toContain('ready:2'), {
      timeout: 10_000,
    });
    const secondExit = once(second.child, 'exit');
    second.finish();
    expect((await secondExit)[0]).toBe(0);
  },
);

test.skipIf(process.platform === 'win32')(
  'Biome keeps blocking stdio after a slot wait, so a lagging capture cannot make it fail with EAGAIN (#5119)',
  async () => {
    const { directory, script } = fixture();
    const holder = start(directory, script);
    await vi.waitFor(() => expect(holder.output()).toContain('ready:2'), {
      timeout: 15_000,
    });
    // A native writer that, like Biome, treats EAGAIN as fatal: dd floods
    // stderr (where Biome prints diagnostics) with far more than a pipe or
    // socket buffers, then reports its own exit status on stdout.
    const flood = join(directory, 'flood.sh');
    writeFileSync(
      flood,
      '#!/bin/sh\necho flood-start\nexec 3>&2\ndd if=/dev/zero bs=4096 count=1024 2>/dev/null >&3\nstatus=$?\necho "flood-exit=$status"\nexit $status\n',
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, [runner], {
      env: {
        ...process.env,
        BIOME_BINARY: flood,
        STATION_TYPECHECK_SLOT_HELD: 'inherited-compiler-pool#0',
        STATION_BIOME_SLOT_DIR: join(directory, 'slots'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);
    let stdout = '';
    let stderrText = '';
    let stderrBytes = 0;
    child.stdout!.on('data', (data) => {
      stdout += data;
    });
    child.stderr!.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrText.length < 4096)
        stderrText += data.toString('utf8').replaceAll('\0', '');
    });
    // The wait message is the launcher's own stderr write: the write that
    // used to leave the inherited description non-blocking for Biome.
    await vi.waitFor(
      () => expect(stderrText).toContain('waiting for a host Biome slot'),
      { timeout: 15_000 },
    );
    child.stderr!.pause();
    // Both are subscribed now: 'close' can follow 'exit' in the same tick.
    const exit = once(child, 'exit');
    const closed = once(child, 'close');
    holder.finish();
    await vi.waitFor(() => expect(stdout).toContain('flood-start'), {
      timeout: 15_000,
    });
    // real-time: the capture must lag while the flood runs; a non-blocking
    // writer fails within microseconds of filling the buffer.
    await new Promise((settle) => setTimeout(settle, 500));
    child.stderr!.resume();
    const [code] = await exit;
    await closed;
    expect(stdout).toContain('flood-exit=0');
    expect(code).toBe(0);
    expect(stderrBytes).toBeGreaterThanOrEqual(4096 * 1024);
  },
  60_000,
);
