import childProcess from 'node:child_process';
import { errorMonitor } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';

const directory = join(process.cwd(), '.kontourai', 'verification-output');
const file = join(directory, `windows-workers-${process.pid}.jsonl`);
let warned = false;

function record(event, details) {
  const entry = { event, coordinator: process.pid, ...details };
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    if (!warned) {
      warned = true;
      console.error(`[windows-worker] diagnostic write failed: ${error.code}`);
    }
  }
  if (event === 'exit')
    console.error('[windows-worker]', JSON.stringify(entry));
}

record('coordinator', {
  node: process.version,
  suites: process.argv
    .slice(2)
    .filter((arg) => /\.test\.[cm]?[jt]sx?$/.test(arg)),
});

// Vitest discards the exit arguments when reporting an unexpected fork exit (#4626).
const originalFork = childProcess.fork;
childProcess.fork = function (...args) {
  const child = Reflect.apply(originalFork, this, args);
  const entrypoint = basename(String(args[0]));
  child.once('spawn', () => record('spawn', { child: child.pid, entrypoint }));
  child.on(errorMonitor, (error) =>
    record('error', { child: child.pid, entrypoint, code: error.code ?? null }),
  );
  child.once('exit', (code, signal) =>
    record('exit', {
      child: child.pid,
      entrypoint,
      code,
      signal,
      hex:
        typeof code === 'number'
          ? `0x${(code >>> 0).toString(16).padStart(8, '0')}`
          : null,
    }),
  );
  return child;
};
syncBuiltinESMExports();
