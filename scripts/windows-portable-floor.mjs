#!/usr/bin/env node
/**
 * The Windows portable floor's Vitest run (`npm run test:windows:portable`).
 *
 *   node scripts/windows-portable-floor.mjs <vitest options and files...>
 *
 * Each terminal process suite (`src-server/services/terminal/__tests__/`,
 * `*.process.test.ts` or `*.real.test.ts`) runs in a Vitest invocation of its
 * own, after one invocation for every other file. A forked Vitest worker on
 * Windows has exited without a word at most once in three hosted runs, each
 * time under a different terminal suite (#3994: runs 41973735929 and
 * 42017221712), and once in four local ones; the cause is not found. In one
 * invocation that hid the results of every file the dead worker would have
 * run. Every invocation runs whatever the others did,
 * and the floor fails when any one fails, crashes, is signalled or cannot
 * start: isolation keeps each suite's verdict visible, it never retries one.
 *
 * Crash evidence (#4626): each invocation records how every Vitest worker
 * ended (`lib/floor-worker-exits.mjs`) and writes a Node report on a fatal
 * error. When an invocation fails, that evidence and the Windows Application
 * log's crash entries since it started are kept under
 * `.kontourai/verification-output/windows-portable-floor/`, which the hosted
 * job uploads; a passing invocation keeps nothing.
 */
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const WORKER_EXITS = resolve(import.meta.dirname, 'lib/floor-worker-exits.mjs');
const EVENT_PROVIDERS = [
  'Application Error',
  'Windows Error Reporting',
  'Application Hang',
  '.NET Runtime',
];

/**
 * The Application log's crash entries since `since`: the faulting module
 * and exception code of a native crash (event 1000) and WER's report (1001).
 */
export function applicationCrashEvents(
  since,
  { run = execFileSyncBounded } = {},
) {
  const script = [
    `$since = [datetime]::Parse('${since.toISOString()}').ToLocalTime()`,
    `$providers = @(${EVENT_PROVIDERS.map((name) => `'${name}'`).join(', ')})`,
    // Get-WinEvent fails when nothing matches; no entry is an empty list.
    "$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -ErrorAction SilentlyContinue |",
    '  Where-Object { $providers -contains $_.ProviderName } |',
    "  Select-Object @{ n = 'time'; e = { $_.TimeCreated.ToUniversalTime().ToString('o') } }, Id, ProviderName, Message)",
    'ConvertTo-Json -InputObject $events -Depth 3',
    'exit 0',
  ].join('\n');
  try {
    const text = String(
      run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 120_000, windowsHide: true },
      ),
    ).trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    return [{ error: String(error?.message ?? error) }];
  }
}

/** A directory name for an invocation: its order and its first file. */
function evidenceName(index, files) {
  const first = (files[0] ?? 'files').split('/').at(-1);
  return `${String(index + 1).padStart(2, '0')}-${first.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function readWorkerExits(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const ISOLATED_SUITE =
  /^src-server\/services\/terminal\/__tests__\/[^/]+\.(?:process|real)\.test\.ts$/;

/**
 * The invocations for one floor run: every file that is not an isolated
 * terminal suite together, then each isolated suite alone, each with the
 * given options.
 */
export function planFloorInvocations(args) {
  const options = args.filter((arg) => arg.startsWith('-'));
  const files = args.filter((arg) => !arg.startsWith('-') && arg !== 'run');
  if (files.length === 0) throw new Error('the floor names no test files');
  const isolated = files.filter((file) => ISOLATED_SUITE.test(file));
  const shared = files.filter((file) => !ISOLATED_SUITE.test(file));
  return [
    ...(shared.length ? [shared] : []),
    ...isolated.map((file) => [file]),
  ].map((group) => ['run', ...group, ...options]);
}

/**
 * Runs every invocation in order and returns each one's outcome; a failure
 * never stops the ones after it.
 * @param {string[][]} invocations
 * @param {object} options
 * @param {string} options.root
 * @param {(command: string, args: string[], options: import('node:child_process').SpawnSyncOptions) => Pick<import('node:child_process').SpawnSyncReturns<Buffer>, 'status' | 'signal' | 'error'>} [options.spawnSync]
 * @param {(message: string) => void} [options.log]
 */
export function runFloorInvocations(
  invocations,
  {
    root,
    spawnSync = defaultSpawnSync,
    log = console.log,
    crashEvents = applicationCrashEvents,
    platform = process.platform,
    evidenceRoot = join(
      root,
      '.kontourai',
      'verification-output',
      'windows-portable-floor',
    ),
  },
) {
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const observer = pathToFileURL(
    join(root, 'scripts', 'lib', 'windows-worker-diagnostics.mjs'),
  ).href;
  return invocations.map((args, index) => {
    const files = args.filter((arg) => arg !== 'run' && !arg.startsWith('-'));
    log(`\n[windows-portable-floor] vitest ${files.join(' ')}`);
    const evidence = join(evidenceRoot, evidenceName(index, files));
    rmSync(evidence, { recursive: true, force: true });
    mkdirSync(evidence, { recursive: true });
    const workerExits = join(evidence, 'worker-exits.jsonl');
    const started = new Date();
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(WORKER_EXITS).href,
        '--import',
        observer,
        vitest,
        ...args,
      ],
      {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
        env: {
          ...process.env,
          STATION_FLOOR_WORKER_EXIT_LOG: workerExits,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            '--report-on-fatalerror',
            `--report-directory=${JSON.stringify(evidence)}`,
          ]
            .filter(Boolean)
            .join(' '),
        },
      },
    );
    const outcome = {
      files,
      status: result.status ?? null,
      signal: result.signal ?? null,
      error: result.error ? String(result.error.message ?? result.error) : null,
      passed: result.status === 0 && !result.signal && !result.error,
    };
    if (outcome.passed) {
      rmSync(evidence, { recursive: true, force: true });
      return outcome;
    }
    const workers = readWorkerExits(workerExits);
    // A worker Vitest stopped (`stopRequestedAt`) ended normally, whatever its
    // signal; one that exited before that, other than cleanly, died.
    const abnormal = workers.filter(
      (worker) =>
        !worker.stopRequestedAt &&
        (worker.code !== 0 || worker.signal !== null),
    );
    const summary = {
      ...outcome,
      startedAt: started.toISOString(),
      endedAt: new Date().toISOString(),
      workers,
      reports: readdirSync(evidence).filter((name) =>
        name.startsWith('report.'),
      ),
      applicationEvents: platform === 'win32' ? crashEvents(started) : [],
    };
    writeFileSync(
      join(evidence, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    const ended = abnormal
      .map(
        (worker) =>
          `pid ${worker.pid} ${worker.signal ? `signal ${worker.signal}` : `exit ${worker.code}`}`,
      )
      .join(', ');
    log(
      `[windows-portable-floor] evidence in ${evidence}: ${abnormal.length} worker(s) exited before Vitest stopped them${ended ? ` (${ended})` : ''}, ${summary.reports.length} Node report(s), ${summary.applicationEvents.length} Application log entr(ies)`,
    );
    return outcome;
  });
}

/** The summary line for each failed invocation; empty when all passed. */
export function floorFailures(outcomes) {
  return outcomes
    .filter((outcome) => !outcome.passed)
    .map(
      (outcome) =>
        `${outcome.files.join(' ')}: ${
          outcome.error ??
          (outcome.signal
            ? `signal ${outcome.signal}`
            : `exit ${outcome.status}`)
        }`,
    );
}

if (invokedDirectly(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..');
  const outcomes = runFloorInvocations(
    planFloorInvocations(process.argv.slice(2)),
    { root },
  );
  const failures = floorFailures(outcomes);
  if (failures.length) {
    console.error(
      `\n[windows-portable-floor] ${failures.length} of ${outcomes.length} Vitest invocation(s) failed:\n  ${failures.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log(
    `\n[windows-portable-floor] all ${outcomes.length} Vitest invocation(s) passed`,
  );
}
