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
 * The option goes in the flag settings tier (`Options.settings`), which sits
 * above the user's own settings and below managed policy. The engine reads the
 * plugin's options only from the user, flag and managed tiers. So, to keep a
 * choice the user made for themselves, Station sets the option only when
 * the user tier's `settings.json` provably makes no choice.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import nodePath from 'node:path';

/**
 * The keys the engine accepts for its built-in plugin's options: the public
 * name and the internal one.
 */
const AGENTS_MD_PLUGIN_KEYS = [
  'agents-md@builtin',
  'cc-plugin-agents-md@builtin',
] as const;

/**
 * `projectInstructions` is the option's older name. The engine still honors
 * it when `instructionFiles` is unset, so a user who set either one has
 * chosen.
 */
const CHOICE_OPTIONS = ['instructionFiles', 'projectInstructions'] as const;

const STATION_INSTRUCTION_FILES = 'claude-md-and-agents-md';

/** A user settings file past this size is not parsed, so Station sets nothing. */
export const CLAUDE_USER_SETTINGS_MAX_BYTES = 1024 * 1024;

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

function userChoice(settings: unknown): string | undefined {
  if (!isRecord(settings) || !isRecord(settings.pluginConfigs)) return;
  for (const key of AGENTS_MD_PLUGIN_KEYS) {
    const options = (settings.pluginConfigs[key] as { options?: unknown })
      ?.options;
    if (!isRecord(options)) continue;
    for (const name of CHOICE_OPTIONS)
      if (options[name] !== undefined)
        return `the user settings set pluginConfigs["${key}"].options.${name}`;
  }
}

/**
 * Reads at most `max + 1` bytes of a regular file. `undefined` when the file
 * does not exist; throws when it exists but cannot be read, is not a regular
 * file, or is larger than `max`.
 */
function readBounded(path: string, max: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
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
 * The flag settings that make the engine load AGENTS.md beside CLAUDE.md, for
 * a session whose Claude config home is `configHome`. Settings are returned
 * only when the user's settings file is absent or readable and makes no
 * choice. When Station cannot tell (the file cannot be read, is too large,
 * or is not JSON), it leaves the engine's own default in place, and the
 * reason says why.
 */
export function claudeInstructionFilesSettings(
  configHome: string,
  maxBytes = CLAUDE_USER_SETTINGS_MAX_BYTES,
): ClaudeInstructionFilesDecision {
  const path = nodePath.join(configHome, 'settings.json');
  let text: string | undefined;
  try {
    text = readBounded(path, maxBytes);
  } catch (error) {
    return {
      settings: undefined,
      reason: `the user settings file ${path} was not read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (text !== undefined && text.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        settings: undefined,
        reason: `the user settings file ${path} is not JSON`,
      };
    }
    const choice = userChoice(parsed);
    if (choice) return { settings: undefined, reason: choice };
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
