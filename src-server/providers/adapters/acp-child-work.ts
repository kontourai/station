/**
 * Engine subagents on ACP, published as `child-work.updated`. ACP itself has
 * no subagent concept, so what a session can report is a per-connection
 * observation: an engine whose handshake identifies one of the reporters
 * below has its subagent frames mapped here; every other engine's session
 * says, once at its start, that its child work is `not-reported`, so no
 * surface reads its silence as "nothing running".
 *
 * Every child-work event the ACP adapter emits is built in this module (the
 * capability matrix names it as the ACP cell's adapter module).
 */
import crypto from 'node:crypto';
import {
  CHILD_WORK_ITEMS_MAX_PER_REPORTER,
  type ChildWorkItem,
  type ChildWorkTerminalStatus,
} from '@kontourai/station-contracts/child-work';
import {
  type AcpHandshakeIdentity,
  type AcpIdentityHandshake,
  matchesAcpHandshakeIdentity,
} from '../../services/acp/acp-handshake-facts.js';
import type { ProviderRuntimeEvent as CanonicalRuntimeEvent } from '../adapter-shape.js';

/** The adapter-owned state these readers keep (part of the session record). */
export interface AcpChildWorkState {
  /**
   * The subagent wires this session's handshake identifies its engine as
   * sending (`acpSubagentWires`), set by the adapter at session start. A
   * frame on any other wire publishes nothing: the session already said its
   * child work is not reported.
   */
  acpSubagentWires?: ReadonlySet<AcpSubagentWire>;
  /** Running subagents a v3 `agent-subtask` frame reported, by child id. */
  acpSubagents?: Map<string, ChildWorkItem>;
  /**
   * Running subagents a nested tool call named, by the parent tool call
   * that runs each one (Qwen Code).
   */
  acpNestedSubagents?: Map<string, ChildWorkItem>;
  /**
   * Roster children already settled, so a repeated roster does not settle
   * them again. Bounded (oldest out): a child evicted past the bound is
   * settled again if a later roster still restates it, which the fold
   * treats as a no-op on an already-terminal child.
   */
  acpSettledSubagents?: Set<string>;
  /** The over-bound warning already logged for this session, per wire, while it stays over. */
  acpSubagentBoundWarned?: Set<AcpSubagentWire>;
}

export interface AcpChildWorkContext {
  session: { threadId: string };
  activeTurnId?: string;
  publish: (event: CanonicalRuntimeEvent) => void;
  state?: AcpChildWorkState;
  logger?: {
    warn: (message: string, fields?: Record<string, unknown>) => void;
  };
}

export type AcpSubagentWire = 'roster' | 'agent-subtask' | 'nested-tool-call';

/**
 * Engines whose subagent frames this module maps, keyed on what the live
 * handshake says about the engine (the steer table's identity matcher).
 * No wire is declared at `initialize`, so each is an `undeclared-engine`
 * row of the engine-extension binding table.
 */
const ACP_SUBAGENT_REPORTERS: ReadonlyArray<{
  identity: AcpHandshakeIdentity;
  wire: AcpSubagentWire;
  observed: string;
}> = [
  {
    // `_kiro.dev/subagent/list_update`
    identity: { agentInfoName: 'Kiro CLI Agent' },
    wire: 'roster',
    observed:
      'kirocrew test/fixtures/acp_frames/kiro/notifications.jsonl; dashboard/chat_turn/native_cards.py _native_subagent_sync',
  },
  {
    // `tool_call` with `_meta.kiro.kind: agent-subtask`
    identity: { capabilityMetaNamespace: 'kiro' },
    wire: 'agent-subtask',
    observed:
      'kirocrew acp/session_handle_native_children.py _handle_kas_subagent; test/test_kas_subagent_progress.py',
  },
  {
    // `tool_call` / `tool_call_update` with `_meta.provenance: 'subagent'`;
    // Qwen Code's initialize names it `qwen-code` (acpAgent.ts initialize).
    identity: { agentInfoName: 'qwen-code' },
    wire: 'nested-tool-call',
    observed:
      'QwenLM/qwen-code 6f754be65489 packages/cli/src/acp-integration/session/SubAgentTracker.ts; source only, not a live run',
  },
];

/** The subagent wires this session's engine is identified as sending. */
export function acpSubagentWires(
  handshake: AcpIdentityHandshake | null | undefined,
): ReadonlySet<AcpSubagentWire> {
  if (!handshake) return new Set();
  return new Set(
    ACP_SUBAGENT_REPORTERS.filter(({ identity }) =>
      matchesAcpHandshakeIdentity(handshake, identity),
    ).map(({ wire }) => wire),
  );
}

/** Why an ACP engine's child work is `not-reported`. */
const ACP_CHILD_WORK_NOT_REPORTED_REASON =
  'This engine reports no subagents to Station over ACP.';

function event(
  ctx: AcpChildWorkContext,
  delta: Extract<
    CanonicalRuntimeEvent,
    { method: 'child-work.updated' }
  >['delta'],
): CanonicalRuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    provider: 'acp',
    threadId: ctx.session.threadId,
    createdAt: new Date().toISOString(),
    ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
    method: 'child-work.updated',
    delta,
  };
}

/** The one child-work fact a non-reporting engine's session states. */
export function acpChildWorkNotReportedEvent(
  threadId: string,
): CanonicalRuntimeEvent {
  return event(
    { session: { threadId }, publish: () => {} },
    {
      kind: 'not-reported',
      reporterThreadId: threadId,
      reason: ACP_CHILD_WORK_NOT_REPORTED_REASON,
    },
  );
}

const CHILD_ID_MAX_CHARS = 256;
/** Bound on roster children remembered as settled per session; oldest first out. */
const CHILD_WORK_SETTLED_IDS_MAX = 1024;
const LABEL_MAX_CHARS = 200;

function childId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CHILD_ID_MAX_CHARS
    ? value
    : undefined;
}

function label(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, LABEL_MAX_CHARS) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Status words an engine uses for a child still at work (kirocrew's set). */
const RUNNING_STATUSES = new Set([
  '',
  'working',
  'running',
  'pending',
  'queued',
  'in_progress',
]);

const TERMINAL_STATUSES: Readonly<Record<string, ChildWorkTerminalStatus>> = {
  completed: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

/**
 * A status word as a child-work status. A terminal word Station does not
 * know ends the child without an observed outcome: `unresolved`.
 */
function childStatus(
  word: string,
): { running: true } | { running: false; status: ChildWorkTerminalStatus } {
  const normalized = word.toLowerCase();
  if (RUNNING_STATUSES.has(normalized)) return { running: true };
  return {
    running: false,
    status: TERMINAL_STATUSES[normalized] ?? 'unresolved',
  };
}

function baseItem(
  ctx: AcpChildWorkContext,
  id: string,
  identity: { title?: string; kindLabel?: string; toolCallId?: string },
): ChildWorkItem {
  return {
    producer: 'engine-subagent',
    reporterThreadId: ctx.session.threadId,
    childId: id,
    status: 'running',
    workKind: 'agent',
    parent: {
      threadId: ctx.session.threadId,
      ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
      ...(identity.toolCallId ? { toolCallId: identity.toolCallId } : {}),
    },
    ...(identity.title ? { title: identity.title } : {}),
    ...(identity.kindLabel ? { kindLabel: identity.kindLabel } : {}),
  };
}

/** Log an over-bound refusal once while the session stays over the bound. */
function warnOverBoundOnce(
  ctx: AcpChildWorkContext,
  wire: AcpSubagentWire,
  message: string,
  fields: Record<string, unknown>,
): void {
  const warned = (ctx.state!.acpSubagentBoundWarned ??= new Set());
  if (warned.has(wire)) return;
  warned.add(wire);
  ctx.logger?.warn(message, { threadId: ctx.session.threadId, ...fields });
}

function publishSettle(
  ctx: AcpChildWorkContext,
  item: ChildWorkItem,
  status: ChildWorkTerminalStatus,
): void {
  const { producer, reporterThreadId, childId: id, ...identity } = item;
  const { status: _running, ...rest } = identity;
  ctx.publish(
    event(ctx, {
      kind: 'settle',
      producer,
      reporterThreadId,
      childId: id,
      status,
      identity: rest,
    }),
  );
}

function publishSnapshot(
  ctx: AcpChildWorkContext,
  running: ChildWorkItem[],
): void {
  ctx.publish(
    event(ctx, {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: ctx.session.threadId,
      running,
    }),
  );
}

/**
 * kiro-cli's `_kiro.dev/subagent/list_update`: the engine's whole subagent
 * roster, `subagents[{sessionId, sessionName, agentName|role, initialQuery,
 * status: {type, message}}]` (the synthetic fixture's older spelling, `{id,
 * name, status: '<word>'}`, reads the same). Each terminal entry is settled,
 * then the running ones are published as the authoritative running set, so
 * a child the roster drops without an outcome reads `unresolved`.
 */
export function publishAcpSubagentRoster(
  params: Record<string, unknown>,
  ctx: AcpChildWorkContext,
): void {
  if (!ctx.state?.acpSubagentWires?.has('roster')) return;
  if (!Array.isArray(params.subagents)) return;
  const settled = (ctx.state.acpSettledSubagents ??= new Set());
  const running: ChildWorkItem[] = [];
  const seen = new Set<string>();
  for (const entry of params.subagents) {
    if (!isRecord(entry)) continue;
    const id = childId(entry.sessionId) ?? childId(entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const statusWord = isRecord(entry.status)
      ? entry.status.type
      : entry.status;
    if (typeof statusWord !== 'string') continue;
    const item = baseItem(ctx, id, {
      title:
        label(entry.initialQuery) ??
        label(entry.sessionName) ??
        label(entry.name),
      kindLabel: label(entry.role) ?? label(entry.agentName),
    });
    const status = childStatus(statusWord);
    if (status.running) running.push(item);
    else if (!settled.has(id)) {
      // The roster restates finished children every time; each is settled
      // once. The set is bounded like the registry it feeds.
      settled.add(id);
      if (settled.size > CHILD_WORK_SETTLED_IDS_MAX)
        settled.delete(settled.values().next().value as string);
      publishSettle(ctx, item, status.status);
    }
  }
  // The running set is authoritative: a child it leaves out reads
  // `unresolved`. One cut to the registry's bound would mark live children
  // ended, so an oversized roster publishes no running set at all and the
  // last one stands.
  if (running.length > CHILD_WORK_ITEMS_MAX_PER_REPORTER) {
    warnOverBoundOnce(
      ctx,
      'roster',
      'ACP subagent roster exceeds the child-work bound; its running set is not published',
      { running: running.length, max: CHILD_WORK_ITEMS_MAX_PER_REPORTER },
    );
    return;
  }
  ctx.state.acpSubagentBoundWarned?.delete('roster');
  publishSnapshot(ctx, running);
}

/**
 * Kiro's agent service: a `tool_call` / `tool_call_update` whose
 * `_meta.kiro.kind` is `agent-subtask` is the subagent itself, named by
 * `agentSubtaskId`; its `status` is the child's. The roster of running
 * children is kept per session and republished whole after each change, so
 * a settle is always of a child a snapshot listed.
 */
export function publishAcpAgentSubtask(
  update: Record<string, unknown>,
  meta: Record<string, unknown>,
  ctx: AcpChildWorkContext,
): void {
  const id = childId(meta.agentSubtaskId);
  if (!id || !ctx.state?.acpSubagentWires?.has('agent-subtask')) return;
  const roster = (ctx.state.acpSubagents ??= new Map());
  const known = roster.get(id);
  const title = label(update.title);
  const item =
    known ??
    baseItem(ctx, id, {
      title,
      kindLabel: title?.startsWith('Sub-agent: ')
        ? label(title.slice('Sub-agent: '.length))
        : undefined,
      toolCallId: childId(update.toolCallId),
    });
  const statusWord = typeof update.status === 'string' ? update.status : '';
  const status = childStatus(statusWord);
  if (status.running) {
    if (known) return;
    // Past the registry's bound a new child is not tracked: it is never
    // shown running, and its end is ignored. Logged, so the gap is visible.
    if (roster.size >= CHILD_WORK_ITEMS_MAX_PER_REPORTER) {
      warnOverBoundOnce(
        ctx,
        'agent-subtask',
        'ACP agent-subtask past the child-work bound is not tracked',
        { max: CHILD_WORK_ITEMS_MAX_PER_REPORTER },
      );
      return;
    }
    roster.set(id, item);
    publishSnapshot(ctx, [...roster.values()]);
    return;
  }
  if (!known) return;
  roster.delete(id);
  ctx.state.acpSubagentBoundWarned?.delete('agent-subtask');
  publishSettle(ctx, item, status.status);
  publishSnapshot(ctx, [...roster.values()]);
}

/**
 * Qwen Code: a subagent runs inside one Agent tool call. Its own tool calls
 * are frames whose `_meta.provenance` is `subagent`, naming that call as
 * `_meta.parentToolCallId`; its progress notes on the call itself carry the
 * marker with `subagentProgress: true` and no parent. Either frame names the
 * subagent by the call that runs it, listed running from its first frame,
 * labelled by `_meta.subagentType`. A subagent inside a subagent runs in its
 * own Agent call and is listed as its own child.
 */
export function publishAcpNestedSubagentFrame(
  update: Record<string, unknown>,
  ctx: AcpChildWorkContext,
): void {
  if (!ctx.state?.acpSubagentWires?.has('nested-tool-call')) return;
  const meta = isRecord(update._meta) ? update._meta : undefined;
  if (meta?.provenance !== 'subagent') return;
  const id =
    childId(meta.parentToolCallId) ??
    (meta.subagentProgress === true ? childId(update.toolCallId) : undefined);
  if (!id) return;
  const roster = (ctx.state.acpNestedSubagents ??= new Map());
  if (roster.has(id)) return;
  if (roster.size >= CHILD_WORK_ITEMS_MAX_PER_REPORTER) {
    warnOverBoundOnce(
      ctx,
      'nested-tool-call',
      'ACP nested subagent past the child-work bound is not tracked',
      { max: CHILD_WORK_ITEMS_MAX_PER_REPORTER },
    );
    return;
  }
  roster.set(
    id,
    baseItem(ctx, id, {
      kindLabel: label(meta.subagentType),
      toolCallId: id,
    }),
  );
  publishSnapshot(ctx, [...roster.values()]);
}

/**
 * A `tool_call_update` that ends the Agent call a listed Qwen subagent runs
 * in ends that subagent with the call's own outcome.
 */
export function settleAcpNestedSubagent(
  update: Record<string, unknown>,
  ctx: AcpChildWorkContext,
): void {
  const roster = ctx.state?.acpNestedSubagents;
  const id = childId(update.toolCallId);
  const item = id ? roster?.get(id) : undefined;
  if (!roster || !id || !item || typeof update.status !== 'string') return;
  const status = childStatus(update.status);
  if (status.running) return;
  roster.delete(id);
  ctx.state?.acpSubagentBoundWarned?.delete('nested-tool-call');
  publishSettle(ctx, item, status.status);
  publishSnapshot(ctx, [...roster.values()]);
}
