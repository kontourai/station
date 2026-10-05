import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveHomeDir } from '../../utils/paths.js';

const WORKSPACE_MODE = 0o700;

const WORKSPACE_KINDS: ReadonlySet<string> = new Set(['session', 'probe']);
const WORKSPACE_DIGEST = /^[0-9a-f]{64}$/;

/** The directory under a Station home that holds every managed ACP workspace. */
export function managedAcpWorkspaceRoot(
  stationHome: string = resolveHomeDir(),
): string {
  return join(resolve(stationHome), 'runtime', 'acp-workspaces');
}

/**
 * Whether `cwd` is a workspace `prepareManagedAcpWorkspace` creates: inside
 * this Station home's workspace root, or ending in the exact layout it writes
 * for any Station home, `runtime/acp-workspaces/<session|probe>/<sha256 hex>`.
 * Other Station instances on the machine have other homes, so the layout is
 * matched segment by segment, with the full 64-character digest; it is not a
 * substring test, and a user's own folder does not take that shape.
 */
export function isManagedAcpWorkspace(
  cwd: string,
  stationHome: string = resolveHomeDir(),
): boolean {
  if (
    isAbsolute(cwd) &&
    isContainedBy(managedAcpWorkspaceRoot(stationHome), resolve(cwd))
  ) {
    return true;
  }
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const [runtime, workspaces, kind, digest] = segments.slice(-4);
  return (
    segments.length >= 4 &&
    runtime === 'runtime' &&
    workspaces === 'acp-workspaces' &&
    kind !== undefined &&
    WORKSPACE_KINDS.has(kind) &&
    digest !== undefined &&
    WORKSPACE_DIGEST.test(digest)
  );
}

type ManagedAcpWorkspaceIdentity =
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
  const root = managedAcpWorkspaceRoot(home);
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
