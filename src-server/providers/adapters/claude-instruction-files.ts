/**
 * Which project instruction files a Station Claude session loads.
 *
 * Claude Code ships a built-in `agents-md` plugin whose `instructionFiles`
 * option picks them. Its default, `claude-md-or-agents-md`, loads a project's
 * AGENTS.md only when the project has no CLAUDE.md of its own, so a repository
 * that keeps both (CLAUDE.md for Claude, AGENTS.md for every other engine)
 * reaches a Claude session without its AGENTS.md unless CLAUDE.md imports it.
 * Station runs the same repository under several engines, so it asks for
 * `claude-md-and-agents-md`. The engine then loads AGENTS.md beside CLAUDE.md,
 * root and nested, exactly where and how it loads CLAUDE.md, and skips a file
 * CLAUDE.md already imports or links to. Station reads no instruction file
 * itself.
 *
 * The option goes in the flag settings tier (`Options.settings`). The engine
 * reads the plugin's options from the user, flag and managed tiers, merged by
 * key, with flag above user and managed above flag. Two things let Station's
 * value override a choice someone else made:
 *
 * - a user-tier choice, because flag sits above user;
 * - a choice on the older `projectInstructions` key in any tier, because the
 *   engine reads that key only while `instructionFiles` is unset or at its
 *   default, so Station's `instructionFiles` would win over a managed
 *   `projectInstructions: "none"`.
 *
 * So Station sets the option only when every settings file it can read
 * (the user's `settings.json`, and the machine's `managed-settings.json` and
 * `managed-settings.d/*.json`) provably sets neither key. When it cannot tell,
 * it sets nothing. Managed settings delivered by MDM (a macOS configuration
 * profile or the Windows policy registry) or by the server are not files
 * Station can read: a modern `instructionFiles` there still outranks
 * Station's value, a legacy `projectInstructions` there does not.
 *
 * Sending the legacy key (`projectInstructions: "both"`) instead was tried
 * against the real engine with a real managed tier. A managed legacy value
 * then wins, but a managed `instructionFiles` set explicitly to its default
 * loses, and the engine reports the legacy key as honoured only "for now".
 * Station prefers an installed engine that is newer than the bundled one, so
 * relying on that key could silently drop AGENTS.md wherever an engine stops
 * reading it. The modern key is what the engine documents.
 */
import {
  closeSync,
  type Dirent,
  constants as fsConstants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { platform } from 'node:os';
import nodePath from 'node:path';

/**
 * The keys the engine accepts for its built-in plugin's options: the public
 * name and the internal one.
 */
const AGENTS_MD_PLUGIN_KEYS = [
  'agents-md@builtin',
  'cc-plugin-agents-md@builtin',
] as const;

/** The option and its older name; either one set in a tier is a choice. */
const CHOICE_OPTIONS = ['instructionFiles', 'projectInstructions'] as const;

const STATION_INSTRUCTION_FILES = 'claude-md-and-agents-md';

/** A settings file past this size is not parsed, so Station sets nothing. */
export const CLAUDE_USER_SETTINGS_MAX_BYTES = 1024 * 1024;

/**
 * More managed drop-in files than this and Station sets nothing rather than
 * read only some of them.
 */
export const CLAUDE_MANAGED_DROP_IN_MAX_FILES = 256;

/**
 * The engine's managed settings folder for this platform. Claude Code fixes
 * it per platform; no environment variable moves it.
 */
function claudeManagedSettingsRoot(os: NodeJS.Platform = platform()): string {
  if (os === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (os === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

type ClaudeInstructionFilesSettings = {
  pluginConfigs: Record<
    string,
    { options: { instructionFiles: typeof STATION_INSTRUCTION_FILES } }
  >;
};

type ClaudeInstructionFilesDecision =
  | { settings: ClaudeInstructionFilesSettings }
  | { settings: undefined; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function choiceIn(settings: unknown): string | undefined {
  if (!isRecord(settings) || !isRecord(settings.pluginConfigs)) return;
  for (const key of AGENTS_MD_PLUGIN_KEYS) {
    const options = (settings.pluginConfigs[key] as { options?: unknown })
      ?.options;
    if (!isRecord(options)) continue;
    for (const name of CHOICE_OPTIONS)
      if (options[name] !== undefined)
        return `pluginConfigs["${key}"].options.${name}`;
  }
}

/**
 * Reads at most `max + 1` bytes of a regular file. `undefined` when the file
 * does not exist; throws when it exists but cannot be read, is not a regular
 * file, or is larger than `max`. The open does not block: a FIFO with no
 * writer opens at once and is then refused as not a regular file. Links are
 * followed, as the engine follows them.
 */
function readBounded(path: string, max: number): string | undefined {
  let fd: number;
  try {
    // O_NONBLOCK is absent on Windows, which has no FIFOs in the filesystem.
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > max) throw new Error(`larger than ${max} bytes`);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the engine reads this entry of `managed-settings.d`: a file or a
 * link whose name ends in `.json` and does not start with a dot, so a
 * `.disabled-policy.json` is skipped. Taken from Claude Code's own drop-in
 * walk, which reads the entries in sorted name order.
 */
function isEngineDropIn(entry: Dirent): boolean {
  return (
    (entry.isFile() || entry.isSymbolicLink()) &&
    entry.name.endsWith('.json') &&
    !entry.name.startsWith('.')
  );
}

/** The settings files to check, drop-ins in the engine's order. */
function settingsFiles(
  configHome: string,
  managedRoot: string,
): { files: Array<{ tier: string; path: string }> } | { reason: string } {
  const files = [
    { tier: 'user', path: nodePath.join(configHome, 'settings.json') },
    {
      tier: 'managed',
      path: nodePath.join(managedRoot, 'managed-settings.json'),
    },
  ];
  const dropIns = nodePath.join(managedRoot, 'managed-settings.d');
  let entries: Dirent[];
  try {
    entries = readdirSync(dropIns, { withFileTypes: true });
  } catch (error) {
    // The engine reads a missing folder, or a file in its place, as no
    // drop-ins.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { files };
    return {
      reason: `the managed drop-in folder ${dropIns} was not read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const names = entries.filter(isEngineDropIn).map((entry) => entry.name);
  if (names.length > CLAUDE_MANAGED_DROP_IN_MAX_FILES)
    return {
      reason: `the managed drop-in folder ${dropIns} holds more than ${CLAUDE_MANAGED_DROP_IN_MAX_FILES} drop-in files`,
    };
  for (const name of names.sort())
    files.push({ tier: 'managed', path: nodePath.join(dropIns, name) });
  return { files };
}

/**
 * The flag settings that make the engine load AGENTS.md beside CLAUDE.md, for
 * a session whose Claude config home is `configHome` (already resolved the
 * way the engine resolves it). Settings are returned only when every settings
 * file Station can read is absent or readable and makes no choice. When
 * Station cannot tell (a file cannot be read, is not a regular file, is too
 * large, or is not JSON), it leaves the engine's own setting in place, and the
 * reason says why.
 */
export function claudeInstructionFilesSettings(
  configHome: string,
  {
    managedRoot = claudeManagedSettingsRoot(),
    maxBytes = CLAUDE_USER_SETTINGS_MAX_BYTES,
  }: { managedRoot?: string; maxBytes?: number } = {},
): ClaudeInstructionFilesDecision {
  const listed = settingsFiles(configHome, managedRoot);
  if ('reason' in listed) return { settings: undefined, reason: listed.reason };
  for (const { tier, path } of listed.files) {
    let text: string | undefined;
    try {
      text = readBounded(path, maxBytes);
    } catch (error) {
      return {
        settings: undefined,
        reason: `the ${tier} settings file ${path} was not read (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    if (text === undefined || text.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        settings: undefined,
        reason: `the ${tier} settings file ${path} is not JSON`,
      };
    }
    const choice = choiceIn(parsed);
    if (choice)
      return {
        settings: undefined,
        reason: `the ${tier} settings file ${path} sets ${choice}`,
      };
  }
  return {
    settings: {
      pluginConfigs: {
        [AGENTS_MD_PLUGIN_KEYS[0]]: {
          options: { instructionFiles: STATION_INSTRUCTION_FILES },
        },
      },
    },
  };
}
