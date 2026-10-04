#!/usr/bin/env node
// Prints the resolved liveness factor on stdout (the visibility line goes to
// stderr) so a shell entry point such as .githooks/pre-push can resolve it
// once and export it to every child. See scripts/lib/liveness-scale.mjs.
import { ensureLivenessScale } from './lib/liveness-scale-resolve.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

if (invokedDirectly(import.meta.url)) {
  try {
    process.stdout.write(`${await ensureLivenessScale()}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
