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
    state: join(runtime, 'service-state.json'),
  };
}

export interface ServiceUpdateRequest {
  id: string;
  requestedAt: string;
  /** An exact version, or absent for the newest the install's manifest names. */
  targetVersion?: string;
}

export type ServiceUpdateRequestResult =
  | { requestId: string; status: 'up-to-date'; version: string; at: string }
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

/** Durably publishes one small owner-only JSON file by rename. */
export function writeJsonAtomically(path: string, value: unknown): void {
  const temp = temporaryPath(path);
  writeFileSync(temp, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temp, path);
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
): ServiceUpdateRequest {
  if (targetVersion !== undefined && !VERSION.test(targetVersion))
    throw new Error(`Not an exact Station version: ${targetVersion}`);
  const paths = serviceUpdatePaths(installRoot);
  if (existsSync(paths.request) || existsSync(paths.processing)) {
    throw new ServiceUpdateAlreadyRequestedError();
  }
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  const request: ServiceUpdateRequest = {
    id: randomUUID(),
    requestedAt: new Date().toISOString(),
    ...(targetVersion ? { targetVersion } : {}),
  };
  const temp = temporaryPath(paths.request);
  writeFileSync(temp, `${JSON.stringify(request)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
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
          !VERSION.test(value.targetVersion)))
    )
      return null;
    return value as ServiceUpdateRequest;
  } catch {
    return null;
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
 */
export function readServiceUpdateProgress(
  installRoot: string,
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
    return { state, requestId: request.id };
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
  const result =
    resultFile.kind === 'ok' ? requestResultProgress(resultFile.value) : null;
  const finished = (progress: ServiceUpdateProgress | null | undefined) =>
    progress && 'finishedAt' in progress ? Date.parse(progress.finishedAt) : -1;
  // An update the operator must recover outranks any later request result.
  if (launcher?.state === 'needs-operator') return launcher;
  if (launcher && finished(launcher) >= finished(result)) return launcher;
  return result ?? launcher ?? { state: 'idle' };
}
