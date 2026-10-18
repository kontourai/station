/**
 * Supervisor process entry:
 *
 *   node station-supervisor.js --entry <core entry> --home <dir> --instance <id>
 *     [--build-root <dir>] [--control <path>]
 *
 * `--control` defaults to the endpoint derived from home and instance, which
 * is what clients derive too. Tuning flags exist for operators and tests.
 */
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createEntryBoundary } from './entry-boundary.ts';
import {
  breakInstanceLock,
  breakLockCommandFor,
  SupervisorStartError,
} from './instance-lock.ts';
import {
  type ControlEndpoint,
  isValidInstanceId,
  resolveControlEndpoint,
  unixSocketPathLimit,
} from './protocol.ts';
import { runSupervisor } from './supervisor.ts';

const DURATION_FLAGS = {
  'park-timeout-ms': ['handoff', 'parkTimeoutMs'],
  'readiness-timeout-ms': ['handoff', 'readinessTimeoutMs'],
  'drain-deadline-ms': ['handoff', 'drainDeadlineMs'],
  'kill-grace-ms': ['handoff', 'killGraceMs'],
  'commit-grace-ms': ['handoff', 'commitGraceMs'],
  'stop-drain-cap-ms': ['handoff', 'stopDrainCapMs'],
  'restart-backoff-ms': ['restart', 'initialBackoffMs'],
  'restart-max-backoff-ms': ['restart', 'maxBackoffMs'],
  'restart-stable-ms': ['restart', 'stableAfterMs'],
  'restart-window-ms': ['restart', 'failureWindowMs'],
  'restart-max-failures': ['restart', 'maxFailures'],
  'lock-pending-grace-ms': ['lock', 'pendingGraceMs'],
} as const;

const MAX_FLAG_VALUE = 24 * 60 * 60_000;

const USAGE = [
  'usage: station-supervisor --entry <core entry> --home <dir> --instance <id>',
  '         [--build-root <dir>] [--control <path>] [--<tuning flag> <ms>]',
  '',
  '  --entry        core server entry for the first generation (.js or .mjs)',
  '  --home         Station home; the control socket and token live in <home>/run',
  '  --instance     instance id',
  "  --build-root   handoff entries must be inside this directory (default: the entry's directory)",
  '  --control      control socket path (default: derived from --home and --instance)',
  '',
  'usage: station-supervisor --break-lock --home <dir> --instance <id> [--force] [--reason <text>]',
  '  Marks a stuck instance lock released. Refuses while the holder is a running',
  '  supervisor; asks for --force when the holder cannot be verified.',
  `  tuning flags:  ${Object.keys(DURATION_FLAGS)
    .map((flag) => `--${flag}`)
    .join(', ')}`,
].join('\n');

function fail(message: string, withUsage = false): never {
  process.stderr.write(
    `station-supervisor: ${message}\n${withUsage ? `${USAGE}\n` : ''}`,
  );
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

function parseCommandLine(): Record<string, string | boolean | undefined> {
  try {
    return parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        'break-lock': { type: 'boolean' },
        force: { type: 'boolean' },
        reason: { type: 'string' },
        entry: { type: 'string' },
        home: { type: 'string' },
        instance: { type: 'string' },
        control: { type: 'string' },
        'build-root': { type: 'string' },
        ...Object.fromEntries(
          Object.keys(DURATION_FLAGS).map((flag) => [
            flag,
            { type: 'string' as const },
          ]),
        ),
      },
      strict: true,
    }).values;
  } catch (error) {
    // parseArgs explains the problem in its message; no stack trace for a typo.
    const message = error instanceof Error ? error.message : String(error);
    fail(
      message.replace(/^Unknown option/, 'unknown option').split('. ')[0] ??
        message,
      true,
    );
  }
}

async function main(): Promise<void> {
  const parsed = parseCommandLine();
  if (parsed.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (parsed['break-lock'] === true) {
    const home = parsed.home;
    const instance = parsed.instance;
    if (typeof home !== 'string' || typeof instance !== 'string') {
      fail('--break-lock needs --home and --instance', true);
    }
    if (!isValidInstanceId(instance)) fail(`invalid --instance: ${instance}`);
    const runDir = dirname(
      resolveControlEndpoint({ home, instance }).tokenPath,
    );
    const result = await breakInstanceLock({
      runDir,
      instance,
      force: parsed.force === true,
      reason:
        typeof parsed.reason === 'string'
          ? parsed.reason
          : 'operator break-lock',
      breakLockCommand: breakLockCommandFor(resolve(home), instance),
    });
    (result.code === 0 ? process.stdout : process.stderr).write(
      `station-supervisor: ${result.message}\n`,
    );
    process.exit(result.code);
  }
  const raw = parsed as Record<string, string | undefined>;
  if (!raw.entry || !raw.home || !raw.instance) {
    fail('--entry, --home, and --instance are required', true);
  }
  if (!isValidInstanceId(raw.instance))
    fail(`invalid --instance: ${raw.instance}`);
  let initialEntry: string;
  try {
    initialEntry = realpathSync(resolve(raw.entry));
  } catch {
    fail(`--entry not found: ${raw.entry}`);
  }
  // Default: the directory holding the initial entry.
  const buildRoot = resolve(raw['build-root'] ?? dirname(initialEntry));
  let boundary: ReturnType<typeof createEntryBoundary>;
  try {
    boundary = createEntryBoundary(buildRoot);
  } catch {
    fail(`--build-root not found: ${buildRoot}`);
  }
  const checked = boundary(initialEntry);
  if ('refused' in checked) {
    fail(
      `--entry must be a .js or .mjs file inside --build-root ${buildRoot}: ${raw.entry}`,
    );
  }
  const entry = checked.entry;

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
    // The socket is bound at a private name beside it (`.s` + 6 hex digits)
    // and published with link(); that name must fit sun_path too.
    if (
      process.platform !== 'win32' &&
      Buffer.byteLength(join(dirname(resolve(raw.control)), '.sXXXXXX')) >
        unixSocketPathLimit(process.platform)
    ) {
      fail(
        `--control directory is too long for the socket's private bind name: ${raw.control}`,
      );
    }
    endpoint = { ...derived, path: raw.control, fallbackDir: null };
  }

  const handoff: Record<string, number> = {};
  const restart: Record<string, number> = {};
  let lockPendingGraceMs: number | undefined;
  for (const [flag, [group, key]] of Object.entries(DURATION_FLAGS)) {
    const value = raw[flag];
    if (value === undefined) continue;
    const parsed = parsePositiveInteger(flag, value);
    if (group === 'lock') lockPendingGraceMs = parsed;
    else (group === 'handoff' ? handoff : restart)[key] = parsed;
  }

  await runSupervisor({
    entry,
    buildRoot,
    endpoint,
    instance: raw.instance,
    handoff,
    restart,
    lockPendingGraceMs,
  });
}

main().catch((error: unknown) => {
  if (error instanceof SupervisorStartError) {
    process.stderr.write(`station-supervisor: ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `station-supervisor: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
