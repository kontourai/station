import type { ResolvedAgentToolServer } from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { isBuiltinStationControl } from '../bootstrap/station-control-runtime-env.js';

export function isAutoApproved(toolName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${regexPattern}$`).test(toolName);
  });
}

/**
 * External engines (Claude Code's SDK, ACP-driven agents) surface an MCP
 * tool call as `mcp__<server>__<tool>` (double-underscore delimited), while
 * Station's own autoApprove patterns are authored against the
 * `<server>_<tool>` shape Station-engine sessions already match against
 * (single underscore, server name kept verbatim — see
 * `normalizeToolName`/`agent-hooks.ts`'s `original` mapping, e.g.
 * `station-control_list_agents` for pattern `station-control_*`). This
 * rewrites the external `mcp__` form into that same canonical shape so one
 * authored pattern (e.g. `station-control_*`) matches identically whether
 * the tool ran under Station's engine or an external one. Returns the input
 * unchanged when it isn't in the `mcp__<server>__<tool>` shape (e.g. a
 * non-MCP built-in tool like `Bash`) — callers should still check the raw
 * name too (see `isAutoApprovedExternalTool`).
 */
export function canonicalizeExternalToolName(toolName: string): string {
  const prefix = 'mcp__';
  if (!toolName.startsWith(prefix)) return toolName;
  const rest = toolName.slice(prefix.length);
  const separatorIndex = rest.indexOf('__');
  if (separatorIndex === -1) return toolName;
  const server = rest.slice(0, separatorIndex);
  const tool = rest.slice(separatorIndex + 2);
  if (!server || !tool) return toolName;
  return `${server}_${tool}`;
}

/**
 * Server ids that Station injects itself and that carry privileged authority —
 * currently just the `station-control` control plane. An autoApprove pattern
 * anchored to such a name (`station-control_*` is the codebase-native worked
 * example) must only auto-approve when the DELIVERED server is the genuine
 * built-in, never a same-id impostor integration: `resolveToolServer` is a
 * bare `configLoader.loadIntegration(id)` with no reserved-id guard, so a
 * user/plugin integration reusing the id `station-control` (with an arbitrary
 * command, and no `env` so the secret-boundary filter doesn't drop it) is
 * delivered under that key. `isBuiltinStationControl` denies it the internal
 * token, but without this guard its `mcp__station-control__*` calls would
 * still be silently auto-approved by the common pattern — the first
 * silent-consent path for the Claude/ACP engines. Broader defense-in-depth
 * (reserving the id at the integration-store layer, protecting delivery + the
 * token for every engine incl. Station's own) is tracked as a follow-up.
 */
const RESERVED_BUILTIN_SERVER_IDS = new Set(['station-control']);

/**
 * If `toolName` is an external-engine tool call whose owning MCP server id is a
 * reserved built-in name, return that id; else null. Matches both the raw
 * `mcp__<server>__<tool>` shape and the canonicalized/directly-authored
 * `<server>_<tool>` shape.
 */
function reservedBuiltinServerForTool(toolName: string): string | null {
  const prefix = 'mcp__';
  if (toolName.startsWith(prefix)) {
    const rest = toolName.slice(prefix.length);
    const separatorIndex = rest.indexOf('__');
    const server = separatorIndex > 0 ? rest.slice(0, separatorIndex) : '';
    if (server && RESERVED_BUILTIN_SERVER_IDS.has(server)) return server;
  }
  for (const id of RESERVED_BUILTIN_SERVER_IDS) {
    if (toolName === id || toolName.startsWith(`${id}_`)) return id;
  }
  return null;
}

/**
 * Whether `toolName` is authentically bound to the MCP server that will execute
 * it. `'authentic'` — the engine generates the name itself from the actual
 * server config (Claude's Agent SDK produces `mcp__<server>__<tool>` from the
 * `mcpServers` config KEY Station handed it, spawned in Station's own process),
 * so the name provably identifies the server. `'self-reported'` — the name is
 * chosen by a less-trusted external process (ACP's `toolCall.name` is a
 * protocol-`@experimental`, optional field the connected agent app fills in
 * with no binding to which MCP server actually runs), so it is NOT trustworthy
 * for a privileged decision.
 */
export type ExternalToolNameProvenance = 'authentic' | 'self-reported';

/**
 * `isAutoApproved` for an external-engine tool call: checks the raw
 * engine-reported name first (covers non-MCP tools and any pattern
 * authored directly against the `mcp__` form, e.g. `mcp__station-control__*`),
 * then the canonicalized `<server>_<tool>` form (covers patterns authored
 * the same way Station's own engine's tools are, e.g. `station-control_*`).
 * Reuses `isAutoApproved` for the actual glob matching in both cases — no
 * reimplementation of the matching semantics.
 *
 * A match anchored to a RESERVED built-in name (e.g. `station-control`, the
 * privileged control plane) is honored ONLY when BOTH hold:
 *  1. the name is `'authentic'` (see {@link ExternalToolNameProvenance}) — an
 *     ACP `self-reported` name is unverifiable, so a compromised/buggy ACP
 *     agent that simply claims `toolCall.name: 'station-control_x'` must never
 *     skip user consent, even when the genuine built-in is legitimately in the
 *     session; and
 *  2. the id was DELIVERED as the genuine built-in (`isBuiltinStationControl`),
 *     checking the entry that actually wins delivery (last-write-wins on the
 *     server-id key, mirroring claude-mcp-passthrough.ts / mcp-manager.ts) —
 *     never a same-id impostor.
 * Provenance defaults to `'self-reported'` (fail-closed): a caller must
 * explicitly assert an authentic name. Unknown/absent toolServers also fail
 * closed. Non-reserved server names (a user's own `github` integration they
 * chose to auto-approve) are unaffected: the author controls both the pattern
 * and the integration, so there is no reserved-name spoofing boundary.
 */
export function isAutoApprovedExternalTool(
  toolName: string,
  patterns: string[] | undefined,
  resolvedToolServers?: readonly ResolvedAgentToolServer[],
  toolNameProvenance: ExternalToolNameProvenance = 'self-reported',
): boolean {
  if (!patterns || patterns.length === 0) return false;
  const canonical = canonicalizeExternalToolName(toolName);
  const matched =
    isAutoApproved(toolName, patterns) ||
    (canonical !== toolName && isAutoApproved(canonical, patterns));
  if (!matched) return false;

  const reservedServer = reservedBuiltinServerForTool(toolName);
  if (reservedServer !== null) {
    // A privileged reserved name never auto-approves on an unverifiable
    // (self-reported) tool name — this is the ACP case (Probe A).
    if (toolNameProvenance !== 'authentic') return false;
    // Check the entry that actually wins delivery (last-write-wins per id),
    // not merely "some entry with this id looks genuine" (Probe B).
    const delivered = (resolvedToolServers ?? [])
      .filter((server) => server.id === reservedServer)
      .at(-1);
    return (
      !!delivered &&
      isBuiltinStationControl(delivered.id, {
        id: delivered.id,
        command: delivered.command,
        args: delivered.args,
      } as ToolDef)
    );
  }
  return true;
}
