/**
 * Child work (subagents, background commands, monitors) an ACP engine
 * reports, folded into the child-work contract
 * (`packages/contracts/src/child-work.ts`).
 *
 * ACP itself has no subagent concept, so whether a session reports child
 * work is a fact of the engine on the other end, read from its own
 * handshake: an engine variant whose binding rows (`ENGINE_EXTENSION_BINDINGS`,
 * consumer `child-work`) are listed in {@link ACP_CHILD_WORK_REPORTERS}
 * reports; any other session states `not-reported` once, at start, so a
 * surface never reads "nothing running" that no engine said.
 *
 * The readers that turn a vendor payload into these calls live with the
 * other engine-extension readers (`acp-engine-extension-events.ts`), keyed
 * by binding id. This module owns the registry fold and every emission:
 *
 * - a child's start is a running snapshot of every child the session holds,
 *   so the contract's lifecycle rule (a settle for a child a snapshot listed)
 *   holds and a re-sent start changes nothing;
 * - progress, usage and identity are upserts;
 * - an end is a settle. A child the engine never settles stays running until
 *   the session ends, when the projection marks it `unresolved`.
 */
import crypto from 'node:crypto';
import type { ProviderDeclaredEngineVariant } from '@kontourai/station-contracts/catalog';
import {
  applyChildWorkDelta,
  CHILD_WORK_ITEMS_MAX_PER_REPORTER,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkRegistryState,
  type ChildWorkResult,
  type ChildWorkTerminalStatus,
  type ChildWorkUsage,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import type { ProviderRuntimeEvent as CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * Engine variants that report child work, and the binding rows they report
 * it through. A row named here must exist, be bound to `child-work` and not
 * be pending (a test pins this), so the claim is never wider than the
 * readers behind it.
 */
export const ACP_CHILD_WORK_REPORTERS: Readonly<
  Partial<Record<ProviderDeclaredEngineVariant, readonly string[]>>
> = Object.freeze({
  'grok-build': Object.freeze([
    'grok.task-backgrounded',
    'grok.task-completed',
    'grok.monitor-event',
    'grok.background-tasks',
    'grok.subagent-spawned',
    'grok.subagent-progress',
    'grok.subagent-finished',
  ]),
});

/** Why an ACP session reports no child work. */
export const ACP_CHILD_WORK_NOT_REPORTED_REASON =
  'This engine does not report its subagents or background work over ACP.';

/** Whether a session whose handshake resolved to `variant` reports child work. */
export function acpEngineReportsChildWork(
  variant: ProviderDeclaredEngineVariant | undefined,
): boolean {
  return (
    variant !== undefined && ACP_CHILD_WORK_REPORTERS[variant] !== undefined
  );
}

/** Adapter-owned per-session child-work state (part of the session record). */
export interface AcpChildWorkState {
  childWorkRegistry?: ChildWorkRegistryState;
}

export interface AcpChildWorkContext {
  session: { threadId: string };
  activeTurnId?: string;
  publish: (event: CanonicalRuntimeEvent) => void;
  state?: AcpChildWorkState;
}

/** A child as a reader saw it start. `reporterThreadId` and status are filled in here. */
export type AcpChildStart = Omit<
  ChildWorkItem,
  'producer' | 'reporterThreadId' | 'status'
>;

function registry(ctx: AcpChildWorkContext): ChildWorkRegistryState {
  if (!ctx.state) return createEmptyChildWorkRegistry();
  ctx.state.childWorkRegistry ??= createEmptyChildWorkRegistry();
  return ctx.state.childWorkRegistry;
}

function emit(ctx: AcpChildWorkContext, delta: ChildWorkDelta): void {
  // Without a session store there is nothing to fold against; publishing
  // anyway would let a duplicate frame read as a second start.
  if (!ctx.state) return;
  const before = registry(ctx);
  const next = applyChildWorkDelta(before, delta);
  if (next === before) return;
  ctx.state.childWorkRegistry = next;
  ctx.publish({
    eventId: crypto.randomUUID(),
    provider: 'acp',
    threadId: ctx.session.threadId,
    createdAt: new Date().toISOString(),
    ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
    method: 'child-work.updated',
    delta,
  });
}

function children(ctx: AcpChildWorkContext): ChildWorkItem[] {
  return childWorkForReporter(registry(ctx), ctx.session.threadId).filter(
    (item) => item.producer === 'engine-subagent',
  );
}

/** The child this session holds under `childId`, if any. */
export function acpChild(
  ctx: AcpChildWorkContext,
  childId: string,
): ChildWorkItem | undefined {
  return children(ctx).find((item) => item.childId === childId);
}

/**
 * A child started. Published as the session's whole running set, so the
 * new child is listed beside the ones already running. A child the session
 * already holds is enriched instead, never restarted.
 */
export function startAcpChild(
  ctx: AcpChildWorkContext,
  start: AcpChildStart,
): void {
  const existing = acpChild(ctx, start.childId);
  if (existing) {
    if (existing.status === 'running')
      emit(ctx, { kind: 'upsert', item: { ...start, ...existing } });
    return;
  }
  const running = children(ctx).filter((item) => item.status === 'running');
  if (running.length >= CHILD_WORK_ITEMS_MAX_PER_REPORTER) return;
  const item: ChildWorkItem = {
    ...start,
    producer: 'engine-subagent',
    reporterThreadId: ctx.session.threadId,
    status: 'running',
  };
  emit(ctx, {
    kind: 'snapshot',
    producer: 'engine-subagent',
    reporterThreadId: ctx.session.threadId,
    running: [...running, item],
  });
}

/** New facts about a running child (progress, usage, latest tool). */
export function updateAcpChild(
  ctx: AcpChildWorkContext,
  childId: string,
  patch: Partial<
    Pick<ChildWorkItem, 'progress' | 'usage' | 'latestTool' | 'title'>
  >,
): void {
  const existing = acpChild(ctx, childId);
  if (!existing || existing.status !== 'running') return;
  emit(ctx, { kind: 'upsert', item: { ...existing, ...patch } });
}

/** A child ended with the engine's own verdict. */
export function settleAcpChild(
  ctx: AcpChildWorkContext,
  childId: string,
  status: ChildWorkTerminalStatus,
  facts: {
    result?: ChildWorkResult;
    usage?: ChildWorkUsage;
    endedAt?: string;
    identity?: Partial<AcpChildStart>;
  } = {},
): void {
  const existing = acpChild(ctx, childId);
  // An end for a child this session never saw start (it began before
  // Station attached) still records the verdict, with what the end says.
  emit(ctx, {
    kind: 'settle',
    producer: 'engine-subagent',
    reporterThreadId: ctx.session.threadId,
    childId,
    status,
    ...(facts.result ? { result: facts.result } : {}),
    ...(facts.usage ? { usage: facts.usage } : {}),
    ...(existing
      ? {}
      : facts.identity || facts.endedAt
        ? {
            identity: {
              ...facts.identity,
              ...(facts.endedAt ? { endedAt: facts.endedAt } : {}),
            },
          }
        : {}),
  });
}

/** The one child-work fact a session whose engine reports none can state. */
export function acpChildWorkNotReportedEvent(input: {
  threadId: string;
}): CanonicalRuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    provider: 'acp',
    threadId: input.threadId,
    createdAt: new Date().toISOString(),
    method: 'child-work.updated',
    delta: {
      kind: 'not-reported',
      reporterThreadId: input.threadId,
      reason: ACP_CHILD_WORK_NOT_REPORTED_REASON,
    },
  };
}
