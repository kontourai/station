/**
 * Supervisor process entry:
 *
 *   node station-supervisor.js --entry <core entry> --home <dir> --instance <id> [--control <path>]
 *
 * `--control` defaults to the endpoint derived from home and instance, which
 * is what clients derive too. Tuning flags exist for operators and tests.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type ControlEndpoint,
  isValidInstanceId,
  resolveControlEndpoint,
  unixSocketPathLimit,
} from './protocol.ts';
import { runSupervisor, validateEntry } from './supervisor.ts';

const DURATION_FLAGS = {
  'park-timeout-ms': ['handoff', 'parkTimeoutMs'],
  'readiness-timeout-ms': ['handoff', 'readinessTimeoutMs'],
  'drain-deadline-ms': ['handoff', 'drainDeadlineMs'],
  'kill-grace-ms': ['handoff', 'killGraceMs'],
  'restart-backoff-ms': ['restart', 'initialBackoffMs'],
  'restart-max-backoff-ms': ['restart', 'maxBackoffMs'],
  'restart-stable-ms': ['restart', 'stableAfterMs'],
  'restart-window-ms': ['restart', 'failureWindowMs'],
  'restart-max-failures': ['restart', 'maxFailures'],
} as const;

const MAX_FLAG_VALUE = 24 * 60 * 60_000;

function fail(message: string): never {
  process.stderr.write(`station-supervisor: ${message}\n`);
  process.exit(2);
}

function parsePositiveInteger(flag: string, raw: string): number {
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_FLAG_VALUE
  ) {
    fail(`--${flag} must be an integer in 1..${MAX_FLAG_VALUE}`);
  }
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      entry: { type: 'string' },
      home: { type: 'string' },
      instance: { type: 'string' },
      control: { type: 'string' },
      ...Object.fromEntries(
        Object.keys(DURATION_FLAGS).map((flag) => [
          flag,
          { type: 'string' as const },
        ]),
      ),
    },
    strict: true,
  });
  const raw = values as Record<string, string | undefined>;
  if (!raw.entry || !raw.home || !raw.instance) {
    fail(
      'usage: --entry <core entry> --home <dir> --instance <id> [--control <path>]',
    );
  }
  if (!isValidInstanceId(raw.instance))
    fail(`invalid --instance: ${raw.instance}`);
  const entry = resolve(raw.entry);
  const invalidEntry = validateEntry(entry);
  if (invalidEntry) fail(`--entry ${entry}: ${invalidEntry}`);

  const derived = resolveControlEndpoint({
    home: raw.home,
    instance: raw.instance,
  });
  let endpoint: ControlEndpoint = derived;
  if (raw.control) {
    if (
      process.platform !== 'win32' &&
      Buffer.byteLength(raw.control) > unixSocketPathLimit(process.platform)
    ) {
      fail(`--control path exceeds the socket path limit: ${raw.control}`);
    }
    endpoint = { ...derived, path: raw.control, fallbackDir: null };
  }

  const handoff: Record<string, number> = {};
  const restart: Record<string, number> = {};
  for (const [flag, [group, key]] of Object.entries(DURATION_FLAGS)) {
    const value = raw[flag];
    if (value === undefined) continue;
    (group === 'handoff' ? handoff : restart)[key] = parsePositiveInteger(
      flag,
      value,
    );
  }

  await runSupervisor({
    entry,
    endpoint,
    instance: raw.instance,
    handoff,
    restart,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `station-supervisor: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
