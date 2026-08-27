/**
 * Canonical base directory resolution.
 * Runtime path priority: STATION_HOME → <STATION_ROOT>/instances/stable.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAdmittedRuntimeHome } from '@kontourai/station-shared/runtime-path-resolver';

export function resolveHomeDir(): string {
  return resolveAdmittedRuntimeHome();
}

/**
 * Expand a leading `~` to the home directory. Node's `path.resolve` does NOT do
 * this, so `~/dev` would otherwise resolve relative to cwd (e.g. `<cwd>/~/dev`)
 * and silently produce a corrupt path. Use this before resolving any
 * user-supplied path (workspace directories, file paths, etc.).
 */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * `homedir()` that never throws and only reports a directory that exists.
 *
 * #1011/#1023: the last-resort working directory for an engine session that
 * has no explicit and no project-supplied one. It must be a directory the
 * user would recognise (`$HOME`, which is what Station's UI promises for an
 * unbound chat) rather than whatever the SERVER process happens to be sitting
 * in — the install root for a dev checkout or a service. Returning
 * `undefined` on a degenerate host lets each caller keep its own prior
 * behavior instead of handing an adapter a dead path.
 *
 * Shared by the orchestration resolver and the ACP adapter so both ends of
 * the session-cwd chain settle on the same directory.
 */
export function safeHomeDirectory(): string | undefined {
  try {
    const home = homedir();
    return home && existsSync(home) ? home : undefined;
  } catch {
    return undefined;
  }
}
