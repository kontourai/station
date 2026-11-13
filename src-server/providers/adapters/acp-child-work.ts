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
  /** Running subagents a v3 `agent-subtask` frame reported, by child id. */
  acpSubagents?: Map<string, ChildWorkItem>;
}

export interface AcpChildWorkContext {
  session: { threadId: string };
  activeTurnId?: string;
  publish: (event: CanonicalRuntimeEvent) => void;
  state?: AcpChildWorkState;
}

/**
 * Engines whose subagent frames this module maps, keyed on what the live
 * handshake says about the engine (the steer table's identity matcher).
 * Neither wire is declared at `initialize`, so both are `undeclared-engine`
 * rows of the engine-extension binding table.
 */
const ACP_SUBAGENT_REPORTERS: ReadonlyArray<{
  identity: AcpHandshakeIdentity;
  wire: string;
  observed: string;
}> = [
  {
    identity: { agentInfoName: 'Kiro CLI Agent' },
    wire: '_kiro.dev/subagent/list_update',
    observed:
      'kirocrew test/fixtures/acp_frames/kiro/notifications.jsonl; dashboard/chat_turn/native_cards.py _native_subagent_sync',
  },
  {
    identity: { capabilityMetaNamespace: 'kiro' },
    wire: 'tool_call _meta.kiro.kind = agent-subtask',
    observed:
      'kirocrew acp/session_handle_native_children.py _handle_kas_subagent; test/test_kas_subagent_progress.py',
  },
];

/** Whether this session's engine is one whose subagent frames are mapped. */
export function acpReportsSubagents(
  handshake: AcpIdentityHandshake | null | undefined,
): boolean {
  if (!handshake) return false;
  return ACP_SUBAGENT_REPORTERS.some(({ identity }) =>
    matchesAcpHandshakeIdentity(handshake, identity),
  );
}

/** Why an ACP engine's child work is `not-reported`. */
export const ACP_CHILD_WORK_NOT_REPORTED_REASON =
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
  if (!Array.isArray(params.subagents)) return;
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
    if (!status.running) publishSettle(ctx, item, status.status);
    else if (running.length < CHILD_WORK_ITEMS_MAX_PER_REPORTER)
      running.push(item);
  }
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
  if (!id || !ctx.state) return;
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
    if (roster.size >= CHILD_WORK_ITEMS_MAX_PER_REPORTER) return;
    roster.set(id, item);
    publishSnapshot(ctx, [...roster.values()]);
    return;
  }
  if (!known) return;
  roster.delete(id);
  publishSettle(ctx, item, status.status);
  publishSnapshot(ctx, [...roster.values()]);
}
