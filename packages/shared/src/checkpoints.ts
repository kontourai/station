import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Total size (bytes) of a file, or 0 when unreadable. */
async function fileSize(path: string): Promise<number> {
  const s = await stat(path).catch(() => null);
  return s ? s.size : 0;
}

/** Size (bytes) of a directory subtree, best-effort (0 when unreadable). */
export async function directoryDiskUsage(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  const walk = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of walk) {
    const child = join(path, entry.name);
    total += entry.isDirectory()
      ? await directoryDiskUsage(child)
      : await fileSize(child);
  }
  return total;
}

/**
 * Workspace-checkpoint primitives shared by the Station server
 * (`src-server/services/checkpoints/`) and the `station checkpoints` CLI
 * diagnostics command (station#2802).
 *
 * This module exists so the two surfaces CANNOT drift on the
 * safety-critical parts: what a legal checkpoint ref name is, where the
 * refs and their reflogs live inside the git COMMON dir, and what removing
 * a thread's checkpoints means. The server writes checkpoints through its
 * own store; the CLI only ever READS them or removes whole per-thread
 * namespaces — both through the same functions here.
 *
 * Deliberately leaf-shaped: node builtins only, no dependency on
 * src-server (the CLI bundles without the server) and no git runner of its
 * own — callers inject `execGit` (async) or run sync git themselves.
 */

/**
 * Checkpoint refs live in this pseudo-ref namespace under the git COMMON
 * dir (`.git/STATION_CHECKPOINTS/<threadId>/<checkpointId>`), deliberately
 * OUTSIDE `refs/` so no user-facing ref enumeration surfaces them — see
 * `src-server/services/checkpoints/checkpoint-ref-store.ts` for the full
 * trade (visibility vs gc reachability via the reflogs).
 */
export const CHECKPOINT_REF_ROOT = 'STATION_CHECKPOINTS';

/**
 * One path segment of a checkpoint ref name. Station-generated ids (uuids,
 * slugs) always match; anything failing this (path separators, `..`,
 * traversal, control characters, over-long ids) is rejected before it can
 * reach the filesystem or a git argv.
 */
const REF_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeCheckpointRefSegment(segment: string): boolean {
  return REF_SEGMENT_PATTERN.test(segment);
}

export const CHECKPOINT_RETENTION_DETAIL_MAX_LENGTH = 2_048;

export type CheckpointRetentionAuditEvent = {
  id: string;
  threadId: string;
  status: 'no_op' | 'reclaimed' | 'deferred' | 'failed';
  removed: number;
  recordedAt: string;
  detail?: string;
};

export type CheckpointRetentionAudit = {
  version: 1;
  events: CheckpointRetentionAuditEvent[];
};

/** Closed schema shared by the writer and the offline CLI audit reader. */
export function isCheckpointRetentionAudit(
  value: unknown,
): value is CheckpointRetentionAudit {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['version', 'events'])) {
    return false;
  }
  if (value.version !== 1 || !Array.isArray(value.events)) return false;
  return value.events.every((event) => {
    if (
      !isPlainRecord(event) ||
      !hasOnlyKeys(event, [
        'id',
        'threadId',
        'status',
        'removed',
        'recordedAt',
        'detail',
      ])
    ) {
      return false;
    }
    return (
      typeof event.id === 'string' &&
      isSafeCheckpointRefSegment(event.id) &&
      typeof event.threadId === 'string' &&
      isSafeCheckpointRefSegment(event.threadId) &&
      typeof event.status === 'string' &&
      ['no_op', 'reclaimed', 'deferred', 'failed'].includes(event.status) &&
      Number.isSafeInteger(event.removed) &&
      Number(event.removed) >= 0 &&
      typeof event.recordedAt === 'string' &&
      isCanonicalIsoTimestamp(event.recordedAt) &&
      (event.detail === undefined ||
        (typeof event.detail === 'string' &&
          event.detail.length > 0 &&
          event.detail.length <= CHECKPOINT_RETENTION_DETAIL_MAX_LENGTH))
    );
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

export function checkpointRefName(
  threadId: string,
  checkpointId: string,
): string | null {
  if (!isSafeCheckpointRefSegment(threadId)) return null;
  if (!isSafeCheckpointRefSegment(checkpointId)) return null;
  return `${CHECKPOINT_REF_ROOT}/${threadId}/${checkpointId}`;
}

/** Absolute path of a checkpoint ref file inside the git common dir. */
export function checkpointRefPath(commonDir: string, ref: string): string {
  // `ref` must already have been produced by checkpointRefName — the
  // segments are pattern-validated, so this join cannot escape the
  // station namespace.
  return join(commonDir, ref);
}

/** Directory holding one thread's checkpoint ref files (`<commonDir>/<root>/<threadId>`). */
export function threadCheckpointRefsDir(
  commonDir: string,
  threadId: string,
): string {
  return join(commonDir, CHECKPOINT_REF_ROOT, threadId);
}

/** Directory holding one thread's checkpoint reflogs (`<commonDir>/logs/<root>/<threadId>`). */
export function threadCheckpointReflogsDir(
  commonDir: string,
  threadId: string,
): string {
  return join(commonDir, 'logs', CHECKPOINT_REF_ROOT, threadId);
}

/** Checkpoint ids (ref file names) recorded for a thread, unsorted. */
export async function enumerateThreadCheckpointRefs(
  commonDir: string,
  threadId: string,
): Promise<string[]> {
  if (!isSafeCheckpointRefSegment(threadId)) return [];
  const dir = threadCheckpointRefsDir(commonDir, threadId);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

/**
 * Remove every checkpoint ref (and reflog) for a thread. Returns the number
 * of checkpoint refs removed.
 *
 * git refuses `update-ref -d` on slashed pseudo-refs ("refusing to update
 * ref with bad name"), though it happily creates them — so the removal is
 * a filesystem delete of the ref files plus their reflog directory. Paths
 * are composed from the segment-validated threadId only; a surviving
 * reflog would otherwise keep the checkpoint commits reachable until
 * reflog expiry, defeating a deliberate prune.
 */
export async function removeThreadCheckpointRefs(
  commonDir: string,
  threadId: string,
): Promise<number> {
  if (!isSafeCheckpointRefSegment(threadId)) return 0;
  const refsDir = threadCheckpointRefsDir(commonDir, threadId);
  if (!existsSync(refsDir)) return 0;
  const entries = await readdir(refsDir, { withFileTypes: true });
  const count = entries.filter((entry) => entry.isFile()).length;
  await rm(refsDir, { recursive: true, force: true });
  await rm(threadCheckpointReflogsDir(commonDir, threadId), {
    recursive: true,
    force: true,
  });
  return count;
}

/**
 * Minimal async git runner the shared helpers need.
 *
 * `input`, when set, MUST be written to the child's stdin and the stream
 * then CLOSED. Do not implement this with `execFile`: it has no `input`
 * option (that is `execFileSync`), so one passed to it is silently
 * ignored and a batch-mode git command waits forever on a stdin that
 * never ends. That exact mistake shipped twice in this feature — once in
 * the server store and once here — so implement it with `spawn` and an
 * explicit `stdin.end(input)`, plus a timeout.
 */
export type CheckpointGitRunner = (
  args: string[],
  opts: { cwd: string; input?: string },
) => Promise<{ stdout: string }>;

/**
 * Total size (bytes) of the git objects reachable ONLY from the given
 * checkpoint refs — i.e. the disk a prune of exactly these refs makes
 * reclaimable by `git gc`.
 *
 * `rev-list --objects <refs> --not --all` excludes everything reachable
 * from real refs (branches, tags, remotes), so content the user's history
 * already owns is never counted. Sizes come from one
 * `cat-file --batch-check=%(objectname) %(objectsize)` pass fed on stdin
 * (one git process, not one per object; `%(objectsize)` is logical size —
 * good enough for a reclaim estimate and available on every git). Objects
 * that vanish mid-measure (concurrent gc) print "<oid> missing" and are
 * skipped. Empty ref list → 0 without a git call.
 */
export async function measureCheckpointObjectsDiskUsage(
  runGit: CheckpointGitRunner,
  repoDir: string,
  refNames: string[],
): Promise<number> {
  if (refNames.length === 0) return 0;
  const listed = await runGit(
    ['rev-list', '--objects', ...refNames, '--not', '--all'],
    { cwd: repoDir },
  );
  const objectIds = [
    ...new Set(
      listed.stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean),
    ),
  ];
  if (objectIds.length === 0) return 0;
  const checked = await runGit(
    ['cat-file', '--batch-check=%(objectname) %(objectsize)'],
    { cwd: repoDir, input: `${objectIds.join('\n')}\n` },
  );
  let total = 0;
  for (const line of checked.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const size = Number.parseInt(parts[1], 10);
    if (Number.isFinite(size)) total += size;
  }
  return total;
}
