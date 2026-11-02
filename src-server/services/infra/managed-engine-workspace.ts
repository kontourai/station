import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveHomeDir } from '../../utils/paths.js';

const WORKSPACE_MODE = 0o700;

const WORKSPACE_KINDS: ReadonlySet<string> = new Set(['session', 'probe']);
const WORKSPACE_DIGEST = /^[0-9a-f]{64}$/;
const ENGINES = ['acp', 'codex'] as const;

/** Recognize a private workspace, including one created by another Station home. */
export function isManagedEngineWorkspace(
  cwd: string,
  stationHome: string = resolveHomeDir(),
  engine?: 'acp' | 'codex',
): boolean {
  const engines = engine ? [engine] : ENGINES;
  if (
    isAbsolute(cwd) &&
    engines.some((name) =>
      isContainedBy(
        join(resolve(stationHome), 'runtime', `${name}-workspaces`),
        resolve(cwd),
      ),
    )
  ) {
    return true;
  }
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const [runtime, workspaces, kind, digest] = segments.slice(-4);
  return (
    segments.length >= 4 &&
    runtime === 'runtime' &&
    engines.some((name) => workspaces === `${name}-workspaces`) &&
    kind !== undefined &&
    WORKSPACE_KINDS.has(kind) &&
    digest !== undefined &&
    WORKSPACE_DIGEST.test(digest)
  );
}

export type ManagedEngineWorkspaceIdentity =
  | { kind: 'session'; connectionId: string; threadId: string }
  | { kind: 'probe'; connectionId: string };

function isContainedBy(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function rejectSymlink(path: string, label: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** One directory of a chain `prepareStationPrivateFolder` creates. */
export interface StationFolderStep {
  directory: string;
  label: string;
  /**
   * Tighten an existing directory to 0700 too. A shared parent such as
   * `runtime/` is only created 0700 when missing, never re-moded.
   */
  restrict: boolean;
}

/**
 * Create (or reuse) a chain of directories inside a Station home, each
 * refusing symbolic links before and after creation and each proven, by real
 * path, to stay inside the Station home. Returns the last directory's real
 * path. This is the one preparation every Station-made chat folder goes
 * through: managed engine workspaces here and no-project scratch folders
 * (#4389, `no-project-chat-folder.ts`).
 *
 * Fails closed. No caller may replace failure with HOME or process.cwd().
 */
export async function prepareStationPrivateFolder(
  stationHome: string,
  steps: readonly StationFolderStep[],
): Promise<string> {
  const home = resolve(stationHome);
  await mkdir(home, { recursive: true, mode: WORKSPACE_MODE });
  const realHome = await realpath(home);
  let last = realHome;
  for (const { directory, label, restrict } of steps) {
    await rejectSymlink(directory, label);
    await mkdir(directory, { recursive: true, mode: WORKSPACE_MODE });
    await rejectSymlink(directory, label);
    if (restrict) await chmod(directory, WORKSPACE_MODE);
    last = await realpath(directory);
    if (!isContainedBy(realHome, last)) {
      throw new Error(`${label} escaped Station home: ${last}`);
    }
  }
  return last;
}

/**
 * Prepare a private, deterministic workspace for an otherwise-unbound engine
 * process. Session and probe identities are explicitly disjoint; repeated
 * lifecycle operations reuse their own directory without allowing probes to
 * share a session workspace. The Station-home reset is the cleanup boundary.
 *
 * Preparation fails closed. No caller may replace failure with HOME or
 * process.cwd(), and no caller-controlled text becomes a path component.
 */
export async function prepareManagedEngineWorkspace(
  engine: 'acp' | 'codex',
  identity: ManagedEngineWorkspaceIdentity,
  stationHome: string = resolveHomeDir(),
): Promise<string> {
  const labelPrefix = engine.toUpperCase();
  const home = resolve(stationHome);
  const root = join(home, 'runtime', `${engine}-workspaces`);
  const digest = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex');
  return prepareStationPrivateFolder(home, [
    {
      directory: join(home, 'runtime'),
      label: 'Station runtime directory',
      restrict: false,
    },
    {
      directory: root,
      label: `${labelPrefix} managed workspace root`,
      restrict: true,
    },
    {
      directory: join(root, identity.kind),
      label: `${labelPrefix} managed workspace identity root`,
      restrict: true,
    },
    {
      directory: join(root, identity.kind, digest),
      label: `${labelPrefix} managed workspace`,
      restrict: true,
    },
  ]);
}
