#!/usr/bin/env node
/**
 * Run a heavy repository check holding a host-wide heavy-check slot.
 *
 * Usage: `node scripts/heavy-check-slot.mjs <label> <script.mjs> [arguments]`
 * runs `node <script.mjs> [arguments]` once a slot is free. The label names
 * the check in every waiter's message, so it should be the package script.
 * The pool, its sizing and its nesting rule live in
 * `scripts/lib/heavy-check-slots.mjs`.
 *
 * A wait that runs out exits 1 with the holders named; the check is never
 * silently skipped. The check runs as the slot holder
 * (`scripts/lib/slot-holder-exec.mjs`), so its exit status is this runner's.
 */
import {
  acquireHeavyCheckSlot,
  HEAVY_CHECK_HELD_ENV,
} from './lib/heavy-check-slots.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { execAsSlotHolder } from './lib/slot-holder-exec.mjs';

async function main([label, script, ...args] = process.argv.slice(2)) {
  if (!label || !script) {
    process.stderr.write(
      'Usage: node scripts/heavy-check-slot.mjs <label> <script.mjs> [arguments]\n',
    );
    process.exitCode = 2;
    return;
  }
  let slot;
  try {
    slot = await acquireHeavyCheckSlot({ label });
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
    return;
  }
  if (!slot.reentrant && !slot.skipped) {
    process.once('exit', slot.release);
    // The pid survives execve, so descendants see their holder as alive.
    process.env[HEAVY_CHECK_HELD_ENV] = String(process.pid);
  }
  await execAsSlotHolder({
    file: process.execPath,
    args: [script, ...args],
    label,
  });
}

if (invokedDirectly(import.meta.url)) {
  await main();
}
