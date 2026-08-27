import { flowRunDisplayIdentity } from '@kontourai/station-contracts';

/**
 * `station operate`'s pure renderer (#168 Wave 1, Task 1A) — `render(state):
 * string[]` returns plain strings, one per terminal line; it makes zero
 * TTY/ANSI calls (no `\x1b[...]` escape codes, no `process.stdout` writes)
 * — the shell (Wave 2, `shell.ts`) owns the ANSI repaint (cursor-home +
 * clear-to-end) and just joins/writes these lines. TTY-free: no
 * `readline`/`node:tty`/`node:http`/`fetch` imports here.
 *
 * Six sections, in render order: header, session board table, approvals
 * pane, gate-verdicts pane, transcript pane, footer (plan's Task 1A file
 * list).
 *
 * `render(state)` is itself a pure function of `state` alone — the
 * approvals pane's displayed "age" column is computed here from
 * `state.now` (advanced once a second by the shell's `tick` action) and
 * each approval's `createdAt`, rather than from a precomputed `ageMs`
 * field (#168 iteration-2 review finding M1 fix: `derive.ts`'s
 * `derivePendingApprovalsForSession` used to read the wall clock itself,
 * which meant identical `events` could still produce different output, and
 * the displayed age never advanced between ticks since nothing re-derived
 * it). Because `render()` reads `state.now` on every call, two renders of
 * the same session with different `state.now` values (i.e. after a `tick`
 * action, with no new events) genuinely produce a different age string —
 * this is the property `operate-render.test.ts`'s tick-advances-age test
 * asserts directly.
 */
import type {
  FleetRoutingCandidate,
  FleetRoutingExclusion,
  FleetRoutingReceiptEnvelope,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { describeConsumerProbe } from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  unanswerableRequestNotice,
  unknownAnswerabilityNotice,
} from '@kontourai/station-contracts/orchestration';
import { OPERATE_KEYBINDINGS } from './keys.js';
import type {
  OperateApproval,
  OperateBuilderRun,
  OperateGateState,
  OperateSessionState,
  OperateState,
} from './types.js';

const TRANSCRIPT_MAX_LINES = 20;
const TOOL_INPUT_TRUNCATE_LENGTH = 80;

export function render(state: OperateState): string[] {
  return [
    ...renderHeader(state),
    '',
    ...renderBoard(state),
    '',
    ...renderApprovals(state),
    '',
    ...renderGateState(state),
    '',
    ...renderTranscript(state),
    '',
    ...renderFleetRouting(state),
    '',
    ...renderFooter(),
  ];
}

/** Receipts shown in the pane. The route is bounded too; this bounds the paint. */
const FLEET_RECEIPTS_MAX = 3;
const FLEET_EXCLUSIONS_MAX = 6;

/**
 * The fleet routing pane (station#1398 slice 4). Four things it must say,
 * each of which the design names as a way this feature can lie:
 *
 * 1. **Where the turn ran, and on what evidence.** A peer-attested candidate
 *    renders its own label verbatim ("attested by peer, not verified") — the
 *    string comes from the receipt, not from this renderer, so the CLI
 *    cannot drift from the stored record or from the web surface.
 * 2. **Why the others did not.** Every exclusion, by code and sentence.
 *    Dropping one silently is §4.5's first banned behavior.
 * 3. **Whether the turn fell back.** A local success after a failed fleet
 *    attempt is printed as a failure state, because silently changing where
 *    a turn ran is §4.5's second banned behavior.
 * 4. **Whether the receipt chain verifies.** `unknown` is printed as
 *    unknown; a partial window never claims "verified".
 */
function renderFleetRouting(state: OperateState): string[] {
  const lines = ['FLEET ROUTING'];
  const fleet = state.fleetRouting;
  if (fleet === undefined) {
    lines.push('  (not pulled)');
    return lines;
  }
  if (!fleet.page) {
    // A failed read is NOT "nothing has been routed" — say which it is.
    lines.push(
      `  unavailable: ${fleet.error ?? 'this Station could not read its routing receipts'} (unknown, not empty)`,
    );
    return lines;
  }
  const page = fleet.page;
  lines.push(`  chain: ${page.chain.status} — ${page.chain.message}`);
  if (page.receipts.length === 0) {
    lines.push('  no turn has been fleet-routed on this Station yet');
    return lines;
  }
  lines.push(
    `  ${page.receipts.length} of ${page.totalRecords ?? '?'} receipt(s), newest first`,
  );
  for (const receipt of page.receipts.slice(0, FLEET_RECEIPTS_MAX)) {
    lines.push(...renderFleetReceipt(receipt));
  }
  return lines;
}

/**
 * The evidence phrase for one candidate — always carries its provenance, and
 * (station#1398 slice 5) the probe clause whenever there is an observation.
 *
 * The probe clause is NOT optional decoration on the stale path: without it a
 * candidate whose probe expired renders identically to one that was never
 * probed, and "we checked this an hour ago and it passed" is a different
 * sentence from "we have never checked this". Both wordings come from the
 * contract so the CLI and the web UI cannot drift into two honesty claims.
 */
export function fleetEvidencePhrase(candidate: {
  evidence: FleetRoutingCandidate['evidence'];
}): string {
  const probe = describeConsumerProbe(candidate.evidence.probe);
  return `evidence=${candidate.evidence.level} (${candidate.evidence.label})${probe ? ` · ${probe}` : ''}`;
}

function renderFleetReceipt(receipt: FleetRoutingReceiptEnvelope): string[] {
  const lines = [
    `  ${receipt.recordedAt}  agent=${receipt.agentName}  outcome=${receipt.dispatch.outcome}`,
  ];
  if (receipt.selection) {
    const where =
      receipt.selection.origin === 'fleet'
        ? `${receipt.selection.environmentLabel ?? receipt.selection.environmentId ?? 'unknown peer'}`
        : 'this Station';
    lines.push(
      `    served by: ${where} · ${receipt.selection.modelId ?? 'unknown model'} · ${fleetEvidencePhrase(receipt.selection)}`,
    );
  } else {
    lines.push('    served by: nothing — no candidate produced a completion');
  }
  if (receipt.failure) {
    lines.push(`    ${receipt.failure.code}: ${receipt.failure.message}`);
  }
  lines.push(
    `    streaming: ${receipt.stream.capable ? 'yes' : 'no'} — ${receipt.stream.reason}`,
  );
  for (const exclusion of receipt.exclusions.slice(0, FLEET_EXCLUSIONS_MAX)) {
    lines.push(
      `    excluded ${describeExclusionTarget(exclusion)}: ${exclusion.code} — ${exclusion.message}`,
    );
  }
  if (receipt.exclusions.length > FLEET_EXCLUSIONS_MAX) {
    lines.push(
      `    (+${receipt.exclusions.length - FLEET_EXCLUSIONS_MAX} more exclusion(s) in the receipt)`,
    );
  }
  lines.push(
    `    receipted by content digest ${receipt.receiptId.slice(0, 12)}… — not signed`,
  );
  return lines;
}

function describeExclusionTarget(exclusion: FleetRoutingExclusion): string {
  const where =
    exclusion.environmentLabel ?? exclusion.environmentId ?? 'this Station';
  return exclusion.modelId ? `${where}/${exclusion.modelId}` : where;
}

function renderHeader(state: OperateState): string[] {
  const focus = state.focusedThreadId ?? '(none)';
  return [
    'station operate',
    `connection: ${state.connectionStatus}${state.connectionError ? ` (${state.connectionError})` : ''} | focused session: ${focus} | q: quit`,
  ];
}

function renderBoard(state: OperateState): string[] {
  const lines = ['SESSIONS'];
  if (state.board.length === 0) {
    lines.push('  (no sessions yet)');
    return lines;
  }
  for (const row of state.board) {
    const marker = row.threadId === state.focusedThreadId ? '>' : ' ';
    lines.push(
      `${marker} ${row.threadId}  provider=${row.provider ?? '?'}  status=${row.status ?? '?'}  lastEvent=${row.lastEventMethod ?? '-'}  updatedAt=${row.updatedAt ?? '-'}`,
    );
  }
  return lines;
}

function focusedSession(state: OperateState): OperateSessionState | undefined {
  return state.focusedThreadId
    ? state.sessions[state.focusedThreadId]
    : undefined;
}

/**
 * The serving Station's answerability observation for the focused session,
 * as the pane's own annotation line — or the explicit unknown gap when the
 * focused thread is not on the board at all (station#1782 AC3/AC5).
 *
 * Rendered ONCE above the rows because it is a per-session fact, with each
 * row carrying a short `[unanswerable]` tag so a reader scanning rows is
 * pointed at the basis one line up rather than being handed a bare adjective
 * with nothing behind it. Read off the board row's decoration; the TUI never
 * recomputes a fact that lives in the serving process.
 */
function approvalsAnnotation(state: OperateState): string | null {
  if (!state.focusedThreadId) return null;
  const row = state.board.find(
    (candidate) => candidate.threadId === state.focusedThreadId,
  );
  if (!row || row.answerability === null) {
    return unknownAnswerabilityNotice(`session ${state.focusedThreadId}`);
  }
  return unanswerableRequestNotice(row.answerability, {
    provider: row.provider,
  });
}

function renderApprovals(state: OperateState): string[] {
  const lines = ['APPROVALS'];
  const session = focusedSession(state);
  const approvals = session?.approvals ?? [];
  if (approvals.length === 0) {
    lines.push('  (none pending)');
    return lines;
  }
  const annotation = approvalsAnnotation(state);
  const unanswerable = isUnanswerableBoardRow(state);
  if (annotation) lines.push(`  ! ${annotation}`);
  approvals.forEach((approval, index) => {
    lines.push(
      `  ${renderApprovalLine(approval, index === session?.selectedApprovalIndex, state.now, unanswerable)}`,
    );
  });
  return lines;
}

/**
 * True only for an OBSERVED negative. A focused thread missing from the
 * board is `unknown` — annotated above, never tagged here, because "I could
 * not look" is not "nothing can answer this".
 */
function isUnanswerableBoardRow(state: OperateState): boolean {
  const row = state.board.find(
    (candidate) => candidate.threadId === state.focusedThreadId,
  );
  return row?.answerability ? !row.answerability.answerable : false;
}

function renderApprovalLine(
  approval: OperateApproval,
  selected: boolean,
  now: number,
  unanswerable: boolean,
): string {
  const marker = selected ? '>' : ' ';
  const age = formatApprovalAge(approval.createdAt, now);
  const toolInputSummary = truncateToolInput(approval.toolInput);
  const tag = unanswerable ? '  [unanswerable]' : '';
  return `${marker} ${approval.requestId}  ${approval.toolName ?? approval.title}  input=${toolInputSummary}  age=${age}${tag}`;
}

/**
 * The only place this module reads a wall-clock-derived value — and even
 * here it's not `Date.now()`, it's the caller-supplied `now` (`state.now`,
 * set exclusively by the shell's `tick`/startup actions), which is what
 * keeps `render(state)` a pure function of its argument (#168 iteration-2
 * review finding M1 fix).
 *
 * Clamped at zero (#187 follow-up 1): client/server clock skew can put a
 * server-stamped `createdAt` slightly ahead of the client's `state.now`,
 * and a negative age (`age=-3s`) is meaningless noise — render `0s` until
 * the client clock catches up.
 *
 * Exported for the table-driven unit test in `operate-render.test.ts`.
 */
export function formatApprovalAge(
  createdAt: string | undefined,
  now: number,
): string {
  if (!createdAt) {
    return '?';
  }
  const createdAtMs = Date.parse(createdAt);
  if (Number.isNaN(createdAtMs)) {
    return '?';
  }
  return `${Math.max(0, Math.round((now - createdAtMs) / 1000))}s`;
}

function truncateToolInput(toolInput: unknown): string {
  if (toolInput === undefined) {
    return '(none)';
  }
  let text: string;
  try {
    text =
      typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
  } catch {
    text = String(toolInput);
  }
  if (text.length > TOOL_INPUT_TRUNCATE_LENGTH) {
    return `${text.slice(0, TOOL_INPUT_TRUNCATE_LENGTH)}…`;
  }
  return text;
}

/**
 * The evaluation line, which the run/step line must never be read without.
 * `step=plan status=active` describes where a run sits, not that anything has
 * happened there: an auto-attached run whose first step declares no gate holds
 * that exact reading forever (station#189). Say what was evaluated, when, and
 * — when the step is ungated — that nothing can be.
 */
function renderGateFreshness(gateState: OperateGateState): string {
  if (typeof gateState.gateOutcomeCount !== 'number') {
    return '  evaluation: unknown (not pulled)';
  }
  // Three readings, and they are not interchangeable: no gate outcome at all
  // is never-evaluated; outcomes with no timestamp is evaluated-but-waiting
  // (Flow stamps only advancing evaluations); a timestamp is the real thing.
  const state = gateState.lastEvaluatedAt
    ? `last evaluated ${gateState.lastEvaluatedAt}`
    : gateState.gateOutcomeCount > 0
      ? 'time unrecorded'
      : 'never evaluated';
  const ungated =
    gateState.blockedReason === 'ungated-step'
      ? ` — no gate on step \`${gateState.currentStep ?? '?'}\`, so this run cannot advance`
      : '';
  return `  evaluation: ${state}${ungated} (${gateState.gateOutcomeCount} gate outcomes, ${gateState.evidenceCount ?? 0} evidence)`;
}

/**
 * The Builder run row (station#189 S4) — its own line, never folded into the
 * Flow-run lines above it.
 *
 * They are two different runs: the `station-delivery` run Station attaches to
 * a session, and the `builder.build` run flow-agents drives. Rendering one
 * combined progress figure is what let a permanently-stalled delivery run read
 * as builder progress for a whole dogfood cycle. So this row states, in order,
 * WHAT was joined, HOW it was joined, and — when it wasn't — why not.
 *
 * The line carries no "as of" claim. `flow_run` has no currency stamp upstream
 * (filed on flow-agents), so any freshness Station printed here would be
 * invented; the row says where the values came from and stops there.
 */
/**
 * The provenance suffix on a projected run. The claim is deliberately narrow:
 * `state.json.updated_at` is when the sidecar FILE was last written, which is
 * the strongest honest statement available — `flow_run` carries no currency
 * stamp of its own, so nothing here may be read as the projection's age. When
 * the server sent no timestamp the sentence stays true by staying vague.
 */
function sidecarWriteSuffix(sidecarUpdatedAt: string | undefined): string {
  return sidecarUpdatedAt
    ? ` (per sidecar write at ${sidecarUpdatedAt})`
    : ' (per last sidecar write)';
}

function renderBuilderRun(builderRun: OperateBuilderRun | null): string[] {
  if (!builderRun) {
    return ['  builder run: none joined to this session'];
  }
  const identity = `identity=${builderRun.identityStatus} match=${builderRun.matchKind}`;
  if (builderRun.matchKind === 'none' || !builderRun.taskSlug) {
    return [
      `  builder run: unavailable (${identity})${builderRun.reason ? ` — ${builderRun.reason}` : ''}`,
    ];
  }
  const lines = [`  builder run: ${builderRun.taskSlug}  ${identity}`];
  // A binding whose sidecar could not be read is a BROKEN BINDING, not a run
  // that has yet to publish. Saying "no run projection published for this task
  // yet" here would assert a currency nobody has — and it would sit ABOVE the
  // true reason, so the row would contradict itself. The reason IS the row.
  if (builderRun.taskSidecarUnreadable) {
    if (builderRun.reason) lines.push(`    ${builderRun.reason}`);
    return lines;
  }
  if (builderRun.definitionId) {
    // Only printed when the sidecar actually projected a run. A joined task
    // with no `flow_run` prints the join and nothing else — an absent
    // projection is not step zero.
    lines.push(
      `    ${flowRunDisplayIdentity(builderRun.definitionId)}  step=${builderRun.currentStep ?? '?'}  status=${builderRun.status ?? '?'}${
        builderRun.openGateIds && builderRun.openGateIds.length > 0
          ? `  open gates: ${builderRun.openGateIds.join(', ')}`
          : ''
      }${sidecarWriteSuffix(builderRun.sidecarUpdatedAt)}`,
    );
  } else {
    lines.push('    no run projection published for this task yet');
  }
  if (builderRun.identityStatus !== 'present' && builderRun.reason) {
    lines.push(`    identity: ${builderRun.reason}`);
  }
  if (builderRun.runRef) {
    lines.push(`    run ref: ${builderRun.runRef}`);
  }
  return lines;
}

function renderGateState(state: OperateState): string[] {
  const lines = ['GATES'];
  const session = focusedSession(state);
  const gateState = session?.gateState;
  // `undefined` (never pulled) is not `null` (pulled, nothing joined) — say
  // nothing about a Builder run nobody has asked the server about yet.
  const builderRunLines =
    session && session.builderRun !== undefined
      ? renderBuilderRun(session.builderRun)
      : [];
  if (!gateState?.bound) {
    lines.push('  not Flow-bound');
    // Still rendered: a session with no station-delivery run can perfectly
    // well have a Builder run, and that is now the common case.
    lines.push(...builderRunLines);
    return lines;
  }
  lines.push(
    `  ${flowRunDisplayIdentity(gateState.definitionId ?? '?', gateState.runId)}  step=${gateState.currentStep ?? '?'}  status=${gateState.status ?? '?'}`,
  );
  lines.push(renderGateFreshness(gateState));
  if (gateState.latestVerdict) {
    const v = gateState.latestVerdict;
    lines.push(
      `  latest verdict: ${v.verdict}${v.gateId ? ` (${v.gateId})` : ''}${v.summary ? ` — ${v.summary}` : ''}`,
    );
  } else {
    lines.push('  latest verdict: (none yet)');
  }
  if (gateState.openGates && gateState.openGates.length > 0) {
    lines.push(
      `  open gates: ${gateState.openGates.map((g) => `${g.id}@${g.step}`).join(', ')}`,
    );
  }
  lines.push(...builderRunLines);
  return lines;
}

function renderTranscript(state: OperateState): string[] {
  const lines = ['TRANSCRIPT'];
  const session = focusedSession(state);
  if (!session || session.events.length === 0) {
    lines.push('  (no events yet)');
    return lines;
  }
  const rendered = coalesceTranscriptLines(session.events);
  lines.push(
    ...rendered.slice(-TRANSCRIPT_MAX_LINES).map((line) => `  ${line}`),
  );
  return lines;
}

/**
 * Coalesces consecutive `content.text-delta` events for the same `itemId`
 * into one line, and renders request/gate/lifecycle events as one-line
 * summaries — a small, local view-model fold (not shared with
 * `derive.ts`'s session-board/approvals/gate-state folds, which serve
 * different panes).
 */
function coalesceTranscriptLines(
  events: Array<Record<string, unknown>>,
): string[] {
  const lines: string[] = [];
  let pendingDeltaItemId: string | undefined;
  let pendingDeltaText = '';

  const flushPendingDelta = () => {
    if (pendingDeltaItemId !== undefined && pendingDeltaText.length > 0) {
      lines.push(`assistant: ${pendingDeltaText}`);
    }
    pendingDeltaItemId = undefined;
    pendingDeltaText = '';
  };

  for (const event of events) {
    const method = typeof event.method === 'string' ? event.method : undefined;
    if (method === 'content.text-delta' && typeof event.delta === 'string') {
      const itemId = typeof event.itemId === 'string' ? event.itemId : '';
      if (pendingDeltaItemId !== itemId) {
        flushPendingDelta();
        pendingDeltaItemId = itemId;
      }
      pendingDeltaText += event.delta;
      continue;
    }
    flushPendingDelta();

    if (method === 'request.opened') {
      lines.push(
        `[approval requested] ${typeof event.title === 'string' ? event.title : event.requestId}`,
      );
    } else if (method === 'request.resolved') {
      lines.push(
        `[approval resolved] ${event.requestId} -> ${event.status ?? '?'}`,
      );
    } else if (method === 'flow.run-attached') {
      const definitionId =
        typeof event.definitionId === 'string' ? event.definitionId : '?';
      const runId = typeof event.runId === 'string' ? event.runId : undefined;
      lines.push(`[flow bound] ${flowRunDisplayIdentity(definitionId, runId)}`);
    } else if (method === 'flow.gate-verdict') {
      lines.push(
        `[gate verdict] ${event.verdict}${event.gateId ? ` (${event.gateId})` : ''}`,
      );
    } else if (method === 'turn.completed') {
      lines.push(`[turn completed] ${event.finishReason ?? ''}`.trimEnd());
    } else if (method) {
      lines.push(`[${method}]`);
    }
  }
  flushPendingDelta();
  return lines;
}

function renderFooter(): string[] {
  const legend = OPERATE_KEYBINDINGS.map(
    (entry) => `${entry.keys}:${entry.binding}`,
  ).join('  ');
  return ['FOOTER', `  ${legend}`];
}
