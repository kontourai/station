#!/usr/bin/env node
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { biomeCommand } from './lib/biome-cli.mjs';
import { execAsSlotHolder } from './lib/slot-holder-exec.mjs';
import {
  acquireTypecheckSlot,
  SLOT_HELD_ENV,
} from './lib/typecheck-host-slots.mjs';

const directory =
  process.env.STATION_BIOME_SLOT_DIR ||
  (process.platform === 'win32'
    ? join(tmpdir(), 'station-biome-slots')
    : `/tmp/station-biome-slots-${process.getuid()}`);
const slotEnvironment = { ...process.env };
// A compiler's inherited ownership marker does not own the distinct Biome pool.
delete slotEnvironment[SLOT_HELD_ENV];
const slot = await acquireTypecheckSlot({
  env: slotEnvironment,
  label: 'Biome',
  dir: directory,
  slots: 1,
  log: (message) =>
    process.stderr.write(`${message.replaceAll('typecheck', 'Biome')}\n`),
});
process.once('exit', slot.release);
const { binary, env } = biomeCommand();
const args = process.argv.slice(2);
if (process.platform !== 'win32') {
  // Preserve the slot holder PID, so killing a queued/running check cannot orphan Biome.
  await execAsSlotHolder({ file: binary, args, label: 'Biome', env });
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
    terminateSuiteExecution(execution, {
      processLabel: 'Biome',
      terminationGraceMs: 5_000,
      terminationForceMs: 5_000,
      waitForSuiteSettlement,
    });
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
