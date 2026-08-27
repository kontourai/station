/**
 * `station checkpoints` — local diagnostics for workspace checkpoints
 * (station#2802 fix round, H3 part 2).
 *
 * Checkpoint objects are pinned inside the USER'S repositories' git object
 * databases by their reflogs, and `git gc` deliberately cannot reclaim
 * them for `gc.reflogExpire` days (default 90). Without this command a
 * `.git` grown to gigabytes has no discoverable cause and no supported
 * remedy: `git fsck` is silent (it walks the reflogs), `git count-objects`
 * names no culprit. This surface makes the space DISCOVERABLE (`status`
 * reports per-thread disk usage across every project the home has
 * checkpointed) and RECLAIMABLE (`prune` removes a thread's refs and
 * reflogs, optionally running the gc that then actually frees the space).
 *
 * Deliberately LOCAL (no running Station required — the user staring at a
 * 40 GB `.git` may well have stopped it): reads the Station home's
 * per-thread index files directly and shells out to git. Shares the
 * safety-critical ref enumeration/removal with the server through
 * `@kontourai/station-shared/checkpoints`, so the two cannot drift on what
 * a legal checkpoint namespace is or what removing one means.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type CheckpointGitRunner,
  enumerateThreadCheckpointRefs,
  isCheckpointRetentionAudit,
  isSafeCheckpointRefSegment,
  measureCheckpointObjectsDiskUsage,
  removeThreadCheckpointRefs,
} from '@kontourai/station-shared/checkpoints';
import {
  admitStationRuntimeHome,
  resolveRuntimeHome,
} from '@kontourai/station-shared/runtime-path-resolver';

const execFileAsync = promisify(execFile);

/** Index record shapes this command reads (see checkpoint-index-store.ts). */
interface IndexTurnPhase {
  status: string;
  repoRoot?: string;
}
interface IndexTurnRecord {
  threadId?: string;
  updatedAt?: string;
  baseline?: IndexTurnPhase;
  settle?: IndexTurnPhase;
}

export interface CheckpointsCommandDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  runGit?: CheckpointGitRunner;
  fetch?: typeof fetch;
}

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  delete scrubbed.GIT_DIR;
  delete scrubbed.GIT_WORK_TREE;
  return scrubbed;
}

const CLI_GIT_TIMEOUT_MS = 60_000;

function defaultRunner(env: NodeJS.ProcessEnv): CheckpointGitRunner {
  return async (args, opts) => {
    // `execFile` has NO `input` option (that is `execFileSync`), so a batch
    // git command driven through it waits forever on a stdin nothing closes.
    // Spawn and drive stdin explicitly whenever there is input to send.
    if (opts.input === undefined) {
      const { stdout } = await execFileAsync('git', args, {
        cwd: opts.cwd,
        encoding: 'utf-8',
        windowsHide: true,
        env: gitEnv(env),
        timeout: CLI_GIT_TIMEOUT_MS,
      });
      return { stdout };
    }
    return await new Promise<{ stdout: string }>((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: opts.cwd,
        windowsHide: true,
        env: gitEnv(env),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let out = '';
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        settle(() =>
          reject(
            new Error(`git ${args[0]} timed out after ${CLI_GIT_TIMEOUT_MS}ms`),
          ),
        );
      }, CLI_GIT_TIMEOUT_MS);
      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });
      child.on('error', (error) => settle(() => reject(error)));
      child.on('close', (code) =>
        settle(() =>
          code === 0
            ? resolve({ stdout: out })
            : reject(new Error(`git ${args[0]} exited ${String(code)}`)),
        ),
      );
      child.stdin?.on('error', (error) => settle(() => reject(error)));
      child.stdin?.end(opts.input);
    });
  };
}

function resolveStationHome(env: NodeJS.ProcessEnv): string {
  const home = resolveRuntimeHome(env);
  admitStationRuntimeHome(home, env);
  return home;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

interface ThreadStatus {
  threadId: string;
  repos: Array<{
    repoRoot: string;
    checkpoints: number;
    reclaimableBytes: number;
  }>;
  turns: number;
  lastUpdatedAt?: string;
  error?: string;
}

/** Read the per-thread index files under `<home>/turn-checkpoints/`. */
function readIndexThreads(home: string): Map<string, IndexTurnRecord[]> {
  const threads = new Map<string, IndexTurnRecord[]>();
  // Read every eviction generation before the active index. Reactivation can
  // add checkpoints in other repositories, so all generations are a union:
  // no single active document is allowed to erase older discovery evidence.
  for (const name of ['turn-checkpoints-evicted', 'turn-checkpoints']) {
    const dir = join(home, name);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const fileThreadId = entry.slice(0, -'.json'.length);
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf-8')) as {
          version?: number;
          turns?: Record<string, IndexTurnRecord>;
        };
        if (parsed.version !== 1 || !parsed.turns) continue;
        const records = Object.values(parsed.turns);
        const threadId =
          records.find((record) => record.threadId)?.threadId ?? fileThreadId;
        if (!isSafeCheckpointRefSegment(threadId)) continue;
        threads.set(threadId, [...(threads.get(threadId) ?? []), ...records]);
      } catch {
        // A corrupt active file cannot erase valid archived generations.
        // A corrupt generation has no trustworthy thread identity and is
        // skipped; intact siblings still keep their refs discoverable.
        if (name === 'turn-checkpoints' && !threads.has(fileThreadId)) {
          threads.set(fileThreadId, []);
        }
      }
    }
  }
  return threads;
}

async function resolveCommonDir(
  runGit: CheckpointGitRunner,
  repoRoot: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: repoRoot },
    );
    const dir = stdout.trim();
    return dir || undefined;
  } catch {
    return undefined;
  }
}

async function collectStatus(
  home: string,
  runGit: CheckpointGitRunner,
): Promise<ThreadStatus[]> {
  const threads = readIndexThreads(home);
  const commonDirs = new Map<string, string | undefined>();
  const statuses: ThreadStatus[] = [];
  for (const [threadId, turns] of threads) {
    const status: ThreadStatus = {
      threadId,
      repos: [],
      turns: turns.length,
      lastUpdatedAt: turns
        .map((turn) => turn.updatedAt ?? '')
        .sort()
        .at(-1),
    };
    const repoRoots = new Set<string>();
    for (const turn of turns) {
      for (const phase of [turn.baseline, turn.settle]) {
        if (phase?.status === 'captured' && phase.repoRoot) {
          repoRoots.add(phase.repoRoot);
        }
      }
    }
    for (const repoRoot of repoRoots) {
      let commonDir = commonDirs.get(repoRoot);
      if (!commonDirs.has(repoRoot)) {
        commonDir = await resolveCommonDir(runGit, repoRoot);
        commonDirs.set(repoRoot, commonDir);
      }
      if (!commonDir) {
        status.error = `repository unreachable: ${repoRoot}`;
        continue;
      }
      const ids = await enumerateThreadCheckpointRefs(commonDir, threadId);
      const refs = ids.map(
        (checkpointId) => `STATION_CHECKPOINTS/${threadId}/${checkpointId}`,
      );
      const reclaimableBytes = await measureCheckpointObjectsDiskUsage(
        runGit,
        repoRoot,
        refs,
      );
      status.repos.push({
        repoRoot,
        checkpoints: ids.length,
        reclaimableBytes,
      });
    }
    statuses.push(status);
  }
  statuses.sort((a, b) => b.threadId.localeCompare(a.threadId));
  return statuses;
}

function printStatusHuman(
  out: (line: string) => void,
  statuses: ThreadStatus[],
  home: string,
): void {
  out(`Workspace checkpoints (index: ${join(home, 'turn-checkpoints')})`);
  if (statuses.length === 0) {
    // Say what was computed, not what was inferred. This branch means the
    // active and archived discovery directories are empty — it is NOT a
    // statement about refs on disk.
    out('No threads in the checkpoint index. Capture runs only when the');
    out("'workspaceCheckpoints' setting is on (it is off by default).");
    out('This lists threads retained in active or archived discovery only.');
    return;
  }
  for (const status of statuses) {
    out('');
    out(`thread ${status.threadId} — ${status.turns} indexed turn(s)`);
    if (status.error) out(`  ! ${status.error}`);
    for (const repo of status.repos) {
      out(
        `  ${repo.checkpoints} checkpoint(s) in ${repo.repoRoot}: ~${formatBytes(repo.reclaimableBytes)} reclaimable`,
      );
    }
    if (status.repos.length === 0 && !status.error) {
      // Computed: this thread's index records name no repoRoot. That is not
      // the same as "no refs exist" — a corrupt thread file reaches here too.
      out('  no repository recorded for this thread in the index');
    }
  }
  const total = statuses.reduce(
    (sum, status) =>
      sum + status.repos.reduce((s, repo) => s + repo.reclaimableBytes, 0),
    0,
  );
  out('');
  out(`Total reclaimable: ~${formatBytes(total)}`);
  out('Checkpoint objects are pinned against `git gc` by their reflogs');
  out('(gc.reflogExpire, default 90 days). Reclaim now with:');
  out('  station checkpoints prune --all --gc');
}

export async function runCheckpointsCommand(
  rawArgs: string[],
  deps: CheckpointsCommandDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));
  const runGit = deps.runGit ?? defaultRunner(env);
  const home = resolveStationHome(env);
  const json = rawArgs.includes('--json');
  const sub = rawArgs.find((arg) => !arg.startsWith('--'));

  if (sub === 'status' || sub === undefined) {
    const statuses = await collectStatus(home, runGit);
    if (json) {
      out(JSON.stringify({ home, threads: statuses }, null, 2));
    } else {
      printStatusHuman(out, statuses, home);
    }
    return;
  }

  if (sub === 'prune') {
    const threadFlag = rawArgs.find((arg) => arg.startsWith('--thread='));
    const all = rawArgs.includes('--all');
    const gc = rawArgs.includes('--gc');
    if (!threadFlag && !all) {
      err('station checkpoints prune requires --thread=<threadId> or --all');
      process.exitCode = 1;
      return;
    }
    const threads = readIndexThreads(home);
    // A raw --thread= value reaches a delete path; every other consumer of a
    // threadId in this feature goes through the same segment guard, and this
    // one must too. Without it `--thread=../../x` escapes the home directory.
    if (threadFlag) {
      const requested = threadFlag.slice('--thread='.length);
      if (!isSafeCheckpointRefSegment(requested)) {
        err(`station checkpoints prune: invalid --thread value ${requested}`);
        process.exitCode = 1;
        return;
      }
    }
    const targets = threadFlag
      ? [threadFlag.slice('--thread='.length)]
      : [...threads.keys()];
    let removedTotal = 0;
    const pruned: Array<{ threadId: string; refs: number; repos: string[] }> =
      [];
    for (const threadId of targets) {
      const turns = threads.get(threadId) ?? [];
      const repoRoots = new Set<string>();
      for (const turn of turns) {
        for (const phase of [turn.baseline, turn.settle]) {
          if (phase?.status === 'captured' && phase.repoRoot) {
            repoRoots.add(phase.repoRoot);
          }
        }
      }
      let removed = 0;
      const repos: string[] = [];
      let discoveryCanBeRemoved = true;
      for (const repoRoot of repoRoots) {
        const commonDir = await resolveCommonDir(runGit, repoRoot);
        if (!commonDir) {
          err(`skipping ${repoRoot}: repository unreachable`);
          discoveryCanBeRemoved = false;
          continue;
        }
        try {
          removed += await removeThreadCheckpointRefs(commonDir, threadId);
        } catch (error) {
          discoveryCanBeRemoved = false;
          err(
            `keeping discovery for ${threadId}: prune failed in ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        if (gc && removed > 0) {
          try {
            await runGit(['gc', '--prune=now', '--quiet'], { cwd: repoRoot });
          } catch (error) {
            err(
              `refs removed from ${repoRoot} but gc failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        repos.push(repoRoot);
      }
      // The index file for a pruned thread describes checkpoints that no
      // longer exist; remove it too (the refs were the truth).
      if (discoveryCanBeRemoved) {
        rmSync(join(home, 'turn-checkpoints', `${threadId}.json`), {
          force: true,
        });
        const archiveDir = join(home, 'turn-checkpoints-evicted');
        if (existsSync(archiveDir)) {
          for (const entry of readdirSync(archiveDir)) {
            const archivePath = join(archiveDir, entry);
            let belongsToThread = entry === `${threadId}.json`;
            if (!belongsToThread && entry.endsWith('.json')) {
              try {
                const parsed = JSON.parse(
                  readFileSync(archivePath, 'utf-8'),
                ) as {
                  turns?: Record<string, IndexTurnRecord>;
                };
                belongsToThread = Object.values(parsed.turns ?? {}).some(
                  (record) => record.threadId === threadId,
                );
              } catch {
                // Fail closed: an unreadable generation may still be the only
                // discovery evidence for a different thread with this prefix.
              }
            }
            if (belongsToThread) rmSync(archivePath, { force: true });
          }
        }
      }
      removedTotal += removed;
      pruned.push({ threadId, refs: removed, repos });
    }
    if (json) {
      out(JSON.stringify({ pruned, refsRemoved: removedTotal }, null, 2));
      return;
    }
    for (const entry of pruned) {
      if (entry.refs === 0 && entry.repos.length === 0) {
        out(`thread ${entry.threadId}: nothing to prune`);
        continue;
      }
      out(
        `thread ${entry.threadId}: removed ${entry.refs} checkpoint ref(s)${gc ? ' and ran git gc' : ''}`,
      );
      for (const repo of entry.repos) out(`  ${repo}`);
      if (!gc && entry.refs > 0) {
        out(
          '  run `git gc --prune=now` in each repo (or re-run with --gc) to free the space',
        );
      }
    }
    return;
  }

  if (sub === 'history') {
    const thread = rawArgs
      .find((arg) => arg.startsWith('--thread='))
      ?.slice('--thread='.length);
    if (!thread || !isSafeCheckpointRefSegment(thread)) {
      err('station checkpoints history requires --thread=<threadId>');
      process.exitCode = 1;
      return;
    }
    let events: unknown[] = [];
    try {
      const parsed = JSON.parse(
        readFileSync(join(home, 'checkpoint-restores.json'), 'utf-8'),
      ) as { events?: Array<{ threadId?: string }> };
      events = (parsed.events ?? []).filter(
        (event) => event.threadId === thread,
      );
    } catch {}
    if (json) out(JSON.stringify({ threadId: thread, events }, null, 2));
    else if (events.length === 0)
      out(`thread ${thread}: no checkpoint restores recorded`);
    else for (const event of events) out(JSON.stringify(event));
    return;
  }

  if (sub === 'retention') {
    const thread = rawArgs
      .find((arg) => arg.startsWith('--thread='))
      ?.slice('--thread='.length);
    if (!thread || !isSafeCheckpointRefSegment(thread)) {
      err('station checkpoints retention requires --thread=<threadId>');
      process.exitCode = 1;
      return;
    }
    let events: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(home, 'checkpoint-retention.json'), 'utf-8'),
      );
      if (!isCheckpointRetentionAudit(parsed)) {
        throw new Error('invalid retention audit schema');
      }
      events = parsed.events.filter((event) => event.threadId === thread);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        err(
          `station checkpoints retention: audit unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
        return;
      }
    }
    if (json) out(JSON.stringify({ threadId: thread, events }, null, 2));
    else if (events.length === 0)
      out(`thread ${thread}: no checkpoint retention sweeps recorded`);
    else for (const event of events) out(JSON.stringify(event));
    return;
  }

  if (sub === 'restore') {
    const thread = rawArgs
      .find((arg) => arg.startsWith('--thread='))
      ?.slice('--thread='.length);
    const turn = rawArgs
      .find((arg) => arg.startsWith('--turn='))
      ?.slice('--turn='.length);
    const phase =
      rawArgs
        .find((arg) => arg.startsWith('--phase='))
        ?.slice('--phase='.length) ?? 'settle';
    const apiBase =
      rawArgs
        .find((arg) => arg.startsWith('--api-base='))
        ?.slice('--api-base='.length) ?? 'http://127.0.0.1:3141';
    if (
      !thread ||
      !turn ||
      !isSafeCheckpointRefSegment(thread) ||
      !isSafeCheckpointRefSegment(turn) ||
      !['baseline', 'settle'].includes(phase)
    ) {
      err(
        'station checkpoints restore requires safe --thread=<id> --turn=<id> [--phase=baseline|settle]',
      );
      process.exitCode = 1;
      return;
    }
    if (!rawArgs.includes('--confirm')) {
      err('station checkpoints restore is destructive and requires --confirm');
      process.exitCode = 1;
      return;
    }
    const response = await (deps.fetch ?? fetch)(
      `${apiBase.replace(/\/$/, '')}/api/orchestration/sessions/${encodeURIComponent(thread)}/checkpoints/${encodeURIComponent(turn)}/restore`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, phase }),
      },
    );
    const body = await response.json();
    if (!response.ok) {
      err(
        `station checkpoints restore failed (${response.status}): ${JSON.stringify(body)}`,
      );
      process.exitCode = 1;
      return;
    }
    out(
      json
        ? JSON.stringify(body, null, 2)
        : `restored thread ${thread} to turn ${turn} (${phase})`,
    );
    return;
  }

  err(`Unknown checkpoints action: ${sub}`);
  err('Valid actions: status, prune, history, retention, restore');
  process.exitCode = 1;
}
