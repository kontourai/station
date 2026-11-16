/**
 * Muse Code's own MCP servers, as `engine-mcp.status` (`scope:
 * 'engine-config'`), read once at session start from `muse mcp list --json`.
 *
 * Stable MSP (Muse Code 1.4.18) carries no MCP server status and no
 * reconnect: its only MCP surface is `session/start`'s `mcpServers` input.
 * So this is the CONFIGURATION muse will load for the session's folder, not
 * a connection result, and an enabled server is reported `configured`, never
 * `ready` or `starting`. No `reconnect` is declared for the same reason.
 *
 * `muse mcp list --json` (captured live 2026-11-13, scrubbed) lists every
 * server that will load in the current folder — user entries from
 * `$XDG_CONFIG_HOME/muse/settings.json` and project entries from the
 * repository root down to the cwd, the latter only once the folder is
 * trusted — as `{"servers":[{name, status: "enabled"|"disabled", enabled,
 * source: "user"|"project", type, command, args, env, url, headers, auth,
 * token, ...}]}`. Muse masks env and header values (`"[REDACTED]"`), but
 * `args` and `url` are verbatim and can carry secrets. Only `name` and the
 * enabled state leave this module; nothing else of an entry is read.
 */
import type { EngineMcpServerStatus } from '@kontourai/station-contracts/runtime-events';
import { ENGINE_MCP_SERVER_NAME_MAX_CHARS } from '@kontourai/station-contracts/runtime-events';
import { isRecord } from '../../utils/is-record.js';
import { type CliCommandResult, runCliCommand } from '../auth/cli-auth.js';

/** Servers one report carries; the ACP producer bounds its reports the same way. */
const MUSE_MCP_STATUS_MAX_SERVERS = 64;
/** `muse mcp list` reads local files only; observed well under a second. */
const MUSE_MCP_LIST_TIMEOUT_MS = 10_000;
const MUSE_MCP_LIST_MAX_BUFFER = 1_048_576;

const MUSE_MCP_LIST_ARGS = ['mcp', 'list', '--json'] as const;

/** Runs `muse mcp list --json` in the session's folder under the session's env. */
export type MuseMcpListRunner = (input: {
  command: string;
  cwd?: string;
  env: Record<string, string>;
  /** Inherited variables removed from the run (see `runCliCommand`). */
  omitEnv?: readonly string[];
}) => Promise<CliCommandResult | null>;

export const runMuseMcpList: MuseMcpListRunner = ({
  command,
  cwd,
  env,
  omitEnv,
}) =>
  runCliCommand(command, [...MUSE_MCP_LIST_ARGS], undefined, env, {
    timeoutMs: MUSE_MCP_LIST_TIMEOUT_MS,
    maxBuffer: MUSE_MCP_LIST_MAX_BUFFER,
    ...(cwd ? { cwd } : {}),
    ...(omitEnv?.length ? { omitEnv } : {}),
  });

// Control, bidi-override and zero-width characters: a name is rendered.
const UNSAFE_NAME_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting these is the point
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;

function museMcpServer(entry: unknown): EngineMcpServerStatus | undefined {
  if (!isRecord(entry)) return undefined;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (
    !name ||
    name.length > ENGINE_MCP_SERVER_NAME_MAX_CHARS ||
    UNSAFE_NAME_CHARACTERS.test(name)
  )
    return undefined;
  // Both spellings must agree: a status this build has not seen, or one the
  // `enabled` flag contradicts, is not reported rather than guessed.
  if (entry.status === 'enabled' && entry.enabled === true)
    return { name, state: 'configured', scope: 'engine-config' };
  if (entry.status === 'disabled' && entry.enabled === false)
    return { name, state: 'disabled', scope: 'engine-config' };
  return undefined;
}

/**
 * The servers a `muse mcp list --json` answer names, or `undefined` when the
 * answer is not that envelope (so nothing is published, rather than an empty
 * list replacing what is known).
 */
export function museMcpStatusFromList(
  stdout: string,
): EngineMcpServerStatus[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.servers)) return undefined;
  const byName = new Map<string, EngineMcpServerStatus>();
  for (const entry of parsed.servers) {
    const server = museMcpServer(entry);
    if (!server) continue;
    if (!byName.has(server.name) && byName.size >= MUSE_MCP_STATUS_MAX_SERVERS)
      continue;
    byName.set(server.name, server);
  }
  return [...byName.values()];
}
