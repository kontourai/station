#!/usr/bin/env node
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTypecheckSlot } from './lib/typecheck-host-slots.mjs';

const rootRequire = createRequire(import.meta.url);
const require = createRequire(
  rootRequire.resolve('@biomejs/biome/package.json'),
);
const directory =
  process.env.STATION_BIOME_SLOT_DIR ||
  (process.platform === 'win32'
    ? join(tmpdir(), 'station-biome-slots')
    : `/tmp/station-biome-slots-${process.getuid()}`);
const slot = await acquireTypecheckSlot({
  label: 'Biome',
  dir: directory,
  slots: 1,
  log: (message) =>
    process.stderr.write(`${message.replaceAll('typecheck', 'Biome')}\n`),
});
process.once('exit', slot.release);
const threads = Number(process.env.BIOME_THREADS ?? 2);
if (!Number.isSafeInteger(threads) || threads < 1)
  throw new Error('BIOME_THREADS must be a positive integer.');
const env = { ...process.env, BIOME_THREADS: String(Math.min(threads, 2)) };
const musl =
  process.platform === 'linux' &&
  !process.report.getReport().header.glibcVersionRuntime;
const platform = musl ? 'linux' : process.platform;
const suffix = process.platform === 'win32' ? '.exe' : '';
const binary =
  process.env.BIOME_BINARY ||
  require.resolve(
    `@biomejs/cli-${platform}-${process.arch}${musl ? '-musl' : ''}/biome${suffix}`,
  );
const args = process.argv.slice(2);
if (process.platform !== 'win32') {
  // Preserve the slot holder PID, so killing a queued/running check cannot orphan Biome.
  process.execve(binary, [binary, ...args], env);
} else {
  const {
    executeOwnedCommand,
    waitForSuiteSettlement,
    terminateSuiteExecution,
  } = await import('./lib/owned-process.mjs');
  const execution = executeOwnedCommand(binary, args, undefined, 'Biome', {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  execution.child.stdout?.pipe(process.stdout, { end: false });
  execution.child.stderr?.pipe(process.stderr, { end: false });
  const stop = () =>
    terminateSuiteExecution(execution, { processLabel: 'Biome' });
  const onSignal = () => {
    void stop();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await execution.completion;
    if (execution.isAlive()) {
      const cleanup = await stop();
      if (!cleanup.settled || cleanup.errors.length)
        throw new Error('Biome process tree did not settle');
    }
    if (!(await waitForSuiteSettlement(execution, 10_000)))
      throw new Error('Biome process tree did not settle');
    if (result.error) throw result.error;
    process.exitCode = result.signal ? 1 : (result.status ?? 1);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}
