import { createHash } from 'node:crypto';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  AgentRunFailureKind,
  AgentRunStatus,
  AgentRunSummary,
  OrchestrationDelegationContext,
  OrchestrationSessionSummary,
  TurnProgressObservation,
} from '@kontourai/station-contracts/orchestration';
import type {
  ModelLaunchPlan,
  ModelSelectionReceipt,
  ProviderKind,
  ProviderSession,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import {
  ENGINE_SESSION_BINDING_DEAD_CODE,
  MODEL_LAUNCH_PLAN_METADATA_KEY,
  MODEL_SELECTION_RECEIPT_METADATA_KEY,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  type TenantExecutionContext,
  tenantExecutionContextFromSession,
} from '@kontourai/station-contracts/tenancy';
import type { SessionLifecycleState } from '../../../packages/contracts/src/session-lifecycle.js';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../providers/provider-interfaces.js';
import { withTenantExecutionContext } from '../../runtime/bootstrap/runtime-tenant-context.js';
import { safeSanitizeUIBlockEventProvenance } from '../../runtime/conversation/ui-block-provenance.js';
import { receiptBus } from '../infra/receipt-bus.js';
import { CriticalResourcePostureError } from '../infra/resource-posture.js';
import type { EventStore } from './event-store.js';
import {
  projectRequestAnswerability,
  type SessionAnswerabilityObservation,
} from './open-requests.js';
import {
  acceptsTurnTerminalEvent,
  activeTurnIdForEvents,
  isUnattributedRuntimeError,
  nextTurnIdentityAnchor,
  projectSessionLifecycle,
} from './session-lifecycle-service.js';

const ATTACHED_SESSION_PROJECT_SLUG_MAX_LENGTH = 512;
/** archive#1462: bounds the candidate list replayed out of event metadata. */
const ATTACHED_SESSION_PROJECT_CANDIDATES_MAX = 16;
const DISPLAY_TITLE_MAX_LENGTH = 120;

/**
 * A turn is in-flight (roadmap archive#761) exactly when the most recent of
 * {turn.started, turn.completed, turn.aborted, runtime.error, session.exited}
 * in the thread's event log is a `turn.started` — i.e. a turn.started with no
 * matching completion yet. Deliberately NOT derived from `lifecycleState`:
 * that fold's `running` value is overloaded to also mean "session is
 * live/connected" (session.started/session.configured both project to
 * `running` before any turn has ever begun), so it cannot distinguish an
 * idle-but-connected session from one mid-turn. Approval pauses
 * (request.opened/resolved) intentionally do not touch this — a turn stays
 * open across an in-turn approval, which is exactly the case a deploy must
 * not restart through.
 *
 * `runtime.error` closes the turn (archive#761 review finding): none of the four
 * adapters that can fail a turn (claude-adapter's `consumeMessages` catch,
 * codex-adapter-notifications' `'error'` notification case, acp-adapter's
 * `prompt().catch()`, station-agent-adapter's stream-`failed` and
 * `failTurn()` paths — plus orchestration-service's own dead-adapter-stream
 * handler) ever emits `turn.aborted`/`turn.completed` on failure; without
 * this, the latest tracked event stays `turn.started` forever and
 * `hasActiveTurn` is permanently stuck `true`, rotting the deploy-drain
 * safety property (every future deploy would need `--force`). Audited every
 * `runtime.error` publish site (2026-07-24): all are the final event for
 * that turn along every code path that reaches them — claude-adapter's and
 * station-agent-adapter's turn/session loops always clear their active-turn
 * tracking in the same branch, and acp-adapter's is one arm of a mutually
 * exclusive `.then()`/`.catch()` pair with `turn.completed`. Two sites
 * (codex's `retriable`/`willRetry` error, and orchestration-service's
 * adapter-stream-restart error) are not airtight proof the underlying turn
 * itself is over — codex may retry the same turn without a new
 * `turn.started`, and a restarted adapter-stream consumer may still receive
 * a legitimate later `turn.completed` for a turn that kept running through
 * the hiccup. Both are safe here regardless, because this function folds
 * events in order and always keeps the *latest* tracked event: a genuine
 * later `turn.completed`/`turn.started` still overrides an earlier
 * `runtime.error` exactly as it would override any other stale signal. The
 * only residual gap is a transient window — between a non-terminal
 * `runtime.error` and that eventual real completion event, `hasActiveTurn`
 * under-reports (reads false while the turn is technically still live) —
 * which self-heals the moment the real event arrives and is a strictly
 * smaller, self-correcting risk than the permanent-stuck-`true` bug this
 * closes. The canonical fix (adapters emitting a proper terminal turn event
 * on failure instead of relying on this compensating fold) is deferred to
 * phase 2.
 */
function hasOpenTurn(events: CanonicalRuntimeEvent[]): boolean {
  return activeTurnIdForEvents(events) !== undefined;
}

export function trackOrchestrationSession(options: {
  threadProviders: Map<string, ProviderKind>;
  sessionReadModel: Map<string, ProviderSession>;
  session: ProviderSession;
}): void {
  options.threadProviders.set(
    options.session.threadId,
    options.session.provider,
  );
  options.sessionReadModel.set(options.session.threadId, options.session);
}

export async function resolveOrchestrationAdapterForThread(options: {
  threadId: string;
  threadProviders: Map<string, ProviderKind>;
  requireAdapter: (provider: ProviderKind) => ProviderAdapterShape;
  adapters: ProviderAdapterShape[];
  /**
   * archive#3476: the lazy-materialisation escape hatch, invoked ONLY when no
   * registered adapter holds a live engine for this thread.
   *
   * Boot recovery no longer starts an engine per persisted session (see
   * {@link recoverOrchestrationSessions}), so a session restored from disk is
   * routable state with no process behind it. Every command that genuinely
   * needs an engine passes this hook so the engine materialises on first use;
   * commands that do NOT need one (stop, interrupt, steer) deliberately omit
   * it rather than spawn a process in order to tear it down.
   *
   * Returning `undefined` keeps the historical throw, so a caller that
   * supplies the hook is never worse off than one that does not.
   */
  materializeSession?: (
    threadId: string,
  ) => Promise<ProviderAdapterShape | undefined>;
}): Promise<ProviderAdapterShape> {
  const knownProvider = options.threadProviders.get(options.threadId);
  if (knownProvider) {
    const adapter = options.requireAdapter(knownProvider);
    if (await adapter.hasSession(options.threadId)) return adapter;
    options.threadProviders.delete(options.threadId);
  }

  for (const adapter of options.adapters) {
    if (await adapter.hasSession(options.threadId)) {
      options.threadProviders.set(options.threadId, adapter.provider);
      return adapter;
    }
  }

  const materialized = await options.materializeSession?.(options.threadId);
  if (materialized) {
    options.threadProviders.set(options.threadId, materialized.provider);
    return materialized;
  }

  throw new Error(`No provider session found for thread: ${options.threadId}`);
}

export function projectOrchestrationEventToReadModel(options: {
  event: CanonicalRuntimeEvent;
  threadProviders: Map<string, ProviderKind>;
  sessionReadModel: Map<string, ProviderSession>;
  eventStore?: EventStore;
}): void {
  const { event, threadProviders, sessionReadModel, eventStore } = options;
  const existing = sessionReadModel.get(event.threadId);
  const baseSession: ProviderSession = existing ?? {
    provider: event.provider,
    threadId: event.threadId,
    status: 'ready',
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  };

  let nextSession: ProviderSession | null = baseSession;

  switch (event.method) {
    case 'session.started':
      nextSession = {
        ...baseSession,
        provider: event.provider,
        status: 'connecting',
        createdAt: baseSession.createdAt ?? event.createdAt,
        updatedAt: event.createdAt,
      };
      break;
    case 'session.configured':
      nextSession = {
        ...baseSession,
        // A session already marked terminal keeps that status: 'closed' is
        // preserved today, and a `dead` binding (archive#1827) must not be
        // resurrected to 'ready' by a stray/late configured event either —
        // in practice recovery never restarts a dead session (it's skipped
        // in `recoverOrchestrationSessions`, same as closed), so this is a
        // defensive mirror of the 'closed' guard, not a load-bearing path.
        status:
          baseSession.status === 'closed' || baseSession.status === 'dead'
            ? baseSession.status
            : 'ready',
        model: event.model ?? baseSession.model,
        updatedAt: event.createdAt,
      };
      break;
    case 'session.state-changed':
      nextSession = {
        ...baseSession,
        status: mapOrchestrationSessionState(event.to),
        updatedAt: event.createdAt,
      };
      break;
    case 'session.exited':
      nextSession = {
        ...baseSession,
        status: 'closed',
        updatedAt: event.createdAt,
      };
      break;
    case 'runtime.error':
      // archive#1827: a `runtime.error` carrying this code is a provider
      // adapter's STRUCTURED report that the underlying engine binding this
      // session holds can never resume — not a generic/possibly-transient
      // failure. Marking the session `dead` (never `closed`) is the whole
      // fix: `closed` would run `markSessionClosed` below, which NULLs
      // `resumeCursor` — the exact archive#1090 data loss this must not
      // repeat — and every OTHER `runtime.error` (no code, or a different
      // code, e.g. `SESSION_RECOVERY_FAILED_CODE`) intentionally changes
      // nothing here, preserving archive#1090's contract byte-for-byte: a
      // recoverable failure keeps its `status` untouched by this event and
      // stays in the recovery set.
      nextSession =
        event.code === ENGINE_SESSION_BINDING_DEAD_CODE
          ? { ...baseSession, status: 'dead', updatedAt: event.createdAt }
          : existing
            ? { ...existing, updatedAt: event.createdAt }
            : null;
      break;
    default:
      nextSession = existing
        ? { ...existing, updatedAt: event.createdAt }
        : null;
      break;
  }

  if (!nextSession) return;
  trackOrchestrationSession({
    threadProviders,
    sessionReadModel,
    session: nextSession,
  });
  if (nextSession.status === 'closed') {
    eventStore?.markSessionClosed(nextSession.threadId, nextSession.provider);
    return;
  }
  eventStore?.upsertSession(nextSession);
}

export function buildOrchestrationSessionSummary(options: {
  persisted?: ProviderSession;
  loaded?: ProviderSession;
  events?: CanonicalRuntimeEvent[];
  /**
   * Overrides `events.length` for the summary's `eventCount` (archive#1867).
   * Callers that read only a bounded recent tail of events still report the
   * thread's true total via a separate `COUNT(*)`; without this override the
   * count would reflect only the tail size and silently underreport activity
   * for long sessions.
   */
  eventCount?: number;
  /**
   * REQUIRED (archive#1778 / ADR 0012). The wire type's `answerability`
   * member is required, and this builder is the only thing that can populate
   * it — but it cannot compute the process-local half, so the caller must
   * hand it over. That is the enforcement: a new emission path cannot reach
   * `OrchestrationSessionSummary` without stating whose process observed
   * what, and when.
   */
  answerability: SessionAnswerabilityObservation;
  /** Process-local watchdog observation; never reconstructed from event time. */
  turnProgress?: TurnProgressObservation;
}): OrchestrationSessionSummary {
  const base = options.loaded ?? options.persisted;
  if (!base) {
    throw new Error('A persisted or loaded session is required');
  }

  const events = options.events ?? [];
  const lastEvent = events.at(-1);
  const lifecycle = projectSessionLifecycle({ session: base, events });
  const delegation = extractDelegationContext(events);
  const effectiveSelection = extractEffectiveModelSelection(events);
  const selectionReceipt = extractModelSelectionReceipt(events);
  const modelLaunchPlan = extractModelLaunchPlan(events);
  const reportedModel = extractReportedModel(events);
  const conversationIdentity = extractConversationIdentity(events);
  const displayTitle = extractDisplayTitle(events);
  const controlMode = base.controlMode ?? 'station-owned';
  const {
    projectSlug: lifecycleProjectSlug,
    assignedAgentSlug,
    ...lifecycleWithoutProjectSlug
  } = lifecycle;
  const attachedAttribution =
    controlMode === 'read-only-attached'
      ? extractAttachedSessionAttribution(events)
      : undefined;
  const projectSlug =
    delegation?.projectSlug ??
    (controlMode === 'read-only-attached'
      ? attachedAttribution?.state === 'attributed'
        ? attachedAttribution.slug
        : undefined
      : lifecycleProjectSlug);
  // archive#1462: only meaningful when nothing attributed the session. Note
  // this is now decided by ONE scan (see `extractAttachedSessionAttribution`)
  // — an older slug no longer outranks a newer ambiguity marker, which is
  // what let a corrected attribution be written and then ignored.
  const projectAttribution =
    !projectSlug && attachedAttribution?.state === 'ambiguous'
      ? {
          state: 'ambiguous' as const,
          candidates: attachedAttribution.candidates,
          ...(attachedAttribution.omittedCandidates
            ? { omittedCandidates: attachedAttribution.omittedCandidates }
            : {}),
        }
      : undefined;

  return {
    provider: base.provider,
    threadId: base.threadId,
    status: base.status,
    controlMode,
    // ONE call, at the one boundary where a summary becomes a response. The
    // fold above stays pure — no process-local fact ever enters
    // `projectSessionLifecycle`, so the same log yields the same
    // `lifecycleState` in every process at every moment (ADR 0012, rejected
    // option b).
    answerability: projectRequestAnswerability({
      threadAttachment: options.answerability.threadAttachment,
      lifecycleState: lifecycle.lifecycleState,
      providerRegistered: options.answerability.providerRegistered,
      observedBy: options.answerability.observedBy,
      observedAt: options.answerability.observedAt,
    }),
    ...(base.model ? { model: base.model } : {}),
    ...(base.cwd ? { cwd: base.cwd } : {}),
    ...(base.resumeCursor !== undefined
      ? { resumeCursor: base.resumeCursor }
      : {}),
    ...(base.attachedSource ? { attachedSource: base.attachedSource } : {}),
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    isLoaded: Boolean(options.loaded),
    isPersisted: Boolean(options.persisted),
    eventCount: options.eventCount ?? events.length,
    ...lifecycleWithoutProjectSlug,
    ...(assignedAgentSlug
      ? { assignedAgentSlug: agentId(assignedAgentSlug) }
      : {}),
    ...(projectSlug ? { projectSlug } : {}),
    ...conversationIdentity,
    ...(projectAttribution ? { projectAttribution } : {}),
    ...(lastEvent
      ? {
          lastEventAt: lastEvent.createdAt,
          lastEventMethod: lastEvent.method,
        }
      : {}),
    ...(options.turnProgress ? { turnProgress: options.turnProgress } : {}),
    ...(delegation ? { delegation } : {}),
    ...(displayTitle ? { displayTitle } : {}),
    ...effectiveSelection,
    ...((selectionReceipt.requestedModel ?? effectiveSelection.effectiveModel)
      ? {
          requestedModel:
            selectionReceipt.requestedModel ??
            effectiveSelection.effectiveModel,
        }
      : {}),
    ...(selectionReceipt.appliedModel
      ? { appliedModel: selectionReceipt.appliedModel }
      : {}),
    ...(modelLaunchPlan ? { modelLaunchPlan } : {}),
    ...(reportedModel ? { reportedModel } : {}),
    hasActiveTurn: hasOpenTurn(events),
  };
}

function extractConversationIdentity(events: CanonicalRuntimeEvent[]): {
  conversationId?: string;
  environmentId?: string;
} {
  let conversationId: string | undefined;
  let environmentId: string | undefined;
  for (const event of [...events].reverse()) {
    if (
      event.method !== 'session.configured' &&
      event.method !== 'session.started'
    ) {
      continue;
    }
    const metadata =
      event.metadata && typeof event.metadata === 'object'
        ? event.metadata
        : undefined;
    conversationId ??= stringMeta(metadata, 'conversationId');
    environmentId ??= stringMeta(metadata, 'environmentId');
    if (conversationId && environmentId) break;
  }
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(environmentId ? { environmentId } : {}),
  };
}

/** The first accepted start plan is durable across later resume events. */
function extractModelLaunchPlan(
  events: CanonicalRuntimeEvent[],
): ModelLaunchPlan | undefined {
  for (const event of events) {
    if (event.method !== 'session.configured') continue;
    const candidate = event.metadata?.[MODEL_LAUNCH_PLAN_METADATA_KEY];
    if (!candidate || typeof candidate !== 'object') continue;
    const plan = candidate as Record<string, unknown>;
    if (
      plan.kind === 'station-resolved' &&
      typeof plan.modelConnectionId === 'string' &&
      typeof plan.modelId === 'string' &&
      plan.evidence === 'catalog-accepted'
    ) {
      return {
        kind: 'station-resolved',
        modelConnectionId: plan.modelConnectionId,
        modelId: plan.modelId,
        evidence: 'catalog-accepted',
      };
    }
    if (
      plan.kind === 'engine-selected' &&
      (plan.evidence === 'adapter-declared' ||
        plan.evidence === 'capability-absent')
    ) {
      return { kind: 'engine-selected', evidence: plan.evidence };
    }
  }
  return undefined;
}

/**
 * Requested/applied identity is typed at the adapter's actual acceptance
 * boundary. Historical `session.configured.model` is intentionally not read:
 * ACP's legacy echo proves that field was not universally an apply receipt.
 */
function extractModelSelectionReceipt(
  events: CanonicalRuntimeEvent[],
): ModelSelectionReceipt {
  let requestedModel: string | undefined;
  let appliedModel: string | undefined;
  for (const event of [...events].reverse()) {
    if (!('metadata' in event)) continue;
    const candidate = event.metadata?.[MODEL_SELECTION_RECEIPT_METADATA_KEY];
    if (!candidate || typeof candidate !== 'object') continue;
    const receipt = candidate as Record<string, unknown>;
    const bounded = (value: unknown) =>
      typeof value === 'string' && value.trim() && value.trim().length <= 256
        ? value.trim()
        : undefined;
    requestedModel ??= bounded(receipt.requestedModel);
    appliedModel ??= bounded(receipt.appliedModel);
    if (requestedModel && appliedModel) break;
  }
  return {
    ...(requestedModel ? { requestedModel } : {}),
    ...(appliedModel ? { appliedModel } : {}),
  };
}

/**
 * Home needs enough identity to distinguish historical sessions without
 * projecting their full prompts. Only the first meaningful user turn is
 * considered, and injected timezone context is removed before bounding.
 */
function extractDisplayTitle(
  events: CanonicalRuntimeEvent[],
): string | undefined {
  for (const event of events) {
    if (event.method !== 'turn.started' || typeof event.prompt !== 'string') {
      continue;
    }
    const normalized = event.prompt
      .replace(/^\s*\[Timezone:\s*[^\]]*\]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) continue;
    const codePoints = Array.from(normalized);
    if (codePoints.length <= DISPLAY_TITLE_MAX_LENGTH) return normalized;
    return `${codePoints
      .slice(0, DISPLAY_TITLE_MAX_LENGTH - 1)
      .join('')
      .trimEnd()}…`;
  }
  return undefined;
}

function effectiveModelBoundary(event: CanonicalRuntimeEvent): {
  effectiveModel?: string;
  effectiveModelOptions?: Record<string, string | number | boolean>;
  boundary: boolean;
} {
  if (
    event.method !== 'turn.started' &&
    event.method !== 'session.configured'
  ) {
    return { boundary: false };
  }
  const metadata =
    event.metadata && typeof event.metadata === 'object'
      ? event.metadata
      : undefined;
  const effectiveModel = stringMeta(metadata, 'effectiveModel');
  const rawOptions = metadata?.effectiveModelOptions;
  const effectiveModelOptions =
    rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
      ? Object.fromEntries(
          Object.entries(rawOptions)
            .slice(0, 16)
            .filter(
              (entry): entry is [string, string | number | boolean] =>
                entry[0].length <= 128 &&
                (typeof entry[1] === 'string' ||
                  (typeof entry[1] === 'number' && Number.isFinite(entry[1])) ||
                  typeof entry[1] === 'boolean') &&
                (typeof entry[1] !== 'string' || entry[1].length <= 128),
            ),
        )
      : undefined;
  const boundary =
    Boolean(effectiveModel) ||
    Object.keys(effectiveModelOptions ?? {}).length > 0;
  return {
    boundary,
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(effectiveModel
      ? { effectiveModelOptions: effectiveModelOptions ?? {} }
      : {}),
  };
}

function extractEffectiveModelSelection(events: CanonicalRuntimeEvent[]): {
  effectiveModel?: string;
  effectiveModelOptions?: Record<string, string | number | boolean>;
} {
  for (const event of [...events].reverse()) {
    const selection = effectiveModelBoundary(event);
    if (selection.boundary) {
      return {
        ...(selection.effectiveModel
          ? { effectiveModel: selection.effectiveModel }
          : {}),
        ...(selection.effectiveModel
          ? { effectiveModelOptions: selection.effectiveModelOptions ?? {} }
          : {}),
      };
    }
  }
  return {};
}

/**
 * archive#1182: the latest independently-reported model identity, scanned
 * across every event method an adapter might carry `metadata.reportedModel`
 * on — `session.configured` (Codex's thread/start response, an ACP agent's
 * `model`-category config option), `turn.started` (unused today, reserved
 * for a future per-turn-confirmed-before-start signal), and `turn.completed`
 * (the Claude Agent SDK's per-turn assistant-message model, only known once
 * the turn's API response has arrived). Deliberately never falls back to
 * `effectiveModel` — an absent result here means "this engine did not
 * report," not "assume the requested value."
 *
 * archive#1182 fix round (review-found HIGH): a plain reverse scan can walk
 * straight past a model switch and surface a `reportedModel` that belongs to
 * a superseded model generation — e.g. Codex's archive#903 restatement republishes
 * `session.configured` with the new `model` but no `metadata` at all, and
 * Claude's `sendTurn` moves `record.session.model` with no republish, so the
 * new model only shows up via the next `turn.started`'s `effectiveModel`.
 * Either way, once we hit (scanning newest-first) a `session.configured` or
 * `turn.started` that establishes a fresh `effectiveModel` but does NOT carry
 * its own `reportedModel`, that event marks the boundary of the current
 * model generation: every `reportedModel` further back belongs to a prior
 * generation and must not be surfaced as if it confirms the current one. Stop
 * there and report absent rather than keep scanning into older history.
 */
function extractReportedModel(
  events: CanonicalRuntimeEvent[],
): string | undefined {
  for (const event of [...events].reverse()) {
    if (
      event.method !== 'turn.started' &&
      event.method !== 'session.configured' &&
      event.method !== 'turn.completed'
    ) {
      continue;
    }
    const metadata =
      event.metadata && typeof event.metadata === 'object'
        ? event.metadata
        : undefined;
    const reportedModel = stringMeta(metadata, 'reportedModel');
    if (reportedModel) return reportedModel;
    if (effectiveModelBoundary(event).boundary) {
      // A fresh effectiveModel with no reportedModel of its own: everything
      // older belongs to a superseded model. Report absent, not stale.
      return undefined;
    }
  }
  return undefined;
}

type AttachedSessionAttribution =
  | { state: 'attributed'; slug: string }
  | { state: 'ambiguous'; candidates: string[]; omittedCandidates?: number };

/**
 * archive#1462: the attached-session envelope's attribution, as of the LATEST
 * `session.configured` that expresses one.
 *
 * The two states are read by ONE backwards scan on purpose. Reading them
 * separately — "newest event with a slug" and, only if that found nothing,
 * "newest event marked ambiguous" — makes an older slug outrank a newer
 * ambiguity marker, which is precisely the direction that lets a stale
 * arbitrary winner survive a correction (fix round; the follow service's
 * `attributionFingerprint` is the write-side half). An event that expresses
 * neither (a legacy envelope, or one whose slug/candidates fail the bounds
 * below) is not an attribution and is skipped, so the scan keeps looking
 * further back rather than reporting "unattributed" on a malformed record.
 */
function extractAttachedSessionAttribution(
  events: CanonicalRuntimeEvent[],
): AttachedSessionAttribution | undefined {
  for (const event of [...events].reverse()) {
    if (event.method !== 'session.configured') continue;
    const metadata =
      event.metadata && typeof event.metadata === 'object'
        ? event.metadata
        : undefined;
    const projectSlug = stringMeta(metadata, 'projectSlug');
    if (
      projectSlug &&
      projectSlug.length <= ATTACHED_SESSION_PROJECT_SLUG_MAX_LENGTH
    ) {
      return { state: 'attributed', slug: projectSlug };
    }
    if (stringMeta(metadata, 'projectAttribution') !== 'ambiguous') continue;
    const raw = metadata?.projectCandidates;
    if (!Array.isArray(raw)) continue;
    const named = raw.filter(
      (value): value is string =>
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= ATTACHED_SESSION_PROJECT_SLUG_MAX_LENGTH,
    );
    const candidates = named.slice(0, ATTACHED_SESSION_PROJECT_CANDIDATES_MAX);
    if (candidates.length === 0) continue;
    // archive#1462 fix round: rendering 16 of 20 names as if that were the
    // whole list is an honesty gap inside the honesty feature. Carry the
    // count that did not fit so the surface can say so.
    const omitted = named.length - candidates.length;
    return {
      state: 'ambiguous',
      candidates,
      ...(omitted > 0 ? { omittedCandidates: omitted } : {}),
    };
  }
  return undefined;
}

function extractDelegationContext(
  events: CanonicalRuntimeEvent[],
): OrchestrationDelegationContext | undefined {
  for (const event of [...events].reverse()) {
    if (
      event.method !== 'session.configured' &&
      event.method !== 'session.started'
    ) {
      continue;
    }
    const metadata =
      event.metadata && typeof event.metadata === 'object'
        ? event.metadata
        : undefined;
    const taskId = stringMeta(metadata, 'taskId');
    if (!taskId) continue;
    return {
      taskId,
      ...(stringMeta(metadata, 'environmentId')
        ? { environmentId: stringMeta(metadata, 'environmentId') }
        : {}),
      ...(stringMeta(metadata, 'environmentName')
        ? { environmentName: stringMeta(metadata, 'environmentName') }
        : {}),
      ...(stringMeta(metadata, 'connectionId')
        ? { connectionId: stringMeta(metadata, 'connectionId') }
        : {}),
      ...(delegationTargetKind(metadata)
        ? { targetKind: delegationTargetKind(metadata) }
        : {}),
      ...(stringMeta(metadata, 'targetId')
        ? { targetId: stringMeta(metadata, 'targetId') }
        : {}),
      ...(stringMeta(metadata, 'projectSlug')
        ? { projectSlug: stringMeta(metadata, 'projectSlug') }
        : {}),
      ...(delegationProjectSlugJoin(metadata)
        ? { projectSlugJoin: delegationProjectSlugJoin(metadata) }
        : {}),
      ...(stringMeta(metadata, 'parentTaskId')
        ? { parentTaskId: stringMeta(metadata, 'parentTaskId') }
        : {}),
      ...(delegationMode(metadata) ? { mode: delegationMode(metadata) } : {}),
    };
  }
  return undefined;
}

/**
 * The durable event-store fact projection uses these exact one-event reducer
 * predicates. Keeping them beside the session reducer prevents a bounded
 * read from turning a malformed or partial metadata shape into an invented
 * session fact.
 */
export function projectionFactKeysForEvent(
  event: CanonicalRuntimeEvent,
): Array<{ key: string; first?: boolean }> {
  const facts: Array<{ key: string; first?: boolean }> = [];
  if (extractModelLaunchPlan([event])) {
    facts.push({ key: 'model-launch-plan', first: true });
  }
  if (extractDelegationContext([event])) {
    facts.push({ key: 'delegation' });
  }
  if (extractAttachedSessionAttribution([event])) {
    facts.push({ key: 'attribution' });
  }
  const receipt = extractModelSelectionReceipt([event]);
  if (receipt.requestedModel) facts.push({ key: 'model-selection-requested' });
  if (receipt.appliedModel) facts.push({ key: 'model-selection-applied' });
  if (effectiveModelBoundary(event).boundary) {
    facts.push({ key: 'effective-model-boundary' });
  }
  if (extractReportedModel([event])) facts.push({ key: 'reported-model' });
  // A bounded projection retains one latest fact per initiator, not per turn:
  // a session can restart indefinitely, so adding turn identity to the key
  // makes retained state grow forever. The projector still matches event
  // turnId to the current terminal turn before using these facts.
  if (event.method === 'session.stop-settled') {
    facts.push({
      key: `settled-stop:${event.initiatedBy ?? 'unknown'}`,
    });
  }
  return facts;
}

/**
 * archive#3408: `'agent'` is the ONLY value either launch writer puts in the
 * binding event — `station-control-delegation.ts`'s delegated-task start and
 * `execution-target-execution.ts`'s foreground dispatch both write it. This
 * allowlist accepted only `'station-agent'|'agent-app'`, so the projected
 * delegation record for a locally-launched task carried no target binding at
 * all, and `station delegate events` (which reads this projection) refused the
 * caller's own task while `station delegate status` (which reads the raw
 * binding event) accepted it.
 */
function delegationTargetKind(
  metadata: Record<string, unknown> | undefined,
): 'station-agent' | 'agent-app' | 'agent' | undefined {
  const value = metadata?.targetKind;
  return value === 'station-agent' || value === 'agent-app' || value === 'agent'
    ? value
    : undefined;
}

/**
 * archive#1463: an unrecognised value is dropped rather than passed through —
 * a durable record written by a newer Station must not surface a join state
 * this Station cannot describe, and absence already has a defined meaning
 * ("recorded before this field existed").
 */
function delegationProjectSlugJoin(
  metadata: Record<string, unknown> | undefined,
): OrchestrationDelegationContext['projectSlugJoin'] {
  const value = metadata?.projectSlugJoin;
  return value === 'local' ||
    value === 'directory-corroborated' ||
    value === 'unverified-cross-machine'
    ? value
    : undefined;
}

function stringMeta(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function delegationMode(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const delegation = metadata?.delegation;
  if (!delegation || typeof delegation !== 'object') return undefined;
  const mode = (delegation as { mode?: unknown }).mode;
  return typeof mode === 'string' && mode.trim() ? mode : undefined;
}

export function buildAgentRunSummary(options: {
  persisted?: ProviderSession;
  loaded?: ProviderSession;
  events?: CanonicalRuntimeEvent[];
  /**
   * Overrides `events.length` for the run's `eventCount` (archive#1867) —
   * see {@link buildOrchestrationSessionSummary} for the rationale.
   */
  eventCount?: number;
  engineExecution?: AgentRunSummary['engineExecution'];
  /**
   * REQUIRED, for the same reason the summary builder's is (archive#1778):
   * `AgentRunSummary` re-declares a decision folded from the same raw
   * events, so leaving it undecorated leaves one of the three sibling shapes
   * ADR 0012 names outside the enforcement the required member exists to
   * provide.
   */
  answerability: SessionAnswerabilityObservation;
}): AgentRunSummary {
  const base = options.loaded ?? options.persisted;
  if (!base) {
    throw new Error('A persisted or loaded session is required');
  }

  const events = options.events ?? [];
  const lastEvent = events.at(-1);
  const lastError = findTerminalFailureEvent(events);
  const configured = [...events]
    .reverse()
    .find((event) => event.method === 'session.configured');
  const lastResolvedRequestIds = new Set(
    events
      .filter((event) => event.method === 'request.resolved')
      .map((event) => event.requestId),
  );
  const hasOpenRequest = events.some(
    (event) =>
      event.method === 'request.opened' &&
      event.requestId &&
      !lastResolvedRequestIds.has(event.requestId),
  );

  const status = deriveAgentRunStatus({
    sessionStatus: base.status,
    events,
    hasOpenRequest,
  });
  const failureKind =
    status === 'failed' && lastError
      ? classifyAgentRunFailure(lastError)
      : undefined;
  const runtimeThreadId = extractRuntimeThreadId(base.resumeCursor);

  return {
    runId: base.threadId,
    sessionId: base.threadId,
    providerId: base.provider,
    source: 'orchestration',
    engineExecution: options.engineExecution ?? 'unknown',
    // The SAME derivation the session summary carries, over the SAME fold:
    // `projectSessionLifecycle` is re-run here rather than a lifecycle state
    // being passed in, so this shape cannot be decorated against a state
    // that disagrees with the one `buildOrchestrationSessionSummary` folded
    // from the identical inputs.
    answerability: projectRequestAnswerability({
      threadAttachment: options.answerability.threadAttachment,
      lifecycleState: projectSessionLifecycle({ session: base, events })
        .lifecycleState,
      providerRegistered: options.answerability.providerRegistered,
      observedBy: options.answerability.observedBy,
      observedAt: options.answerability.observedAt,
    }),
    status,
    ...(configured?.method === 'session.configured' && configured.cwd
      ? { cwd: configured.cwd }
      : {}),
    ...(runtimeThreadId ? { runtimeThreadId } : {}),
    startedAt: base.createdAt,
    updatedAt: lastEvent?.createdAt ?? base.updatedAt,
    ...(isTerminalAgentRunStatus(status)
      ? { completedAt: lastEvent?.createdAt ?? base.updatedAt }
      : {}),
    ...(failureKind ? { failureKind } : {}),
    ...(lastError?.method === 'runtime.error'
      ? { failureMessage: lastError.message }
      : {}),
    retryEligible: failureKind ? isAgentRunRetryEligible(failureKind) : false,
    attempt: 1,
    eventCount: options.eventCount ?? events.length,
  };
}

export function classifyAgentRunFailure(
  event: Extract<CanonicalRuntimeEvent, { method: 'runtime.error' }>,
): AgentRunFailureKind {
  const code = event.code?.toLowerCase() ?? '';
  const message = event.message.toLowerCase();
  if (code.includes('offline') || message.includes('offline')) {
    return 'runtime_offline';
  }
  if (code.includes('recover') || message.includes('recover')) {
    return 'runtime_recovery';
  }
  if (code.includes('timeout') || message.includes('timeout')) {
    return 'timeout';
  }
  if (code.includes('cancel') || message.includes('cancel')) {
    return 'cancelled';
  }
  if (code.includes('tool')) {
    return 'tool_error';
  }
  if (event.retriable === true) {
    return 'runtime_recovery';
  }
  if (code.includes('agent')) {
    return 'agent_error';
  }
  if (event.retriable === false) {
    return 'agent_error';
  }
  return 'unknown';
}

export function isAgentRunRetryEligible(kind: AgentRunFailureKind): boolean {
  return (
    kind === 'runtime_offline' ||
    kind === 'runtime_recovery' ||
    kind === 'timeout'
  );
}

/**
 * archive#1090: the `code` carried by the `runtime.error` a failed recovery
 * now leaves on the thread. Contains "recover" on purpose —
 * `classifyAgentRunFailure` reads that substring and classifies the run as
 * `runtime_recovery`, which `isAgentRunRetryEligible` treats as retryable.
 * A conversation Station could not reopen IS retryable: the usual cause is a
 * connection setting the user can change back.
 */
export const SESSION_RECOVERY_FAILED_CODE = 'session_recovery_failed';

/**
 * Deterministic event id for a recovery failure, so the same failure recorded
 * on every subsequent restart collapses onto one row via
 * `appendEventIfAbsent`'s `INSERT OR IGNORE`. Without this, leaving the
 * session recoverable (below) would append a fresh identical error to the
 * transcript at every boot.
 *
 * Formatted as a UUID because `eventId` is a UUID everywhere else; the bytes
 * are a sha256 of the thread + message, not randomness.
 */
function recoveryFailureEventId(threadId: string, message: string): string {
  const hex = createHash('sha256')
    .update(`session-recovery-failed\u0000${threadId}\u0000${message}`)
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * archive#3476: everything the engine-start half of session recovery needs.
 *
 * Extracted verbatim from the old body of {@link recoverOrchestrationSessions}
 * — this is the same pipeline that used to run once per persisted session at
 * boot. It now runs once per session, at the moment something actually needs
 * an engine, which is the whole point of the issue: 18 engines / 6.4 GB were
 * spawned 36 seconds after boot for conversations nobody had opened.
 */
export interface RecoveredSessionStartOptions {
  eventStore?: EventStore;
  assertAdapterReady: (
    adapter: ProviderAdapterShape,
    connectionId?: string,
  ) => Promise<void>;
  /** Binds the started session to the adapter now holding its engine. */
  trackStartedSession: (
    session: ProviderSession,
    adapter: ProviderAdapterShape,
  ) => void;
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  /**
   * archive#895 wave B: re-resolve a recovered session's `ResolvedAgentDefinition`
   * (agent-authored tool servers/skills/prompt) before dispatch — the same
   * resolver `OrchestrationService.startSession` runs on a live start.
   * Optional — omitted in installations/tests that don't wire it, in which
   * case recovery input reaches the adapter exactly as before (A5).
   */
  resolveSessionAgent?: (
    input: ProviderSessionStartInput,
  ) => Promise<ProviderSessionStartInput>;
  /**
   * archive#3549 review round 4 (independent, Codex), HIGH: recovery applied
   * `resolveSessionAgent` but NOT the agent's credential-profile pin, and
   * called `adapter.startSession` directly — so a pinned agent whose session
   * was recovered after a restart ran on the CONNECTION's account. The
   * original wrong-account defect survived in this path the whole time the
   * live-start path was being fixed three times over.
   *
   * Deliberately NOT lenient, unlike `resolveSessionAgent` above: that
   * resolver degrading costs a session its authored definition, which is
   * recoverable, while this one degrading bills a turn to the wrong account,
   * which is not. A rejection here refuses the command; it does not quarantine
   * the session.
   */
  applyCredentialProfile?: (
    input: ProviderSessionStartInput,
  ) => Promise<ProviderSessionStartInput>;
  /**
   * archive#895 wave B: replay the latest persisted `session.started` metadata for
   * a thread (reserved capability-delivery key already stripped by the
   * caller) so recovery input carries the same `metadata.agentSlug` /
   * `metadata.connectionId` a live start would have. `undefined` when no
   * metadata survives — recovery still proceeds (ACP falls back to the
   * resume cursor's connectionId; see acp-adapter.ts's archive#895 wave B doc
   * comment).
   */
  readSessionStartMetadata?: (
    threadId: string,
  ) => Record<string, unknown> | undefined;
  /**
   * archive#1011: re-settle the recovered session's working directory the same way a
   * live start does (project binding → `cwd`). Recovery otherwise replays
   * only the `cwd` persisted at start, so a session created before that
   * resolution existed keeps recovering with none — and the engine keeps
   * inheriting the server process's directory. Optional; omitted in
   * installations/tests that don't wire it, in which case the persisted cwd
   * is used exactly as before.
   */
  resolveSessionCwd?: (
    input: ProviderSessionStartInput,
  ) => ProviderSessionStartInput;
  /**
   * Shared model boundary supplied by OrchestrationService. It is invoked
   * before readiness or any adapter callback, including recovery.
   */
  prepareModelLaunch?: (
    adapter: ProviderAdapterShape,
    input: ProviderSessionStartInput,
    retainedModelId?: string,
  ) => ProviderSessionStartInput;
  recordAcceptedModelLaunch?: (
    adapter: ProviderAdapterShape,
    input: ProviderSessionStartInput,
  ) => void;
  /**
   * The same observed-host admission gate used for foreground engine starts.
   * A critical refusal leaves the persisted session recoverable and writes no
   * recovery-failure event — it is a deferral, not a verdict on the session.
   */
  admitEngineStart?: () => Promise<void>;
}

/**
 * archive#3476: start the engine for ONE already-restored session, using the
 * exact input a boot recovery pass used to build.
 *
 * Throws on every failure rather than swallowing it, because the caller is a
 * user-initiated turn: a session that silently never starts is worse than the
 * leak this change removes. Before rethrowing it leaves the same durable
 * evidence boot recovery left (archive#1090) — a `runtime.error` naming the
 * reason and `status: 'error'`, which keeps the row in the recovery set and
 * out of `closed`, so `resumeCursor` survives and the next attempt can work
 * once the user fixes the cause. A `CriticalResourcePostureError` is exempt:
 * the host refused to admit ANY engine start, which says nothing about this
 * session, so it stays untouched and the error propagates as-is.
 */
export async function startRecoveredOrchestrationSession(options: {
  session: ProviderSession;
  adapter: ProviderAdapterShape;
  tenantExecutionContext?: TenantExecutionContext;
  options: RecoveredSessionStartOptions;
}): Promise<ProviderSession> {
  const { session, adapter, tenantExecutionContext } = options;
  const deps = options.options;
  try {
    // Metadata reads can fail for one damaged persisted event. Keep them
    // inside this session's boundary so the caller sees one typed failure.
    const recoveredMetadata = deps.readSessionStartMetadata?.(session.threadId);
    let startInput: ProviderSessionStartInput = {
      threadId: session.threadId,
      provider: session.provider,
      ...(deps.prepareModelLaunch ? {} : { modelId: session.model }),
      cwd: session.cwd,
      resumeCursor: session.resumeCursor,
      persistSession: session.persistSession,
      ...(tenantExecutionContext
        ? {
            tenantExecutionContext: tenantExecutionContextFromSession(
              tenantExecutionContext,
            ),
          }
        : {}),
      metadata: recoveredMetadata,
    };
    if (deps.resolveSessionCwd) {
      startInput = deps.resolveSessionCwd(startInput);
    }
    startInput =
      deps.prepareModelLaunch?.(adapter, startInput, session.model) ??
      startInput;
    // chat-dock-maximize-readiness (AC8): model launch rejection above is
    // deliberately before this potentially side-effecting readiness probe.
    const recoveredConnectionId =
      typeof recoveredMetadata?.connectionId === 'string'
        ? recoveredMetadata.connectionId
        : undefined;
    await deps.assertAdapterReady(adapter, recoveredConnectionId);
    if (deps.resolveSessionAgent) {
      try {
        startInput = await deps.resolveSessionAgent(startInput);
      } catch (error) {
        // Belt-and-suspenders: the resolver's own contract is never-throws
        // (session-agent-resolution.ts), but degrading to the unresolved
        // input on an unexpected throw is strictly safer than failing the
        // turn outright — this is exactly what boot recovery did.
        deps.logger.warn(
          'resolveSessionAgent failed during session recovery; continuing without a resolved agent definition',
          {
            provider: session.provider,
            threadId: session.threadId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    // Fail-closed, and before `admitEngineStart` so a refusal costs no engine
    // slot. Not wrapped in a try/catch: see `applyCredentialProfile`'s docs.
    if (deps.applyCredentialProfile) {
      startInput = await deps.applyCredentialProfile(startInput);
    }
    await deps.admitEngineStart?.();
    const recovered = await withTenantExecutionContext(
      startInput.tenantExecutionContext,
      () => adapter.startSession(startInput),
    );
    deps.recordAcceptedModelLaunch?.(adapter, startInput);
    const nextSession = {
      ...session,
      ...recovered,
      createdAt: session.createdAt,
      model: recovered.model ?? session.model,
      cwd: recovered.cwd ?? session.cwd,
      resumeCursor: recovered.resumeCursor ?? session.resumeCursor,
      continuationSourceThreadId: session.continuationSourceThreadId,
      persistSession: session.persistSession,
      ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
    };
    deps.trackStartedSession(nextSession, adapter);
    deps.eventStore?.upsertSession(nextSession);
    return nextSession;
  } catch (error) {
    if (error instanceof CriticalResourcePostureError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn('Failed to recover provider session', {
      provider: session.provider,
      threadId: session.threadId,
      error: message,
    });
    // archive#1090's contract, preserved byte-for-byte now that the failure
    // happens at first use instead of at boot: a `runtime.error` on the
    // thread so the transcript says why, and `status: 'error'` (never
    // `closed`, which NULLs `resume_cursor`) so the conversation stays
    // reopenable once the user undoes whatever broke it.
    const failedAt = new Date().toISOString();
    // archive#1399 fix round 2, B3: this literal always constructs
    // `method: 'runtime.error'`, never `tool.completed` — routed through
    // the safe sanitizer anyway (a true no-op here) so the writer-inventory
    // ratchet needs no per-call-site exemption reasoning.
    deps.eventStore?.appendEventIfAbsent(
      safeSanitizeUIBlockEventProvenance(
        {
          eventId: recoveryFailureEventId(session.threadId, message),
          provider: session.provider,
          threadId: session.threadId,
          createdAt: failedAt,
          method: 'runtime.error',
          severity: 'error',
          code: SESSION_RECOVERY_FAILED_CODE,
          retriable: true,
          message: `This conversation could not be reopened: ${message}`,
        },
        (warnMessage, meta) => deps.logger.warn(warnMessage, meta),
      ),
    );
    deps.eventStore?.upsertSession({
      ...session,
      status: 'error',
      updatedAt: failedAt,
    });
    throw error;
  }
}

/**
 * Restore every persisted session's STATE at boot — and start no engines.
 *
 * archive#3476: this used to `await adapter.startSession(...)` for every row
 * the skips below did not exclude, serially. On a real installation that meant
 * one engine subprocess per conversation ever created, because nothing ever
 * closes an idle session: 18 engines in a 51-second burst 36 seconds after
 * boot, 6.4 GB resident. It was not even delivering what it cost — that same
 * server logged 14 `acp prerequisites missing` skips and 13 probe timeouts, so
 * most of those processes were spawned, failed their readiness probe, and
 * stayed resident, neither recovered nor reclaimed.
 *
 * The engine now materialises on the session's first turn, via
 * {@link startRecoveredOrchestrationSession} reached through
 * {@link resolveOrchestrationAdapterForThread}'s `materializeSession` hook.
 * That second half is not optional: without it every restored session would
 * fail its first use with `No provider session found for thread`.
 */
export async function recoverOrchestrationSessions(options: {
  adapterRegistry: IProviderAdapterRegistry;
  eventStore?: EventStore;
  /**
   * `adapter` is passed ONLY when that adapter says it already holds the
   * thread — see the `hasSession` call below. It is what binds the session's
   * attachment fact, so handing one over unconditionally would claim this
   * process is holding an engine it is not.
   */
  trackSession: (
    session: ProviderSession,
    adapter?: ProviderAdapterShape,
  ) => void;
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  requireTenantExecutionContext?: () => boolean;
  validateRecoveredTenantExecutionContext?: (
    context: TenantExecutionContext | undefined,
  ) => TenantExecutionContext | undefined;
  /** Removes an invalid persisted row from every in-memory read/publish path. */
  quarantineSession?: (session: ProviderSession) => void;
}): Promise<void> {
  const persistedSessions = options.eventStore?.readSessions() ?? [];
  // archive#1101: threadIds this pass restored — quarantined,
  // read-only-attached, already-closed/dead, and no-adapter sessions are
  // skipped and never appear in the 'session.recovery.completed' milestone
  // this function publishes once the whole pass finishes.
  const restoredThreadIds: string[] = [];
  for (const session of persistedSessions) {
    // Validate BEFORE every recovery escape hatch. In particular, an attached
    // session used to be tracked and published before this check, allowing an
    // invalid hosted row to return through the raw persistence/read-model
    // path without an adapter ever being started.
    const tenantExecutionContext =
      options.validateRecoveredTenantExecutionContext
        ? options.validateRecoveredTenantExecutionContext(
            session.tenantExecutionContext,
          )
        : session.tenantExecutionContext;
    if (options.requireTenantExecutionContext?.() && !tenantExecutionContext) {
      options.quarantineSession?.(session);
      options.eventStore?.markSessionClosed(session.threadId, session.provider);
      options.logger.warn(
        'Hosted provider session was quarantined because its tenant execution context is missing or invalid',
        { provider: session.provider, threadId: session.threadId },
      );
      continue;
    }
    if (session.controlMode === 'read-only-attached') {
      options.trackSession({
        ...session,
        ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
      });
      continue;
    }
    // archive#1827: `dead` (an engine's own structured terminal answer for
    // this SPECIFIC binding, e.g. Claude's "No conversation found with
    // session ID: ...") is skipped exactly like `closed` — recovery must
    // stop replaying it. `error` is deliberately NOT skipped here: that is
    // archive#1090's contract for a possibly user-recoverable failure (a
    // config problem the SAME resumeCursor may work again once fixed), and
    // it must keep being retried on every boot exactly as it does today.
    if (session.status === 'closed' || session.status === 'dead') continue;
    // A provider whose adapter is not registered in this process (an
    // unloaded plugin) is still skipped entirely, exactly as before: its
    // rows have never entered the in-memory read model and this change is
    // not the place to start.
    const adapter = options.adapterRegistry.get(session.provider);
    if (!adapter) continue;
    restoredThreadIds.push(session.threadId);
    // archive#3476: THIS is the whole recovery pass now. The session's state
    // is restored — it is listed, addressable, and resumable — and no engine
    // is started.
    //
    // The adapter is bound ONLY if it says it already holds the thread. That
    // is normally false after a restart (every in-tree adapter's `hasSession`
    // is an in-memory map lookup over sessions this process started), and the
    // point is that it is now DERIVED: the attachment fact `answerability`
    // reads means "an adapter holds this thread", not "recovery ran". An
    // out-of-tree adapter that genuinely survives — one attached to an
    // external process rather than owning a child — reports true here and is
    // correctly recorded as attached without Station starting anything.
    //
    // Guarded because adapters can arrive from runtime-loaded plugins, where
    // the contract is not enforcement: an unhandled throw here would sink the
    // whole pass, and every later session with it. The old per-session
    // try/catch contained exactly that, and this keeps the property — a
    // provider that cannot answer is simply not treated as holding anything.
    let attachedAdapter: ProviderAdapterShape | undefined;
    try {
      if (await adapter.hasSession(session.threadId)) attachedAdapter = adapter;
    } catch (error) {
      options.logger.warn(
        'Provider adapter could not report whether it still holds a recovered thread; treating it as not attached',
        {
          provider: session.provider,
          threadId: session.threadId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    options.trackSession(
      {
        ...session,
        ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
      },
      attachedAdapter,
    );
  }
  // archive#1101: fires once per recoverOrchestrationSessions() call,
  // regardless of the fate of individual sessions in this pass — tests await
  // this instead of a fixed setTimeout() tick after service.initialize() to
  // know the recovery pass has settled. archive#3476 changed what it counts
  // from "attempted to start" to "restored", because there is no longer any
  // start to attempt here; the set of threadIds is the same one the old pass
  // would have entered its try/catch with.
  receiptBus.publish({
    kind: 'session.recovery.completed',
    attemptedCount: restoredThreadIds.length,
    threadIds: restoredThreadIds,
  });
}

function mapOrchestrationSessionState(
  state: string,
): ProviderSession['status'] {
  if (state === 'running') return 'running';
  if (state === 'errored') return 'error';
  if (state === 'exited') return 'closed';
  return 'ready';
}

function deriveAgentRunStatus(options: {
  sessionStatus: ProviderSession['status'];
  events: CanonicalRuntimeEvent[];
  hasOpenRequest: boolean;
}): AgentRunStatus {
  let status: AgentRunStatus | null = null;
  // archive#3558: tracked in lockstep with `deriveLifecycleTransition`'s own
  // identity fold (`session-lifecycle-service.ts`'s `projectSessionLifecycle`)
  // so `turn.completed`/`turn.aborted` below can apply the SAME identity
  // guard that fold already applies — the two functions read the identical
  // events and must not answer a stale/orphaned terminal event differently.
  //
  // archive#3581 (FIXED): this used to guard only a stale terminal that
  // arrived while `activeTurnId` was still the PRECEDING turn's id.
  // `nextActiveTurnId` resolves `runtime.error`/`session.exited` to
  // `activeTurnId = undefined` (no `preserveDeferredRetry` here), and
  // `acceptsTurnTerminalEvent(event, undefined)` is unconditionally `true`
  // — so a stale terminal arriving AFTER either of those two events used to
  // pass this guard exactly as if no guard existed. `deriveLifecycleTransition`
  // shared the identical hole. Both now fold `nextTurnIdentityAnchor`
  // instead of `nextActiveTurnId` for exactly this local variable — that
  // fold retains a turn's id across the error/exit that used to discard it,
  // so a terminal naming an EARLIER, already-superseded turn is rejected
  // while a turn's own later completion (after its own earlier error) is
  // still accepted (the discriminator is TURN IDENTITY, not the provenance
  // of `undefined` — see `nextTurnIdentityAnchor`'s doc and the
  // `orchestration-session-state.test.ts` test formerly named
  // "the turn-identity guard does not protect ..." (archive#3581), now
  // rewritten to assert the correct `failed` outcome). archive#3557's
  // turn-scoped `latestTerminalEventForTurn` (event-store.ts) already
  // prevents a stale-turn terminal from reaching either fold through the
  // BOUNDED projection most callers use; `readSession`'s full-log path was
  // never inside that protection to begin with — turn-scoping narrows what
  // the bounded projection retains, not what the full log contains — so this
  // guard was the only thing standing between that caller and the gap, and
  // is now closed at the source rather than merely belt-and-braces over a
  // defense that already covered it.
  //
  // archive#3581 review round 2: this fold (no stamp early-return of its
  // own) was never the bypassable half — `deriveLifecycleTransition`'s
  // stamp early-return was (see that function's `isStaleTurnTerminal`,
  // BLOCK 1), which is why the two folds could disagree on a STAMPED,
  // already-persisted stale terminal even after the fold-level fix above.
  // Also `nextTurnIdentityAnchor` no longer clears on an accepted
  // terminal — it retains the last-started turn's id for the session's
  // life (MEDIUM 3) — so this variable's name understates it slightly:
  // "the identity anchor", not merely "the preceding turn's id".
  let turnIdentityAnchor: string | undefined;
  for (const event of options.events) {
    switch (event.method) {
      case 'session.started':
        // Attach fact, not progress: adapters publish this on every
        // startSession including reattach/recovery, so it may only
        // initialize a run's status, never reset an established one
        // (archive#1073 — the lifecycle fold's reattach fix, applied to the runs
        // fold the same way).
        status ??= 'starting';
        break;
      case 'session.state-changed':
        if (event.to === 'running') status = 'running';
        if (event.to === 'awaiting-approval') status = 'waiting_for_approval';
        if (event.to === 'completed') status = 'completed';
        if (event.to === 'aborted') status = 'cancelled';
        if (event.to === 'errored') status = 'failed';
        break;
      case 'request.opened':
        status = 'waiting_for_approval';
        break;
      case 'request.resolved':
        // archive#1284 (HIGH 1): honor the resting state the PRODUCER
        // stamps, when it stamps one. `request.resolved` folding to
        // `running` unconditionally is right for the ordinary case — a real
        // user answering a real approval does resume the work — and wrong
        // for a resolution recorded on a session that had already ended,
        // which put dead threads on `listAgentRuns` as `running` with no
        // `completedAt`, i.e. sorted as the freshest active work.
        //
        // The synthetic resolution that motivated this is GONE (archive#1745
        // projects the orphan cancellation at read time and writes nothing),
        // so the only producers left are real adapters. The arm stays, and
        // is not dead: `sessionState` is a general field on the event and an
        // adapter that stamps a resting state must be honoured for exactly
        // the reason above. The `?? 'running'` fallback covers a resolution
        // that stamps nothing, which is the ordinary live case.
        //
        // Read here rather than compensated for at the producer:
        // compensating for a deaf fold by emitting a second synthetic
        // `session.state-changed` event no runtime produced would fabricate
        // events and double the lifecycle stamp. This way the runs fold and
        // the lifecycle fold read the SAME field of the SAME event.
        status =
          agentRunStatusFromSessionState(event.sessionState) ?? 'running';
        break;
      case 'runtime.error':
        // UX audit AW-8 (live): the SAME rule as `session.exited` below, for
        // the route the audit actually reproduced. Killing a pooled Claude
        // Code engine after its turn had finished published
        // `runtime.error("... process terminated by signal SIGKILL")`, not a
        // `session.exited`, and this arm rewrote an answered session to
        // `failed` — transcript, token count and all still on screen. A
        // recorded turn outcome is the session's outcome; a later failure of
        // the process that hosted it is a fact about the substrate.
        //
        // The discriminator is TURN ATTRIBUTION, not merely lateness — see
        // `isUnattributedRuntimeError`'s doc for the two neighbouring cases
        // that must still fail the session (a turn's own late failure, and a
        // ghost turn's). archive#3473's synthesized orphan failure carries the
        // turn id it closes, so it is unaffected either way.
        if (
          !isUnattributedRuntimeError(event) ||
          !(status && isTerminalAgentRunStatus(status))
        ) {
          status = 'failed';
        }
        break;
      case 'turn.started':
        status = 'running';
        break;
      case 'turn.aborted':
        // archive#3558: an orphaned terminal for a turn the session has
        // moved past (codex's own protocol timing — a late `turn/completed`
        // for turn-1 arriving after turn-2 is already current) must not
        // report `cancelled` for a session that is genuinely still running
        // turn-2 — the same rule `deriveLifecycleTransition` already applies.
        if (acceptsTurnTerminalEvent(event, turnIdentityAnchor))
          status = 'cancelled';
        break;
      case 'turn.completed':
        // archive#3557/#3558 fix-round review BLOCK 3: a user Stop leaves
        // BOTH a `turn.aborted` (published synchronously by
        // `interruptTurn`) and a later `turn.completed` (codex's own async
        // confirmation, `finishReason: 'cancelled'` via
        // `mapTurnFinishReason('interrupted')`) on the SAME turn id.
        // Whichever of the two the bounded projection surfaces for this
        // turn — event-store.ts's `latestTerminalEventForTurn` always picks
        // the later-sequence row, ordinarily `turn.completed` — must read as
        // a cancellation, or a user-initiated Stop reports `completed`.
        if (acceptsTurnTerminalEvent(event, turnIdentityAnchor)) {
          status =
            event.finishReason === 'cancelled' ? 'cancelled' : 'completed';
        }
        break;
      case 'session.exited': {
        // archive#3451 finding 1: a defined `exitCode` is the SAME
        // observation `deriveLifecycleTransition` (session-lifecycle-service.ts)
        // already folds to 'failed'/'completed' — it is a real, later fact
        // about the process substrate (only `finalizeUnexpectedExit` ever
        // sets it, from an actual observed exit) and must win over an
        // earlier optimistic status, not just fill an empty slot (`??=`), or
        // a session that crashed mid-turn kept reading `running` with no
        // `completedAt` — sorted as the freshest active work on
        // `listAgentRuns`. An UNDEFINED exitCode is not an observation at
        // all — every adapter's intentional `stopSession`/`interruptTurn`
        // publishes `session.exited` with no exitCode — so it keeps `??=`
        // and never overrides a status a real terminal event already
        // recorded.
        // archive#3451 finding M1: exitCode 0 FILLS rather than overrides —
        // mirrors the identical fix in `deriveLifecycleTransition`
        // (session-lifecycle-service.ts). archive#3473's synthesized
        // runtime.error (which sets `status = 'failed'` in the case above)
        // can be followed by a `session.exited{exitCode:0}` for the SAME
        // crash (a graceful-shutdown handler, a kill racing a clean-exit
        // path) - the exit code is a fact about the OS process, not proof
        // the turn succeeded, and must not clobber an already-recorded
        // failure back to 'completed'.
        //
        // archive#3451 fix round D6: exact parity with the lifecycle fold
        // requires ALSO treating `options.sessionStatus === 'error' | 'dead'`
        // as an already-failed state, not just an in-loop `status ===
        // 'failed'`. `deriveLifecycleTransition`'s `from` is seeded from
        // `providerStatusToLifecycleState(session.status)` BEFORE its loop
        // even starts, so a session whose PERSISTED status is 'error'/'dead'
        // begins that fold already at 'failed' — while this fold only
        // consults `sessionStatus` AFTER the loop, as a fallback for when no
        // in-band event set anything. Without this, a session with
        // `sessionStatus: 'error'` and only a `session.exited{exitCode:0}`
        // (no in-band runtime.error) diverged: lifecycle read 'failed', the
        // run read 'completed' — the exact disagreement finding 1's whole
        // fix exists to prevent.
        //
        // UX audit AW-R8: none of the above may reach a run
        // whose OUTCOME is already recorded. `session.exited` is a fact
        // about the OS process, and Station keeps pooled engine processes
        // resident long after a turn ends — so the process this event
        // describes routinely dies MINUTES after the work it was hosting
        // finished. Letting a non-zero exit code overwrite an
        // already-recorded `completed`/`cancelled` is what relabelled two
        // answered sessions `Failed` while their transcripts still held the
        // completed answers (reports/2-agent-workflows/REPORT.md AW-R8). A
        // turn that was still IN PROGRESS has no recorded outcome — `status`
        // is `running`/`starting`/`waiting_for_approval`, not terminal — so
        // the arms below still fold that crash to `failed`, which is the
        // case archive#3451 finding 1 added them for.
        //
        // `isTerminalAgentRunStatus` is the SAME predicate
        // `deriveLifecycleTransition` expresses as
        // `isSessionLifecycleStateStopped(from)`; the two folds must answer
        // this event identically or they diverge exactly as archive#3451/#3581
        // catalogue.
        if (status && isTerminalAgentRunStatus(status)) break;
        const impliedFailed =
          !status &&
          (options.sessionStatus === 'error' ||
            options.sessionStatus === 'dead');
        if (event.exitCode === 0) {
          if (!impliedFailed) status = 'completed';
        } else if (event.exitCode !== undefined) {
          status = 'failed';
        } else {
          status ??= 'cancelled';
        }
        break;
      }
    }
    turnIdentityAnchor = nextTurnIdentityAnchor(turnIdentityAnchor, event);
  }

  if (status) return status;

  if (options.hasOpenRequest) return 'waiting_for_approval';

  if (options.sessionStatus === 'closed') return 'cancelled';
  if (options.sessionStatus === 'error') return 'failed';
  // archive#1827: a `dead` engine binding is a failure, same as `error` —
  // the distinction between the two only matters to recovery/replay.
  if (options.sessionStatus === 'dead') return 'failed';
  if (options.sessionStatus === 'running') return 'running';
  if (options.sessionStatus === 'connecting') return 'starting';
  return 'running';
}

/**
 * The run-status a stamped `sessionState` implies, or `null` when the
 * lifecycle state says nothing terminal about the run (`queued`, `running`,
 * `needs_input`, `review_pending`, `blocked` all mean work is still live,
 * which is what the caller's `'running'` default already expresses).
 * Only the three stopped states map, and they map exactly — spelling
 * included: the lifecycle contract spells it `canceled`, `AgentRunStatus`
 * spells it `cancelled`.
 */
function agentRunStatusFromSessionState(
  state: SessionLifecycleState | undefined,
): AgentRunStatus | null {
  if (state === 'canceled') return 'cancelled';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  return null;
}

function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function extractRuntimeThreadId(resumeCursor: unknown): string | undefined {
  if (
    resumeCursor &&
    typeof resumeCursor === 'object' &&
    'codexThreadId' in resumeCursor &&
    typeof resumeCursor.codexThreadId === 'string'
  ) {
    return resumeCursor.codexThreadId;
  }
  return undefined;
}

// archive#3581 (FIXED): this used to walk BACKWARD and return `undefined` as
// soon as it hit ANY `turn.completed`/`turn.aborted`, treating the first one
// found from the end as proof there is nothing left to report a failure
// for. That is exactly the class of bug archive#3581 covers: a stale terminal for
// an EARLIER, already-superseded turn (arriving after that turn's own
// `runtime.error`, while a LATER turn is what's actually running/failed)
// sits at the end of the array and used to make this function discard the
// real failure — `deriveAgentRunStatus` would read `status === 'failed'`
// while `buildAgentRunSummary` reported no `failureKind`/`failureMessage`/
// `retryEligible` at all (the issue's own stated symptom). Now folds FORWARD
// with the same `nextTurnIdentityAnchor`/`acceptsTurnTerminalEvent` identity
// guard `deriveAgentRunStatus` applies: a terminal is only treated as
// clearing the failure when it is ACCEPTED (names the anchor turn, or no
// turn has ever started); a rejected (stale/orphaned) terminal leaves the
// last-recorded failure in place, exactly mirroring what the status fold
// above already decides for the SAME event.
//
// Behavior change worth naming (archive#3581 review LOW 2): a
// `turn.completed`/`turn.aborted` with NO `turnId` at all — malformed, or a
// legacy row from before turn ids were universal — used to unconditionally
// clear the failure (the old backward walk stopped at ANY terminal,
// regardless of `turnId`). `acceptsTurnTerminalEvent` requires
// `Boolean(event.turnId)`, so such a terminal is now REJECTED and no longer
// clears a recorded failure. Arguably the better answer (a terminal that
// cannot even name its own turn is weaker evidence than a real
// `runtime.error`), and only reachable via a malformed/legacy row.
function findTerminalFailureEvent(
  events: CanonicalRuntimeEvent[],
): Extract<CanonicalRuntimeEvent, { method: 'runtime.error' }> | undefined {
  let turnIdentityAnchor: string | undefined;
  let lastFailure:
    | Extract<CanonicalRuntimeEvent, { method: 'runtime.error' }>
    | undefined;
  for (const event of events) {
    if (event.method === 'runtime.error') {
      lastFailure = event;
    } else if (
      (event.method === 'turn.completed' || event.method === 'turn.aborted') &&
      acceptsTurnTerminalEvent(event, turnIdentityAnchor)
    ) {
      lastFailure = undefined;
    }
    turnIdentityAnchor = nextTurnIdentityAnchor(turnIdentityAnchor, event);
  }
  return lastFailure;
}
