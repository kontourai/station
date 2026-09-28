/**
 * The delegation context a dispatch stamps onto the session it starts
 * (#2601): `POST /api/orchestration/chat*`, `POST /api/orchestration/
 * delegations`, and the station-control tools' forwards to a saved
 * Environment (`GET /api/orchestration/station-control/caller/delegation`).
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
 *    Every assurance counts, `bearer-exposed` included: a same-user process
 *    that copied a Codex session's URL token can act as that session, and
 *    this derivation then names THAT session's lineage, which is the most a
 *    copied credential can claim. Treating such callers as unverified would
 *    let every Codex model omit its lineage again.
 *  - Any other Station-internal request (Station's pooled engine child, or
 *    any holder of the internal token) keeps a body context only when
 *    Station's runtime attested it (`delegation-attestation.ts`). Otherwise
 *    it claims no lineage: the session it starts is a root.
 *  - A request from outside this Station's process passes its context
 *    through unchanged: a peer Station forwarding its own child, or an
 *    operator, paired-device or hosted-user credential. None of those is
 *    reachable through `delegate_task`/`send_message` on this Station; a
 *    peer's context is what the SENDING Station derived (or, for its callers
 *    that are neither verified nor attested, what they claimed), and this
 *    Station cannot verify another Station's lineage.
 */
import type {
  AgentDelegationContext,
  AgentSpec,
} from '@kontourai/station-contracts/agent';
import { parseEngineId } from '@kontourai/station-contracts/agent-identity';
import { isAgentConfigNotFound } from '../../domain/config-loader-agents.js';
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
  /**
   * The engine (`provider`) of the same record `startedMetadata` reads
   * (`OrchestrationService.firstStartedEngineOfThread`).
   */
  sessionEngine(sessionId: string): string | undefined;
  /**
   * The Agent spec for a slug. Throws `AgentConfigNotFoundError` when no spec
   * is stored, which is the normal state of a registry default Agent.
   */
  loadAgentSpec(agentSlug: string): Promise<AgentSpec>;
  /** Whether the Agent registry lists this slug as a built-in default. */
  isRegistryDefaultAgent(agentSlug: string): Promise<boolean>;
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
 * The Agent policy a calling session's children are bounded by.
 *
 * Follows `composeAgentExecutionConfigLoader`: a registry default Agent
 * (`station`, and `claude`/`codex` once adopted) is deliberately never
 * written to `agents/`, so ABSENCE of its spec is ordinary and means the
 * default policy (`createChildDelegationContext` with no spec).
 *
 * Today no stored spec can carry a delegation policy: the agent schema
 * (`schemas/agent.schema.json`, `additionalProperties: false`) has no
 * `delegation` field, so every readable spec also yields the default policy
 * (as it does for Station's own engine). The spec is still read, and a spec
 * that exists but cannot be read, or an absent spec for a slug the registry
 * does not list, is refused rather than defaulted: the derivation never
 * asserts a policy for an Agent Station could not read, the posture of
 * `composeAgentExecutionConfigLoader`, and a policy field added to the
 * schema later cannot be bypassed by making the spec unreadable.
 */
async function callerAgentPolicy(
  agentSlug: string,
  sources: Pick<
    RequestDelegationSources,
    'loadAgentSpec' | 'isRegistryDefaultAgent'
  >,
): Promise<AgentSpec | undefined> {
  try {
    return await sources.loadAgentSpec(agentSlug);
  } catch (error) {
    if (
      isAgentConfigNotFound(error) &&
      (await sources.isRegistryDefaultAgent(agentSlug).catch(() => false))
    )
      return undefined;
    throw new DelegationLineageUnavailableError(
      `its Agent '${agentSlug}' could not be read.`,
    );
  }
}

/**
 * Who the calling session delegates as. An Agent-started session names its
 * Agent. The one live session kind with no Agent is an ADOPTED session
 * (`attached-session-adoption.ts` records `adoptedFromThreadId` and no Agent):
 * it runs on its engine with no Agent spec, so it is named by that engine and
 * bounded by the default policy. Read-only followed sessions never hold a
 * station-control credential, so they never reach here. Anything else with
 * no recorded Agent is refused.
 */
async function callerIdentity(
  sessionId: string,
  metadata: Record<string, unknown> | undefined,
  sources: Pick<
    RequestDelegationSources,
    'sessionEngine' | 'loadAgentSpec' | 'isRegistryDefaultAgent'
  >,
): Promise<{ agentSlug: string; spec: AgentSpec | undefined }> {
  const agentSlug =
    nonEmptyString(metadata?.agentSlug) ?? nonEmptyString(metadata?.agentId);
  if (agentSlug)
    return { agentSlug, spec: await callerAgentPolicy(agentSlug, sources) };
  if (nonEmptyString(metadata?.adoptedFromThreadId)) {
    // The contract's clean-identity parse, the same rule `agentId` applies
    // when the child context is built, so an engine it would reject is this
    // typed refusal rather than an untyped throw.
    const engine = parseEngineId(sources.sessionEngine(sessionId));
    if (engine) return { agentSlug: engine, spec: undefined };
  }
  throw new DelegationLineageUnavailableError(
    'the session has no recorded Agent.',
  );
}

/**
 * The child context of a verified calling session, derived from that
 * session's records alone. Throws `DelegationDepthLimitError` at the limit.
 */
async function deriveCallerChildDelegation(
  caller: StationControlCaller,
  sources: Pick<
    RequestDelegationSources,
    | 'startedMetadata'
    | 'sessionEngine'
    | 'loadAgentSpec'
    | 'isRegistryDefaultAgent'
  >,
): Promise<AgentDelegationContext> {
  const metadata = sources.startedMetadata(caller.sessionId);
  const current = recordedDelegation(metadata?.delegation);
  if (current === false)
    throw new DelegationLineageUnavailableError(
      'the session recorded a malformed delegation context.',
    );
  const { agentSlug, spec } = await callerIdentity(
    caller.sessionId,
    metadata,
    sources,
  );
  return createChildDelegationContext({
    agentSlug,
    // The conversation Station records for the session; a session with none
    // is named by its own id, never left out (an absent parent reads as a
    // root to every consumer).
    conversationId: caller.conversationId ?? caller.sessionId,
    ...(spec ? { spec } : {}),
    ...(current ? { current } : {}),
  });
}

/**
 * For the station-control tools' forwards to ANOTHER Station: the child
 * context this Station derives for the request's verified caller, or `null`
 * when the request carries none (the tool then keeps its pre-#2601
 * behaviour). Throws the same refusals as the local routes, so the depth
 * limit holds before anything is forwarded.
 */
export function createCallerDelegationDeriver(
  sources: RequestDelegationSources,
): (request: Request) => Promise<AgentDelegationContext | null> {
  return async (request) => {
    if (!sources.isInternalRequest(request)) return null;
    const caller = sources.resolveCaller(request);
    return caller ? deriveCallerChildDelegation(caller, sources) : null;
  };
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
