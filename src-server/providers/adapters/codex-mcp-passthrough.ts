/**
 * archive#1195 (epic archive#1191 slice C, the Codex analog of archive#1157): maps a
 * resolved agent's authored `toolServers` (`ResolvedAgentToolServer[]`,
 * already secret-boundary-filtered at resolution — see
 * session-agent-resolution.ts) into `-c mcp_servers....` config-override
 * arguments appended to the `codex app-server` spawn argv — the Codex
 * analog of `claude-mcp-passthrough.ts`'s `Options.mcpServers` mapping and
 * ACP's `acp-mcp-passthrough.ts`.
 *
 * Security posture, and why it differs from BOTH Claude and ACP (read this
 * before touching the station-control branch below): Claude's Agent SDK
 * spawns each MCP server ITSELF, inside Station's own process (channel
 * 'subprocess') — safe to inject the real internal API token as env. ACP's
 * connected agent app ALSO spawns its own MCP children, but from a
 * `session/new` WIRE payload the external app can read — env must never
 * cross that boundary (channel 'wire'). Codex's `codex app-server` is
 * ALSO 'wire' (an external process that independently manages its own
 * outbound MCP connections — archive#1195's investigation confirmed there
 * is no way for Station to inject env into that connection at all), but
 * unlike ACP, Codex's `-c mcp_servers.<id>....` session-layer override is a
 * SPAWN-TIME ARGV, not a payload the external process stores/forwards
 * anywhere — so, unlike ACP, this module can carry a URL (never env) for
 * the canonical built-in station-control server: a per-session, short-lived,
 * station-control-scoped bearer token riding the URL's OWN query string
 * (`station-control-mcp-token.ts`), authenticating against Station's own
 * `station-control-mcp-route.ts` HTTP/SSE endpoint. `stationControlMcpUrl`
 * is minted and built entirely by the caller (`codex-adapter.ts`) — this
 * module never mints anything itself, and never falls back to any other
 * credential when a URL isn't provided (the server is simply skipped,
 * receipted `delivery-failed` — see below).
 *
 * `ResolvedAgentToolServer` structurally cannot carry `env` (the secret
 * boundary enforced at resolution — session-agent-resolution.ts's own doc
 * comment), so there is nothing to strip here: env simply never reaches
 * this module for ANY tool server, built-in or third-party.
 *
 * Codex's own MCP server-name validator requires
 * `^[a-zA-Z0-9_-]+$` (confirmed live against codex-cli 0.145.0 — an
 * unquoted-but-invalid name is rejected per-server, not fatal to the whole
 * app-server process, but Station validates up front anyway rather than
 * relying on that per-server isolation). Station's own tool-server ids are
 * already slug-like; an id that fails this pattern is skipped
 * (`delivery-failed`) rather than risking a malformed `-c` key path.
 *
 * Pure and side-effect free (no I/O, no binary-existence check, same
 * rationale as `claude-mcp-passthrough.ts`'s header comment — Codex spawns
 * with its own PATH, no cross-environment resolution problem to guard
 * against here either). An unmappable entry is recorded in `skipped` (never
 * silently dropped), mirroring the sibling passthrough modules' contract.
 */
import type {
  CapabilityUndeliveredReason,
  ResolvedAgentToolServer,
} from '@kontourai/station-contracts/provider';
import { isBuiltinStationControl } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { toPassthroughToolDef } from './agent-tool-server-mapping.js';

export interface CodexToolServerSkip {
  id: string;
  reason: CapabilityUndeliveredReason;
  detail?: string;
}

export interface ResolveCodexMcpServersResult {
  /** Flattened `-c` flag pairs, ready to append to the `codex app-server`
   * spawn argv (each config override is TWO array entries: `'-c'` then the
   * `key=value` string — spawn's array-argv form, never a shell string, so
   * no shell-injection surface regardless of value content). */
  configArgs: string[];
  /** Ids that produced at least one config-override arg above, in the same
   * order `toolServers` was given (for the delivery-channel report). */
  deliveredIds: string[];
  skipped: CodexToolServerSkip[];
}

const SAFE_MCP_SERVER_ID = /^[a-zA-Z0-9_-]+$/;

/** TOML basic-string escaping for a `-c key="value"` argument (backslash and
 * double-quote only — codex-cli 0.145.0's `-c` parser accepts a bare dotted
 * key path plus a TOML-syntax value; confirmed live that this covers a
 * URL's query string, an absolute path, and a JSON-syntax string array
 * value without any parse ambiguity). */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/**
 * @param stationControlMcpUrl the already-minted, already-built
 * `http://127.0.0.1:<port>/mcp/station-control?token=<token>` URL — forwarded
 * ONLY for a server passing `isBuiltinStationControl`. Post-#3063 that gate
 * distinguishes the registered built-in id (whose loaded def carries the
 * genuine overlay-injected command/args) from everything else; a def under
 * that id can only ever be the genuine built-in by the time it reaches this
 * module, and the URL is built from `this.port`, never from the def —
 * fail-toward-genuine, see the gate's doc comment in
 * station-control-runtime-env.ts.
 */
export function resolveCodexMcpServers(
  toolServers: ResolvedAgentToolServer[],
  stationControlMcpUrl?: string,
): ResolveCodexMcpServersResult {
  const configArgs: string[] = [];
  const deliveredIds: string[] = [];
  const skipped: CodexToolServerSkip[] = [];

  for (const server of toolServers) {
    if (!SAFE_MCP_SERVER_ID.test(server.id)) {
      skipped.push({
        id: server.id,
        reason: 'delivery-failed',
        detail: 'tool-server id is not a safe codex mcp_servers key',
      });
      continue;
    }

    const toolDef = toPassthroughToolDef(server);
    const keyPrefix = `mcp_servers.${server.id}`;

    if (isBuiltinStationControl(server.id, toolDef)) {
      if (!stationControlMcpUrl) {
        skipped.push({
          id: server.id,
          reason: 'delivery-failed',
          detail: 'station-control MCP auth was not available for this session',
        });
        continue;
      }
      configArgs.push(
        '-c',
        `${keyPrefix}.url=${tomlString(stationControlMcpUrl)}`,
      );
      deliveredIds.push(server.id);
      continue;
    }

    if (toolDef.transport === 'stdio') {
      if (!toolDef.command) {
        skipped.push({ id: server.id, reason: 'binary-not-found' });
        continue;
      }
      configArgs.push(
        '-c',
        `${keyPrefix}.command=${tomlString(toolDef.command)}`,
      );
      if (toolDef.args && toolDef.args.length > 0) {
        configArgs.push(
          '-c',
          `${keyPrefix}.args=${tomlStringArray(toolDef.args)}`,
        );
      }
      deliveredIds.push(server.id);
      continue;
    }

    if (
      toolDef.transport === 'sse' ||
      toolDef.transport === 'streamable-http'
    ) {
      if (!toolDef.endpoint) {
        skipped.push({
          id: server.id,
          reason: 'delivery-failed',
          detail: 'no endpoint configured',
        });
        continue;
      }
      configArgs.push('-c', `${keyPrefix}.url=${tomlString(toolDef.endpoint)}`);
      deliveredIds.push(server.id);
      continue;
    }

    // Missing or externally supplied non-canonical values fail closed.
    skipped.push({
      id: server.id,
      reason: 'unsupported-transport',
      detail: toolDef.transport,
    });
  }

  return { configArgs, deliveredIds, skipped };
}
