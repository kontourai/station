/**
 * `--parent-pid`: a supervisor started by a launcher that itself supervises
 * it (`station service run`) stops when that launcher dies, so a launcher
 * killed outright does not leave the supervisor and its core running beside
 * the launcher's replacement.
 *
 * The launcher's process start fingerprint is captured when the watch starts
 * and compared on every check: the pid gone, or held by a process with
 * another fingerprint, means the launcher is gone. A fingerprint that cannot
 * be read proves nothing, so then only the parent pid counts, on POSIX and
 * only if the launcher was this process's parent to begin with (Windows keeps
 * a stale parent pid after the parent exits).
 */
import type { Fingerprint } from './generation-registry.ts';

export interface ParentWatchState {
  parentPid: number;
  /** The launcher's fingerprint at start, or null if it could not be read. */
  fingerprint: string | null;
  /** The launcher was this process's parent when the watch started. */
  wasParent: boolean;
}

export function launcherGone(
  state: ParentWatchState,
  observed: Fingerprint,
  currentParentPid: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (observed.status === 'gone') return true;
  if (observed.status === 'ok') {
    return state.fingerprint !== null && observed.value !== state.fingerprint;
  }
  return (
    platform !== 'win32' &&
    state.wasParent &&
    currentParentPid !== state.parentPid
  );
}
