#!/usr/bin/env node
/**
 * self-update-watchdog — detached process spawned by the git-pull self-update
 * apply path (src-server/routes/system/system-update-routes.ts, station#1903)
 * right before the parent server exits to free the shared port. It does not
 * bind any port itself: it only polls the new server's own health endpoint
 * and records what happened, since the parent that started the restart is
 * gone by the time that answer exists.
 *
 * Invoked as: node self-update-watchdog.js '<json params>'
 * Exit 0 means the new server verified healthy; any other exit (including
 * malformed input or an internal crash) means it did not.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  emitRestartDiagnostic,
  type RestartStateWriteResult,
  restartStateFilePath,
  type SelfUpdateRestartRecord,
  writeSelfUpdateRestartRecord,
} from '../routes/system/self-update-restart-state.js';
import { runSelfUpdateWatchdog } from '../routes/system/self-update-watchdog.js';

interface SelfUpdateWatchdogRunnerInput {
  pid: number;
  port: number;
  hash: string;
  instanceId: string;
  startedAt: string;
  gitRoot: string;
  host?: string;
  deadlineMs?: number;
}

export interface WatchdogRunnerDeps {
  writeRecord?: (
    path: string,
    record: SelfUpdateRestartRecord,
  ) => RestartStateWriteResult | undefined;
  runWatchdog?: typeof runSelfUpdateWatchdog;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

function isRunnerInput(value: unknown): value is SelfUpdateWatchdogRunnerInput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const pid = v.pid;
  return (
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    typeof v.port === 'number' &&
    typeof v.hash === 'string' &&
    typeof v.instanceId === 'string' &&
    typeof v.startedAt === 'string' &&
    typeof v.gitRoot === 'string'
  );
}

/**
 * The whole runner body, injectable for tests. This process exists
 * specifically so a self-update restart never fails silently (station#1903)
 * — if IT crashes (a missing/corrupt entry file failing on launch, a
 * malformed argv, `writeRecord` hitting a disk error), that must not become
 * the one failure mode with zero trace anywhere (station#1903 review finding
 * 2). Every exit path other than a genuine verified health check writes a
 * `failed` record, best-effort, before returning a non-zero exit code.
 */
export async function runWatchdogEntrypoint(
  argv: readonly string[],
  deps: WatchdogRunnerDeps = {},
): Promise<number> {
  const writeRecord = deps.writeRecord ?? writeSelfUpdateRestartRecord;
  const runWatchdog = deps.runWatchdog ?? runSelfUpdateWatchdog;
  const logger = deps.logger ?? console;

  let parsed: SelfUpdateWatchdogRunnerInput | undefined;
  const raw = argv[2];
  try {
    const json = raw ? JSON.parse(raw) : undefined;
    if (!isRunnerInput(json)) {
      throw new Error(`malformed input: ${raw ?? '(none)'}`);
    }
    parsed = json;

    const path = restartStateFilePath(parsed.gitRoot);
    const record = await runWatchdog(
      {
        pid: parsed.pid,
        port: parsed.port,
        hash: parsed.hash,
        instanceId: parsed.instanceId,
        startedAt: parsed.startedAt,
        host: parsed.host,
        deadlineMs: parsed.deadlineMs,
      },
      {
        writeRecord: (r) => writeRecord(path, r),
        logger,
      },
    );
    return record.status === 'verified' ? 0 : 1;
  } catch {
    emitRestartDiagnostic(
      logger,
      'error',
      'self-update-watchdog: crashed before a terminal verdict',
    );
    if (parsed) {
      try {
        const crashWrite = writeRecord(restartStateFilePath(parsed.gitRoot), {
          instanceId: parsed.instanceId,
          hash: parsed.hash,
          pid: parsed.pid,
          port: parsed.port,
          startedAt: parsed.startedAt,
          status: 'failed',
          resolvedAt: new Date().toISOString(),
          failureCode: 'watchdog-crashed',
        });
        if (crashWrite?.durability === 'uncertain') {
          emitRestartDiagnostic(
            logger,
            'warn',
            'self-update-watchdog: crash verdict committed with uncertain directory durability',
          );
        }
      } catch {
        // Nothing more can be done — both the verification AND the
        // best-effort crash record failed. The record stays at whatever the
        // parent last wrote (`pending`), which self-update-boot-report.ts
        // still ages into a `stale-pending` warning at the next boot rather
        // than reading it as fine.
        emitRestartDiagnostic(
          logger,
          'error',
          'self-update-watchdog: also failed to record the crash',
        );
      }
    }
    return 1;
  }
}

// Only runs when this file is the actual entry point (`node
// self-update-watchdog.js ...`), never on import — that is what makes
// `runWatchdogEntrypoint` above unit-testable without a real spawn.
//
// Compared through `realpath` (station#3278). Node resolves an entry module's
// `import.meta.url` through symlinks while `process.argv[1]` stays the string
// it was invoked with, so a bundle spawned via any symlinked path — `/tmp`
// and `/var/folders` are both symlinks on macOS, and so is a home directory
// on plenty of installs — failed the naive comparison. The failure mode was
// the bad one: the watchdog started, did nothing, and exited 0, which reads
// as a clean run in which the process it exists to watch was not watched.
function invokedAsEntrypoint(moduleUrl: string, argv1?: string): boolean {
  if (argv1 === undefined) return false;
  if (moduleUrl === pathToFileURL(argv1).href) return true;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argv1);
  } catch {
    // An argv we cannot resolve is not this module; import-only is the safe
    // reading in both directions.
    return false;
  }
}

const isEntrypoint = invokedAsEntrypoint(import.meta.url, process.argv[1]);

if (isEntrypoint) {
  runWatchdogEntrypoint(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // runWatchdogEntrypoint already catches everything it can; this only
      // fires for something outside that boundary (e.g. `console.error`
      // itself throwing). Still never allowed to exit silently.
      console.error(
        'self-update-watchdog: unexpected top-level failure',
        error,
      );
      process.exitCode = 1;
    });
}
