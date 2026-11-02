import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { NoProjectChatFolder } from '@kontourai/station-contracts/config';
import { resolveHomeDir } from '../../utils/paths.js';
import {
  isManagedEngineWorkspace,
  prepareStationPrivateFolder,
} from '../infra/managed-engine-workspace.js';

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
 *
 * This is the same kind of Station-made chat folder #4448 gives an unbound
 * confined Codex session (`managed-engine-workspace.ts`), at a location named
 * for the conversation. It is prepared by that module's
 * `prepareStationPrivateFolder`, and the Codex adapter keeps any folder
 * `isStationChatFolder` recognizes rather than preparing a second one, so a
 * no-project Codex chat has exactly one private folder. The `'home'` opt-out
 * leaves the chat unbound (`cwdDefaulted`), so a confined Codex session still
 * gets its #4448 workspace instead of a sandbox rooted at HOME; other engines,
 * and Codex on the host, run in the home folder.
 */
export const DEFAULT_NO_PROJECT_CHAT_FOLDER: NoProjectChatFolder = 'private';

/** A conversation id used as-is: no separators, no dot-only names. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The directory under a Station home that holds every no-project scratch folder. */
function noProjectChatScratchRoot(
  stationHome: string = resolveHomeDir(),
): string {
  return join(resolve(stationHome), 'scratch');
}

function isContainedBy(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

/** Whether `cwd` is a scratch folder this Station home made for a chat. */
function isNoProjectChatScratch(
  cwd: string,
  stationHome: string = resolveHomeDir(),
): boolean {
  if (!isAbsolute(cwd)) return false;
  const root = noProjectChatScratchRoot(stationHome);
  const candidate = resolve(cwd);
  return candidate !== root && isContainedBy(root, candidate);
}

/**
 * Whether `cwd` is a folder Station made for one chat: a managed engine
 * workspace (#4448, archive#1403) or a no-project scratch folder (#4389).
 * The session summary names such a folder "Chat workspace"
 * (`cwdManagedWorkspace`), and the Codex adapter does not replace it.
 */
export function isStationChatFolder(
  cwd: string,
  stationHome: string = resolveHomeDir(),
): boolean {
  return (
    isManagedEngineWorkspace(cwd, stationHome) ||
    isNoProjectChatScratch(cwd, stationHome)
  );
}

/** The folder name for a conversation: its id when plain, else a digest of it. */
function noProjectChatScratchName(conversationId: string): string {
  return PLAIN_ID.test(conversationId)
    ? conversationId
    : createHash('sha256').update(conversationId).digest('hex');
}

/**
 * Create (or reuse) the private scratch folder for `conversationId` and
 * return its real path, through the same safeguards as a managed engine
 * workspace (0700, no symbolic links, contained by the Station home). Fails
 * closed: a caller never replaces a failure with the home folder.
 */
export async function prepareNoProjectChatScratch(
  conversationId: string,
  stationHome: string = resolveHomeDir(),
): Promise<string> {
  const home = resolve(stationHome);
  const root = noProjectChatScratchRoot(home);
  return prepareStationPrivateFolder(home, [
    { directory: root, label: 'Station scratch root', restrict: true },
    {
      directory: join(root, noProjectChatScratchName(conversationId)),
      label: 'Chat scratch folder',
      restrict: true,
    },
  ]);
}
