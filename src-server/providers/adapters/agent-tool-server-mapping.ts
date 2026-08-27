/**
 * Station#1157: the ResolvedAgentToolServer → ToolDef mapping shared by
 * every external-engine adapter that delivers an agent's authored
 * `toolServers` to its engine (ACP today; Claude as of #1157). Lives here,
 * not duplicated per adapter, so the resolved-tool-server shape has exactly
 * one translation into the adapter-facing `ToolDef` — see
 * `docs/design/agent-engine-unification.md` §5's single-source-of-truth
 * requirement, the same rationale `engine-capability-matrix.ts` already
 * documents for the capability matrix itself.
 *
 * Originally `acp-adapter.ts`'s private `toPassthroughToolDef` (#895 wave
 * A); moved here unchanged when the Claude adapter needed the identical
 * mapping (#1157) rather than a second copy.
 */
import type { ResolvedAgentToolServer } from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';

/**
 * Rebuild a passthrough `ToolDef` from an already-resolved
 * `ResolvedAgentToolServer` (no Station tool-registry lookup — the
 * orchestration-layer resolver already did that). Always `kind: 'mcp'` with
 * no `env`: `ResolvedAgentToolServer` structurally cannot carry one (the
 * secret boundary is enforced at resolution, see
 * session-agent-resolution.ts). Engine-specific env injection (e.g. the
 * station-control runtime token) happens downstream of this pure mapping,
 * per engine, because the security posture of "downstream" differs per
 * engine — see `claude-mcp-passthrough.ts`'s header comment for why that
 * injection is safe for Claude but deliberately NOT applied here (ACP's
 * `session/new` payload is visible to the external ACP agent app, not
 * confined to a Station-spawned child).
 */
export function toPassthroughToolDef(server: ResolvedAgentToolServer): ToolDef {
  return {
    id: server.id,
    kind: 'mcp',
    displayName: server.displayName,
    transport: server.transport,
    command: server.command,
    args: server.args,
    endpoint: server.endpoint,
  };
}
