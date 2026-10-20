/**
 * The files and environment of the fixed service launcher's protocol (#2675
 * slice D; the launcher is packaging/portable-server/bin/station-launcher.mjs,
 * the versioned child's half is packages/cli/src/commands/service-launcher-link.ts).
 *
 * The server is a detached grandchild of the launcher with no channel to it,
 * so it takes part through files in `<install root>/runtime/`: it queues an
 * update as `update-request.json`, and reads how that went from
 * `update-request-result.json` (a request that ended before any trial,
 * written by the child) and `service-state.json` (everything after the
 * launcher accepted it, written by the launcher). Both the CLI and the server
 * read and write these through this module.
 *
 * Stage and apply (#3851 slice 4). A request's `mode` splits the one update
 * into two steps the server asks for separately: `stage` downloads and
 * verifies a version into the install and ends `staged` (written to the
 * result file) with the running server untouched; `apply` hands a staged
 * version to the launcher's trial and never downloads. A request without a
 * mode does both, as it always has: install.sh (`station upgrade`) and
 * clients older than #3851 write those. The launcher itself is unchanged:
 * it is frozen at `service install`, so the split lives entirely in the
 * versioned child and these files, and an already installed launcher keeps
 * working. While staging, the child records the installer's reported step
 * and the bytes downloaded so far in `update-stage-progress.json`.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  ServiceStagePhase,
  ServiceUpdateIntent,
  ServiceUpdatePhase,
  ServiceUpdateProgress,
} from '@kontourai/station-contracts/system-status';

/**
 * Names the launcher's context on the process it started (`service run`),
 * and, from there, on the server that supervisor spawns: the only processes
 * the context describes. Every other child environment drops it.
 */
export const SERVICE_LAUNCHER_ENV = 'STATION_SERVICE_LAUNCHER';
export const SERVICE_LAUNCHER_PROTOCOL = 1;

export interface ServiceLauncherContext {
  protocol: typeof SERVICE_LAUNCHER_PROTOCOL;
  installRoot: string;
  version: string;
  role: 'active' | 'trial';
  updateId?: string;
}

export function readServiceLauncherContext(
  env: NodeJS.ProcessEnv = process.env,
): ServiceLauncherContext | null {
  const raw = env[SERVICE_LAUNCHER_ENV];
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ServiceLauncherContext>;
    if (
      value.protocol !== SERVICE_LAUNCHER_PROTOCOL ||
      typeof value.installRoot !== 'string' ||
      typeof value.version !== 'string' ||
      (value.role !== 'active' && value.role !== 'trial') ||
      (value.updateId !== undefined && typeof value.updateId !== 'string')
    )
      return null;
    return value as ServiceLauncherContext;
  } catch {
    return null;
  }
}

export function serviceUpdatePaths(installRoot: string) {
  const runtime = join(installRoot, 'runtime');
  return {
    runtime,
    request: join(runtime, 'update-request.json'),
    processing: join(runtime, 'update-request.processing.json'),
    result: join(runtime, 'update-request-result.json'),
    stageProgress: join(runtime, 'update-stage-progress.json'),
    state: join(runtime, 'service-state.json'),
  };
}

/** What a request asks for; absent is the combined update (see the header). */
export type ServiceUpdateRequestMode = 'stage' | 'apply';

export interface ServiceUpdateRequest {
  id: string;
  requestedAt: string;
  /**
   * An exact version, or absent for the newest the install's manifest names.
   * Required for `apply`: an apply names the staged version it was offered.
   */
  targetVersion?: string;
  mode?: ServiceUpdateRequestMode;
}

export type ServiceUpdateRequestResult =
  | { requestId: string; status: 'up-to-date'; version: string; at: string }
  | { requestId: string; status: 'staged'; version: string; at: string }
  | {
      requestId: string;
      status: 'failed' | 'rejected';
      reason: string;
      at: string;
    };

const REQUEST_ID = /^[0-9a-f-]{36}$/;
/** The launcher's VERSION_PATTERN. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

function temporaryPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

/**
 * Writes `text` to a new owner-only `temp`. A failed write (ENOSPC, EIO)
 * removes the partly created file instead of leaving it beside the target.
 */
function writeTemporaryFile(temp: string, text: string): void {
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') removeQuietly(temp);
    throw error;
  }
}

/** Cleanup that never replaces the error being reported. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The caller rethrows the original failure.
  }
}

/** Durably publishes one small owner-only JSON file by rename. */
export function writeJsonAtomically(path: string, value: unknown): void {
  const temp = temporaryPath(path);
  writeTemporaryFile(temp, `${JSON.stringify(value)}\n`);
  try {
    renameSync(temp, path);
  } catch (error) {
    removeQuietly(temp);
    throw error;
  }
}

/** Another request is queued or being staged. */
export class ServiceUpdateAlreadyRequestedError extends Error {
  constructor() {
    super('A Station update is already requested.');
    this.name = 'ServiceUpdateAlreadyRequestedError';
  }
}

/**
 * Queues an update for the service's launcher. Refuses while another request
 * is queued or being staged, so a second click cannot start a second one;
 * the request appears complete or not at all, and a request published
 * concurrently is never overwritten (a hard link fails on an existing name
 * where a rename would replace it).
 */
export function writeServiceUpdateRequest(
  installRoot: string,
  targetVersion?: string,
  options: { mode?: ServiceUpdateRequestMode } = {},
): ServiceUpdateRequest {
  if (targetVersion !== undefined && !VERSION.test(targetVersion))
    throw new Error(`Not an exact Station version: ${targetVersion}`);
  if (options.mode === 'apply' && targetVersion === undefined)
    throw new Error('An apply request names the staged version it applies.');
  const paths = serviceUpdatePaths(installRoot);
  if (existsSync(paths.request) || existsSync(paths.processing)) {
    throw new ServiceUpdateAlreadyRequestedError();
  }
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  const request: ServiceUpdateRequest = {
    id: randomUUID(),
    requestedAt: new Date().toISOString(),
    ...(targetVersion ? { targetVersion } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  };
  const temp = temporaryPath(paths.request);
  writeTemporaryFile(temp, `${JSON.stringify(request)}\n`);
  try {
    linkSync(temp, paths.request);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new ServiceUpdateAlreadyRequestedError();
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
  return request;
}

export function parseServiceUpdateRequest(
  text: string,
): ServiceUpdateRequest | null {
  try {
    const value = JSON.parse(text) as Partial<ServiceUpdateRequest>;
    if (
      typeof value.id !== 'string' ||
      !REQUEST_ID.test(value.id) ||
      typeof value.requestedAt !== 'string' ||
      (value.targetVersion !== undefined &&
        (typeof value.targetVersion !== 'string' ||
          !VERSION.test(value.targetVersion))) ||
      (value.mode !== undefined &&
        value.mode !== 'stage' &&
        value.mode !== 'apply') ||
      (value.mode === 'apply' && value.targetVersion === undefined)
    )
      return null;
    return value as ServiceUpdateRequest;
  } catch {
    return null;
  }
}

/**
 * The staging step the child last observed for `requestId` (#3851): the
 * installer's reported phase and, while downloading, the archive's size on
 * disk against the signed manifest's size. Written by the child only.
 */
export interface ServiceStageProgress {
  requestId: string;
  phase: ServiceStagePhase;
  downloadedBytes?: number;
  totalBytes?: number;
  at: string;
}

const STAGE_PHASES: readonly ServiceStagePhase[] = [
  'downloading',
  'verifying',
  'installing',
];

export function isServiceStagePhase(
  value: unknown,
): value is ServiceStagePhase {
  return STAGE_PHASES.includes(value as ServiceStagePhase);
}

export function writeServiceStageProgress(
  installRoot: string,
  progress: ServiceStageProgress,
): void {
  writeJsonAtomically(serviceUpdatePaths(installRoot).stageProgress, progress);
}

function isByteCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** The recorded stage step, when it belongs to `requestId` and is well formed. */
function stageProgressFor(
  installRoot: string,
  requestId: string,
): Pick<
  Extract<ServiceUpdateProgress, { state: 'staging' }>,
  'stagePhase' | 'downloadedBytes' | 'totalBytes'
> {
  const file = readJson(serviceUpdatePaths(installRoot).stageProgress);
  if (file.kind !== 'ok') return {};
  const value = record(file.value);
  if (
    !value ||
    value.requestId !== requestId ||
    !isServiceStagePhase(value.phase)
  )
    return {};
  const bytes =
    value.phase === 'downloading' &&
    isByteCount(value.downloadedBytes) &&
    isByteCount(value.totalBytes) &&
    value.totalBytes > 0
      ? {
          // Never more than the signed size: the installer refuses a larger
          // archive, so a larger count is not progress toward this one.
          downloadedBytes: Math.min(value.downloadedBytes, value.totalBytes),
          totalBytes: value.totalBytes,
        }
      : {};
  return { stagePhase: value.phase, ...bytes };
}

function requestIntent(request: ServiceUpdateRequest): ServiceUpdateIntent {
  return request.mode ?? 'update';
}

/** The same completion check the launcher makes before a trial. */
export function serviceVersionIsStaged(
  installRoot: string,
  version: string,
): boolean {
  if (!VERSION.test(version)) return false;
  const dir = join(installRoot, 'versions', version);
  try {
    return (
      readFileSync(join(dir, '.station-install-complete'), 'utf8').trim() !==
        '' && existsSync(join(dir, 'bin', 'station.mjs'))
    );
  } catch {
    return false;
  }
}

type ReadResult<T> = { kind: 'absent' } | { kind: 'invalid' } | T;

function readJson(path: string): ReadResult<{ kind: 'ok'; value: unknown }> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'invalid' };
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) };
  } catch {
    return { kind: 'invalid' };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const PHASES: readonly ServiceUpdatePhase[] = [
  'stopping',
  'backing-up',
  'trial',
  'restoring',
];

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** The request-before-trial outcome, when the file is one the child wrote. */
function requestResultProgress(value: unknown): ServiceUpdateProgress | null {
  const result = record(value);
  if (
    !result ||
    typeof result.requestId !== 'string' ||
    !REQUEST_ID.test(result.requestId) ||
    !isTimestamp(result.at)
  )
    return null;
  if (result.status === 'staged' && isVersion(result.version))
    return {
      state: 'staged',
      requestId: result.requestId,
      version: result.version,
      stagedAt: result.at,
    };
  if (result.status === 'up-to-date' && isVersion(result.version))
    return {
      state: 'up-to-date',
      requestId: result.requestId,
      version: result.version,
      finishedAt: result.at,
    };
  if (
    (result.status === 'failed' || result.status === 'rejected') &&
    typeof result.reason === 'string'
  )
    return {
      state: result.status === 'failed' ? 'staging-failed' : 'rejected',
      requestId: result.requestId,
      reason: result.reason,
      finishedAt: result.at,
    };
  return null;
}

/**
 * The launcher's recorded update, in the launcher's own shape
 * (`validUpdate` in station-launcher.mjs). `undefined` for a state that
 * records none; null for one this reader cannot trust.
 */
function launcherUpdateProgress(
  value: unknown,
): ServiceUpdateProgress | null | undefined {
  const state = record(value);
  if (!state || state.protocol !== SERVICE_LAUNCHER_PROTOCOL) return null;
  if (!isVersion(state.activeVersion)) return null;
  if (state.update === undefined) return undefined;
  const update = record(state.update);
  if (
    !update ||
    typeof update.id !== 'string' ||
    !REQUEST_ID.test(update.id) ||
    !isVersion(update.fromVersion) ||
    !isVersion(update.targetVersion) ||
    !Number.isSafeInteger(update.attempts)
  )
    return null;
  const requestId =
    typeof update.requestId === 'string' && REQUEST_ID.test(update.requestId)
      ? update.requestId
      : null;
  const base = {
    requestId,
    fromVersion: update.fromVersion,
    targetVersion: update.targetVersion,
  };
  if (update.status === 'pending') {
    if (!PHASES.includes(update.phase as ServiceUpdatePhase)) return null;
    return {
      state: 'updating',
      ...base,
      phase: update.phase as ServiceUpdatePhase,
      attempts: update.attempts as number,
    };
  }
  if (!isTimestamp(update.finishedAt)) return null;
  if (update.status === 'committed')
    return { state: 'committed', ...base, finishedAt: update.finishedAt };
  if (update.status === 'needs-operator') {
    if (
      typeof update.reason !== 'string' ||
      !Number.isSafeInteger(update.restoreAttempts)
    )
      return null;
    return {
      state: 'needs-operator',
      ...base,
      reason: update.reason,
      restoreAttempts: update.restoreAttempts as number,
      finishedAt: update.finishedAt,
    };
  }
  if (
    (update.status === 'rolled-back' || update.status === 'failed') &&
    typeof update.reason === 'string'
  )
    return {
      state: update.status,
      ...base,
      reason: update.reason,
      finishedAt: update.finishedAt,
    };
  return null;
}

/**
 * Where the service's update stands, read from the runtime files in the
 * order the protocol moves through them: a queued request, then a claimed
 * one being staged, then the launcher's transaction. When nothing is under
 * way, the newer of the two recorded outcomes answers.
 *
 * `includeStaged: false` answers for a reader older than #3851, whose
 * parser turns a state it does not know into `unavailable` ("cannot be
 * read"): a `staged` result is skipped, and the launcher's record (or
 * `idle`) answers as it would have before the stage. A queued or staging
 * download (a `stage` request) is skipped for it too, since such a reader
 * presents those states as an update about to restart the server.
 */
export function readServiceUpdateProgress(
  installRoot: string,
  options: { includeStaged?: boolean } = {},
): ServiceUpdateProgress {
  const paths = serviceUpdatePaths(installRoot);
  for (const [path, state] of [
    [paths.request, 'queued'],
    [paths.processing, 'staging'],
  ] as const) {
    const file = readJson(path);
    if (file.kind === 'absent') continue;
    const request =
      file.kind === 'ok'
        ? parseServiceUpdateRequest(JSON.stringify(file.value))
        : null;
    // An unreadable request is still one the service will claim (and drop).
    if (!request) return { state: 'unavailable' };
    // A reader older than #3851 shows queued or staging as an update under
    // way, a restart to come; a download restarts nothing, so it is not
    // shown to that reader at all (review F13).
    if (options.includeStaged === false && request.mode === 'stage') continue;
    const intent = requestIntent(request);
    if (state === 'queued') return { state, requestId: request.id, intent };
    return {
      state,
      requestId: request.id,
      intent,
      ...stageProgressFor(installRoot, request.id),
    };
  }
  const stateFile = readJson(paths.state);
  let launcher: ServiceUpdateProgress | null | undefined;
  if (stateFile.kind === 'invalid') return { state: 'unavailable' };
  if (stateFile.kind === 'ok') {
    launcher = launcherUpdateProgress(stateFile.value);
    if (launcher === null) return { state: 'unavailable' };
    if (launcher?.state === 'updating') return launcher;
  }
  const resultFile = readJson(paths.result);
  let result =
    resultFile.kind === 'ok' ? requestResultProgress(resultFile.value) : null;
  // `staged` is a fact about the disk, not only a record: a version pruned
  // since, or the one the service now runs, is no longer staged.
  if (
    result?.state === 'staged' &&
    (options.includeStaged === false ||
      !serviceVersionIsStaged(installRoot, result.version) ||
      (stateFile.kind === 'ok' &&
        record(stateFile.value)?.activeVersion === result.version))
  )
    result = null;
  // When each record was written. `staged` ranks by when it was staged: the
  // launcher keeps its last outcome (`committed`) forever, and a stage made
  // after it must answer (review F1).
  const finished = (progress: ServiceUpdateProgress | null | undefined) =>
    !progress
      ? -1
      : 'finishedAt' in progress
        ? Date.parse(progress.finishedAt)
        : progress.state === 'staged'
          ? Date.parse(progress.stagedAt)
          : -1;
  // An update the operator must recover outranks any later request result.
  if (launcher?.state === 'needs-operator') return launcher;
  if (launcher && finished(launcher) >= finished(result)) return launcher;
  return result ?? launcher ?? { state: 'idle' };
}
