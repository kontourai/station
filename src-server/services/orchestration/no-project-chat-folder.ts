import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { NoProjectChatFolder } from '@kontourai/station-contracts/config';
import { resolveHomeDir } from '../../utils/paths.js';

/**
 * #4389: where a chat with no Project runs. A new no-project chat used to
 * start in the person's whole home folder; it now gets a private scratch
 * folder of its own under Station's data, `<Station home>/scratch/<id>`.
 * `AppConfig.noProjectChatFolder: 'home'` is the explicit opt-out.
 *
 * Only a NEW conversation is placed here. A conversation that already ran
 * keeps the folder it recorded (`OrchestrationService`'s caller reads it
 * first), and recovery of a session with no recorded folder keeps the home
 * default, so no existing chat moves.
 */
export const DEFAULT_NO_PROJECT_CHAT_FOLDER: NoProjectChatFolder = 'private';

const SCRATCH_MODE = 0o700;
/** A conversation id used as-is: no separators, no dot-only names. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The directory under a Station home that holds every no-project scratch folder. */
export function noProjectChatScratchRoot(
  stationHome: string = resolveHomeDir(),
): string {
  return join(resolve(stationHome), 'scratch');
}

function isContainedBy(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

/** Whether `cwd` is a scratch folder this Station home made for a chat. */
export function isNoProjectChatScratch(
  cwd: string,
  stationHome: string = resolveHomeDir(),
): boolean {
  if (!isAbsolute(cwd)) return false;
  const root = noProjectChatScratchRoot(stationHome);
  const candidate = resolve(cwd);
  return candidate !== root && isContainedBy(root, candidate);
}

/** The folder name for a conversation: its id when plain, else a digest of it. */
export function noProjectChatScratchName(conversationId: string): string {
  return PLAIN_ID.test(conversationId)
    ? conversationId
    : createHash('sha256').update(conversationId).digest('hex');
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
 * Create (or reuse) the private scratch folder for `conversationId` and
 * return its real path. Fails closed: a caller never replaces a failure with
 * the home folder.
 */
export async function prepareNoProjectChatScratch(
  conversationId: string,
  stationHome: string = resolveHomeDir(),
): Promise<string> {
  const home = resolve(stationHome);
  const root = noProjectChatScratchRoot(home);
  const folder = join(root, noProjectChatScratchName(conversationId));

  await mkdir(home, { recursive: true, mode: SCRATCH_MODE });
  const realHome = await realpath(home);
  for (const [directory, label] of [
    [root, 'Station scratch root'],
    [folder, 'Chat scratch folder'],
  ] as const) {
    await rejectSymlink(directory, label);
    await mkdir(directory, { recursive: true, mode: SCRATCH_MODE });
    await rejectSymlink(directory, label);
    await chmod(directory, SCRATCH_MODE);
    const actual = await realpath(directory);
    if (!isContainedBy(realHome, actual)) {
      throw new Error(`${label} escaped Station home: ${actual}`);
    }
  }
  return realpath(folder);
}
