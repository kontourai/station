/**
 * #3483: the untrusted-content permission for MCP calls Station carries for
 * an external engine (Claude Code, Codex, ACP).
 *
 * Station sees those calls at two seams it owns: the station-control
 * authority guard and the OAuth proxy for remote servers. In a conversation
 * marked as having read untrusted content, each call takes the tool's
 * permission there: `deny` refuses, `allow` passes, and `ask` passes only on
 * a person's approval of that exact tool in that conversation, recorded when
 * the person answered the engine's request (one call per approval, for ten
 * minutes). Neither seam can ask a person itself, so an `ask` with no
 * recorded approval is refused.
 *
 * Calls an engine makes to a server it connects to itself never reach
 * Station; `externalEngineCoverage` says which servers those are.
 */

import type {
  IntegrationEngineCoverage,
  ToolDef,
  UntrustedContentPermission,
} from '@kontourai/station-contracts/tool';
import { stationControlToolPolicy } from '../../tools/station-control-policy.js';
import {
  sharedUntrustedContentLedger,
  type UntrustedContentLedger,
  untrustedContentDecision,
} from './untrusted-content-policy.js';

const APPROVAL_TTL_MS = 10 * 60_000;
/** Approvals held; the oldest is dropped first, which can only refuse a call. */
const APPROVAL_LIMIT = 1_000;

const approvals = new Map<string, number[]>();
const approvalKey = (conversationId: string, serverId: string, tool: string) =>
  JSON.stringify([conversationId, serverId, tool]);

/** `mcp__<server>__<tool>`, refused when the separator is ambiguous. */
export function parseExternalMcpToolName(
  name: string,
): { serverId: string; toolName: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const suffix = name.slice(5);
  const parts = suffix.split('__');
  if (parts.length !== 2 || suffix.includes('___')) return undefined;
  const [serverId, toolName] = parts as [string, string];
  return serverId && toolName ? { serverId, toolName } : undefined;
}

/** A person approved this tool call in this conversation. */
export function recordPersonApprovedCall(
  conversationId: string,
  serverId: string,
  toolName: string,
  now = Date.now(),
): void {
  const key = approvalKey(conversationId, serverId, toolName);
  const list = approvals.get(key) ?? [];
  list.push(now + APPROVAL_TTL_MS);
  approvals.delete(key);
  approvals.set(key, list);
  let held = 0;
  for (const entries of approvals.values()) held += entries.length;
  for (const [oldest, entries] of approvals) {
    if (held <= APPROVAL_LIMIT) break;
    held -= entries.length;
    approvals.delete(oldest);
  }
}

/** Records the approval when the engine's tool name is an MCP tool. */
export function recordPersonApprovedExternalTool(
  conversationId: string,
  externalToolName: unknown,
): void {
  if (typeof externalToolName !== 'string') return;
  const parsed = parseExternalMcpToolName(externalToolName);
  if (parsed)
    recordPersonApprovedCall(conversationId, parsed.serverId, parsed.toolName);
}

function consumeApproval(key: string, now: number): boolean {
  const list = approvals.get(key)?.filter((expiry) => expiry > now) ?? [];
  const found = list.length > 0;
  if (found) list.shift();
  if (list.length) approvals.set(key, list);
  else approvals.delete(key);
  return found;
}

/** For tests: forget every recorded approval. */
export function resetPersonApprovedCalls(): void {
  approvals.clear();
}

/**
 * The definition the permission reads. Station-control's read-only tools
 * come from Station's own authority table, not the stored probe.
 */
export function mediatedToolDefinition(
  serverId: string,
  toolName: string,
  def: ToolDef | undefined,
): ToolDef | undefined {
  if (!def || serverId !== 'station-control') return def;
  const policy = stationControlToolPolicy(toolName);
  if (!policy) return def;
  return {
    ...def,
    probe: {
      ok: true,
      toolCount: 1,
      checkedAt: new Date(0).toISOString(),
      ...def.probe,
      tools: [
        ...(def.probe?.tools ?? []).filter((tool) => tool.name !== toolName),
        { name: toolName, readOnly: policy.toolClass === 'read-only' },
      ],
    },
  };
}

export type MediatedGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

const STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const;

/**
 * The permission for one mediated call. `conversationIds` names every id the
 * call is known by (a session and its conversation); any marked one counts.
 * When the seam cannot tell which of several tools made the call (a route
 * several station-control tools share), the strictest permission among them
 * applies, and an `ask` takes an approval recorded for any of them. An
 * unreadable definition asks.
 */
export async function gateMediatedMcpCall(input: {
  conversationIds: readonly (string | undefined)[];
  serverId: string;
  toolNames: readonly string[];
  definition: () => Promise<ToolDef | undefined>;
  ledger?: UntrustedContentLedger;
  now?: number;
}): Promise<MediatedGateResult> {
  const ledger = input.ledger ?? sharedUntrustedContentLedger;
  if (input.toolNames.length === 0) return { allowed: true };
  if (!(await ledger.conversationHasRead(...input.conversationIds)))
    return { allowed: true };
  const stored = await input.definition().catch(() => undefined);
  let permission: UntrustedContentPermission = 'allow';
  for (const toolName of input.toolNames) {
    const decided =
      untrustedContentDecision(
        mediatedToolDefinition(input.serverId, toolName, stored),
        toolName,
      ) ?? 'allow';
    if (STRICTNESS[decided] > STRICTNESS[permission]) permission = decided;
  }
  const named = input.toolNames.join(', ');
  if (permission === 'allow') return { allowed: true };
  if (permission === 'deny')
    return {
      allowed: false,
      reason: `${named} was refused: this conversation read content written by others, and this tool is set to refuse after that.`,
    };
  const now = input.now ?? Date.now();
  for (const id of input.conversationIds) {
    if (!id) continue;
    for (const toolName of input.toolNames)
      if (consumeApproval(approvalKey(id, input.serverId, toolName), now))
        return { allowed: true };
  }
  return {
    allowed: false,
    reason: `${named} needs your approval: this conversation read content written by others. Approve it when the engine asks, or change the tool's untrusted-content permission.`,
  };
}

/**
 * The staged evaluator's untrusted-content stage for an external engine's
 * tool request (`mcp__<server>__<tool>`): the same permission, so an engine
 * that asks Station asks the person. Other names are not MCP calls and are
 * left to the engine's usual policy.
 */
export function externalUntrustedContentPermission(deps: {
  loadIntegration: (id: string) => Promise<ToolDef>;
  ledger?: UntrustedContentLedger;
}) {
  return async (
    tool: { toolName: string },
    invocation: { conversationId?: string },
  ): Promise<UntrustedContentPermission | undefined> => {
    const parsed = parseExternalMcpToolName(tool.toolName);
    if (!parsed) return undefined;
    const ledger = deps.ledger ?? sharedUntrustedContentLedger;
    if (!(await ledger.conversationHasRead(invocation.conversationId)))
      return undefined;
    return untrustedContentDecision(
      mediatedToolDefinition(
        parsed.serverId,
        parsed.toolName,
        await deps.loadIntegration(parsed.serverId).catch(() => undefined),
      ),
      parsed.toolName,
    );
  };
}

/**
 * Where each external engine's calls to this server go, from its transport
 * and how Station delivers it:
 * - `station-gated`: through a Station seam that applies the permission
 *   (station-control, or a remote server signed in through Station's OAuth
 *   proxy);
 * - `engine-direct`: the engine connects to the server itself, so Station
 *   cannot gate its calls or see what they return;
 * - `not-delivered`: Station does not give this server to that engine.
 * `undefined` for Station's other built-ins, which these engines do not use
 * as integrations.
 */
export function externalEngineCoverage(
  def: {
    id: string;
    kind: string;
    transport?: string;
    credentialOwnership?: unknown;
    probe?: { authorization?: unknown };
  },
  options: {
    builtin: boolean;
    catalogSupplied: boolean;
    /** The server needs secret environment values. */
    secrets: boolean;
  },
): IntegrationEngineCoverage[] | undefined {
  if (def.id === 'station-control')
    return (['claude', 'codex', 'acp'] as const).map((engine) => ({
      engine,
      coverage: 'station-gated',
    }));
  if (options.builtin || def.kind !== 'mcp') return undefined;
  // A remote server always names its transport; an unnamed one runs a command.
  const transport = def.transport ?? 'stdio';
  if (transport === 'sse' || transport === 'streamable-http') {
    // Claude Code and Codex reach a signed-in server only through Station's
    // OAuth proxy; a catalog server is never handed over directly.
    const proxied = Boolean(
      def.credentialOwnership || def.probe?.authorization,
    );
    const remote = proxied
      ? 'station-gated'
      : options.catalogSupplied
        ? 'not-delivered'
        : 'engine-direct';
    return [
      { engine: 'claude', coverage: remote },
      { engine: 'codex', coverage: remote },
      // ACP receives only stdio servers.
      { engine: 'acp', coverage: 'not-delivered' },
    ];
  }
  if (transport === 'stdio') {
    const secrets = options.secrets;
    return [
      { engine: 'claude', coverage: 'engine-direct' },
      { engine: 'codex', coverage: 'engine-direct' },
      // ACP never receives a server that needs secrets.
      { engine: 'acp', coverage: secrets ? 'not-delivered' : 'engine-direct' },
    ];
  }
  return undefined;
}
