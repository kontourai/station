import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveHomeDir } from '../../utils/paths.js';

const WORKSPACE_MODE = 0o700;

export type ManagedAcpWorkspaceIdentity =
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

/**
 * Prepare a private, deterministic workspace for an otherwise-unbound ACP
 * process. Session and probe identities are explicitly disjoint; repeated
 * lifecycle operations reuse their own directory without allowing probes to
 * share a session workspace. The Station-home reset is the cleanup boundary.
 *
 * Preparation fails closed. No caller may replace failure with HOME or
 * process.cwd(), and no caller-controlled text becomes a path component.
 */
export async function prepareManagedAcpWorkspace(
  identity: ManagedAcpWorkspaceIdentity,
  stationHome: string = resolveHomeDir(),
): Promise<string> {
  const home = resolve(stationHome);
  const runtime = join(home, 'runtime');
  const root = join(runtime, 'acp-workspaces');
  const digest = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex');
  const workspace = join(root, identity.kind, digest);

  await mkdir(home, { recursive: true, mode: WORKSPACE_MODE });
  const realHome = await realpath(home);
  await rejectSymlink(runtime, 'Station runtime directory');
  await mkdir(runtime, { recursive: true, mode: WORKSPACE_MODE });
  await rejectSymlink(runtime, 'Station runtime directory');
  const realRuntime = await realpath(runtime);
  if (!isContainedBy(realHome, realRuntime)) {
    throw new Error(
      `Station runtime directory escaped Station home: ${realRuntime}`,
    );
  }

  for (const [directory, label] of [
    [root, 'ACP managed workspace root'],
    [join(root, identity.kind), 'ACP managed workspace identity root'],
    [workspace, 'ACP managed workspace'],
  ] as const) {
    await rejectSymlink(directory, label);
    await mkdir(directory, { recursive: true, mode: WORKSPACE_MODE });
    await rejectSymlink(directory, label);
    await chmod(directory, WORKSPACE_MODE);
    const actual = await realpath(directory);
    if (!isContainedBy(realHome, actual)) {
      throw new Error(`${label} escaped Station home: ${actual}`);
    }
  }

  return realpath(workspace);
}
