/**
 * The delegation context a REST dispatch (`POST /api/orchestration/chat*`,
 * `POST /api/orchestration/delegations`) stamps onto the session it starts
 * (#2601).
 *
 * `delegate_task` and `send_message` used to forward the model-written
 * `_delegation` tool argument into the child's `session.started` metadata, so
 * an external engine's model could omit it (every child a fresh root, free of
 * the child tool denials) or name another tree's root. Station's own engine
 * already derived it server-side (`mcp-manager.ts`). Now both paths use the
 * one derivation, `createChildDelegationContext`, and a body's context is
 * never what a Station-internal request stamps:
 *
 *  - A request carrying a verified station-control caller (Codex URL token,
 *    ACP header token, the Claude in-process SDK, a per-session stdio child)
 *    gets the child context derived from THAT session's own records: its
 *    Agent, its conversation, its Agent's delegation policy and the context
 *    it was started with. The body's context is ignored, including its
 *    absence, and the depth limit is enforced here for every engine.
 *  - Any other Station-internal request (Station's pooled engine child, or
 *    any holder of the internal token) keeps a body context only when
 *    Station's runtime attested it (`delegation-attestation.ts`). Otherwise
 *    it claims no lineage: the session it starts is a root.
 *  - A request from outside this Station's process (a peer Station
 *    forwarding its own child, an operator or device credential) is not an
 *    agent of this Station, and its context passes through unchanged. It is
 *    what the SENDER asserts; this Station cannot verify another Station's
 *    lineage (see the residual note on #2601).
 */
import type {
  AgentDelegationContext,
  AgentSpec,
} from '@kontourai/station-contracts/agent';
import type { StationControlCaller } from '../../tools/station-control-shared.js';
import { createChildDelegationContext } from './delegation.js';
import { verifyDelegationContextAttestation } from './delegation-attestation.js';

/**
 * The calling session's records do not support deriving a child context (no
 * recorded Agent, an unreadable Agent spec, or a malformed recorded context).
 * Refused rather than letting the child start as a root, which is the
 * forgery this module exists to close.
 */
class DelegationLineageUnavailableError extends Error {
  readonly code = 'delegation_lineage_unavailable' as const;
  constructor(reason: string) {
    super(
      `Station could not derive this delegation from the calling session: ${reason}`,
    );
    this.name = 'DelegationLineageUnavailableError';
  }
}

export interface RequestDelegationSources {
  /** True only for Station's own internal principal. */
  isInternalRequest(request: Request): boolean;
  /** The verified station-control caller the request's credential names. */
  resolveCaller(request: Request): StationControlCaller | null;
  /** The metadata a session STARTED with (its first `session.started`). */
  startedMetadata(sessionId: string): Record<string, unknown> | undefined;
  /** The Agent spec for a slug; throws when there is none. */
  loadAgentSpec(agentSlug: string): Promise<AgentSpec>;
}

export interface ClaimedRequestDelegation {
  readonly delegation?: AgentDelegationContext;
  readonly attestation?: string;
}

export type RequestDelegationResolver = (
  request: Request,
  claimed: ClaimedRequestDelegation,
) => Promise<AgentDelegationContext | undefined>;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalStrings(value: unknown): string[] | undefined | false {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => nonEmptyString(item))
    ? [...(value as string[])]
    : false;
}

/**
 * The context the calling session was started with, read back from its own
 * record. `undefined` for a root session; `false` for a record that is not a
 * context, which the caller refuses rather than reading as a root.
 */
function recordedDelegation(
  value: unknown,
): AgentDelegationContext | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const parentAgentSlug = nonEmptyString(record.parentAgentSlug);
  const rootAgentSlug = nonEmptyString(record.rootAgentSlug);
  const allowedTools = optionalStrings(record.allowedTools);
  const blockedTools = optionalStrings(record.blockedTools);
  if (
    record.mode !== 'isolated-child' ||
    !Number.isInteger(record.depth) ||
    (record.depth as number) < 0 ||
    !Number.isInteger(record.maxDepth) ||
    (record.maxDepth as number) < 1 ||
    !parentAgentSlug ||
    !rootAgentSlug ||
    allowedTools === false ||
    blockedTools === false
  )
    return false;
  const parentConversationId = nonEmptyString(record.parentConversationId);
  const rootConversationId = nonEmptyString(record.rootConversationId);
  return {
    mode: 'isolated-child',
    depth: record.depth as number,
    maxDepth: record.maxDepth as number,
    parentAgentSlug:
      parentAgentSlug as AgentDelegationContext['parentAgentSlug'],
    ...(parentConversationId ? { parentConversationId } : {}),
    rootAgentSlug: rootAgentSlug as AgentDelegationContext['rootAgentSlug'],
    ...(rootConversationId ? { rootConversationId } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(blockedTools ? { blockedTools } : {}),
    ...(record.denyApprovals === true ? { denyApprovals: true } : {}),
  };
}

/**
 * The child context of a verified calling session, derived from that
 * session's records alone. Throws `DelegationDepthLimitError` at the limit.
 */
async function deriveCallerChildDelegation(
  caller: StationControlCaller,
  sources: Pick<RequestDelegationSources, 'startedMetadata' | 'loadAgentSpec'>,
): Promise<AgentDelegationContext> {
  const metadata = sources.startedMetadata(caller.sessionId);
  const agentSlug =
    nonEmptyString(metadata?.agentSlug) ?? nonEmptyString(metadata?.agentId);
  if (!agentSlug)
    throw new DelegationLineageUnavailableError(
      'the session has no recorded Agent.',
    );
  const current = recordedDelegation(metadata?.delegation);
  if (current === false)
    throw new DelegationLineageUnavailableError(
      'the session recorded a malformed delegation context.',
    );
  let spec: AgentSpec;
  try {
    spec = await sources.loadAgentSpec(agentSlug);
  } catch {
    // Its policy (maxDepth, tool denials) is what bounds the child, so a
    // missing spec is not read as the default policy.
    throw new DelegationLineageUnavailableError(
      `its Agent '${agentSlug}' could not be read.`,
    );
  }
  return createChildDelegationContext({
    agentSlug,
    // The conversation Station records for the session; a session with none
    // is named by its own id, never left out (an absent parent reads as a
    // root to every consumer).
    conversationId: caller.conversationId ?? caller.sessionId,
    spec,
    ...(current ? { current } : {}),
  });
}

export function createRequestDelegationResolver(
  sources: RequestDelegationSources,
): RequestDelegationResolver {
  return async (request, claimed) => {
    if (!sources.isInternalRequest(request)) return claimed.delegation;
    const caller = sources.resolveCaller(request);
    if (caller) return deriveCallerChildDelegation(caller, sources);
    return claimed.delegation &&
      verifyDelegationContextAttestation(
        claimed.delegation,
        claimed.attestation,
      )
      ? claimed.delegation
      : undefined;
  };
}
