/**
 * Station#1157: maps a resolved agent's authored `toolServers`
 * (`ResolvedAgentToolServer[]`, already secret-boundary-filtered at
 * resolution — see session-agent-resolution.ts) into the Claude Agent
 * SDK's `Options.mcpServers` shape (`@anthropic-ai/claude-agent-sdk`), the
 * Claude analog of ACP's `acp-mcp-passthrough.ts`.
 *
 * Security posture, and why it differs from ACP (read this before touching
 * the station-control branch below): ACP's `session/new`/`session/load`
 * `mcpServers` payload is sent over the wire to an EXTERNAL, less-trusted
 * agent app (e.g. Kiro), which spawns the MCP child itself — so
 * acp-mcp-passthrough.ts must never let an env-bearing tool server cross
 * that boundary, full stop (see its header comment). The Claude Agent SDK
 * is different: `query({ options: { mcpServers } })` spawns each MCP
 * server itself, IN STATION'S OWN SERVER PROCESS, exactly like
 * `mcp-manager.ts` already does for Station's own engine. There is no
 * external protocol boundary the env crosses. That is what makes it safe
 * for this module — and only this module, not acp-mcp-passthrough.ts — to
 * reuse `withStationControlRuntimeEnv` (the same reviewed mechanism
 * `mcp-manager.ts` uses) to inject Station's internal API token into the
 * built-in `station-control` server. `withStationControlRuntimeEnv` gates
 * the injection on an exact command/args match against the built-in
 * station-control server path, so an env-less third-party MCP server the
 * agent author points at never receives it.
 *
 * Review fix (archive#1157 round 2, HIGH companion): `ResolvedAgentToolServer`
 * structurally cannot carry `env` (secret boundary at resolution — see
 * session-agent-resolution.ts's own doc comment), so the real
 * `STATION_API_BASE`/`STATION_PORT` operational values station-control
 * needs are gone by the time a server reaches this module. They are
 * reconstructed HERE, fresh, from `stationControlEnv` — the caller's own
 * knowledge of the port THIS running instance is actually bound to (see
 * `stationControlSpawnEnv`) — never read from a resolved toolDef and never
 * persisted. Passed only into `withStationControlRuntimeEnv`, which still
 * gates on the exact built-in match before attaching anything.
 *
 * Pure and side-effect free (no I/O, no binary-existence check): unlike
 * ACP, the Claude SDK spawns in Station's own process with Station's own
 * PATH, so there is no cross-environment resolution problem to guard
 * against here — matching `mcp-manager.ts`'s `createMCPServerConfig`,
 * which passes `toolDef.command` straight through with no absolute-path
 * resolution either. An unmappable entry is recorded in `skipped` (never
 * silently dropped), mirroring `resolveAcpPassthroughMcpServers`'s
 * never-throws contract.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type {
  CapabilityUndeliveredReason,
  ResolvedAgentToolServer,
} from '@kontourai/station-contracts/provider';
import {
  isBuiltinStationControl,
  withStationControlRuntimeEnv,
} from '../../runtime/bootstrap/station-control-runtime-env.js';
import { toPassthroughToolDef } from './agent-tool-server-mapping.js';

export interface ClaudeToolServerSkip {
  id: string;
  reason: CapabilityUndeliveredReason;
  detail?: string;
}

export interface ResolveClaudeMcpServersResult {
  servers: Record<string, McpServerConfig>;
  skipped: ClaudeToolServerSkip[];
}

/**
 * Resolve one session's authored tool servers into the SDK's `mcpServers`
 * map, keyed by tool-server id (matching `mcp-manager.ts`'s
 * `serverConfig[toolId]` convention and ACP's `McpServer.name`).
 *
 * @param stationControlEnv the running instance's own
 * `{STATION_API_BASE, STATION_PORT}` (`stationControlSpawnEnv(port)`) —
 * forwarded alongside the token ONLY for the canonical built-in
 * station-control server; ignored (and never attached) for every other
 * server, including a third-party one that happens to share its id.
 */
export function resolveClaudeMcpServers(
  toolServers: ResolvedAgentToolServer[],
  stationControlEnv?: Record<string, string>,
): ResolveClaudeMcpServersResult {
  const servers: Record<string, McpServerConfig> = {};
  const skipped: ClaudeToolServerSkip[] = [];

  for (const server of toolServers) {
    const toolDef = toPassthroughToolDef(server);

    if (toolDef.transport === 'stdio') {
      if (!toolDef.command) {
        skipped.push({ id: server.id, reason: 'binary-not-found' });
        continue;
      }
      // station-control-only token + STATION_API_BASE/STATION_PORT
      // injection (the security boundary this module's header comment
      // explains) — the SAME reviewed mechanism mcp-manager.ts uses for
      // Station's own engine, not a second one. Gated HERE (not just
      // inside withStationControlRuntimeEnv, which passes non-token env
      // keys through verbatim for any toolId): `stationControlEnv` is only
      // ever handed to a server that IS the canonical built-in match, so a
      // third-party server never sees STATION_API_BASE/STATION_PORT
      // either, not only the token.
      const env = withStationControlRuntimeEnv(
        server.id,
        toolDef,
        isBuiltinStationControl(server.id, toolDef)
          ? stationControlEnv
          : undefined,
      );
      servers[server.id] = {
        type: 'stdio',
        command: toolDef.command,
        args: toolDef.args ?? [],
        ...(env ? { env } : {}),
      };
      continue;
    }

    if (toolDef.transport === 'sse') {
      if (!toolDef.endpoint) {
        skipped.push({
          id: server.id,
          reason: 'delivery-failed',
          detail: 'no endpoint configured',
        });
        continue;
      }
      servers[server.id] = { type: 'sse', url: toolDef.endpoint };
      continue;
    }

    if (toolDef.transport === 'streamable-http') {
      if (!toolDef.endpoint) {
        skipped.push({
          id: server.id,
          reason: 'delivery-failed',
          detail: 'no endpoint configured',
        });
        continue;
      }
      servers[server.id] = { type: 'http', url: toolDef.endpoint };
      continue;
    }

    // Missing or externally supplied non-canonical values fail closed.
    skipped.push({
      id: server.id,
      reason: 'unsupported-transport',
      detail: toolDef.transport,
    });
  }

  return { servers, skipped };
}
