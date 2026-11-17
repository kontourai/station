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
import { holdHeavyCheckSlotForProcess } from './lib/heavy-check-slots.mjs';
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
  if (!(await holdHeavyCheckSlotForProcess(label))) {
    process.exitCode = 1;
    return;
  }
  await execAsSlotHolder({
    file: process.execPath,
    // Node flags given to this runner apply to the check it becomes.
    args: [...process.execArgv, script, ...args],
    label,
  });
}

if (invokedDirectly(import.meta.url)) {
  await main();
}
