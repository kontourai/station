/**
 * `station approvals` — list pending orchestration approval requests and
 * resolve them, entirely from the CLI (#165). Built on the canonical
 * `client/orchestration.ts` fetchers (#167 DRY client layer); adds zero new
 * server routes.
 *
 * `list` derives "pending" the same way the server does
 * (`src-server/services/orchestration/orchestration-session-state.ts:174-184`): a
 * `request.opened` event is pending unless a later `request.resolved` event
 * for the same `requestId` exists. `--thread=<id>` scopes to one thread's
 * events; without it, every orchestration session for `--agent`'s provider
 * is read (the same N+1 pattern `session-client.ts`'s `listSessions`/
 * `readSession` already use) and pending requests are aggregated across all
 * of them.
 *
 * `--watch` is thread-scoped only — it attaches to
 * `GET /api/orchestration/events?threadId=<id>`, the one SSE endpoint that
 * actually supports a `threadId` filter, and exits once the stream reports
 * `session.exited`. `--watch` without `--thread` is a documented error
 * rather than an invented multi-thread fan-in capability.
 *
 * `respond <thread-id> <request-id> <decision>` calls the already-shipped
 * `POST /api/orchestration/commands {type:'respondToRequest'}` route
 * (`src-server/routes/orchestration/orchestration.ts:48-52,297-317`).
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { RequestAnswerability } from '@kontourai/station-contracts/orchestration';
import {
  normalizeRequestAnswerability,
  unanswerableRequestNotice,
  unknownAnswerabilityNotice,
} from '@kontourai/station-contracts/orchestration';
import {
  type ApprovalDecision,
  authenticatedFetch,
  getOrchestrationSession,
  listOrchestrationSessions,
  respondToRequest,
} from '@kontourai/station-sdk/client';
import {
  type ParsedCoreArgs,
  printJsonMode,
  requirePositional,
} from './core-api.js';
import {
  consumeSseFrames,
  resolveApprovalsAgentProvider,
} from './session-client.js';

const VALID_DECISIONS: ApprovalDecision[] = [
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
];

interface PendingApproval {
  threadId: string;
  requestId: string;
  requestType: string;
  title: string;
  toolName?: string;
  ageMs?: number;
  /**
   * The serving Station's own answer, VERBATIM off the wire (station#1782 /
   * ADR 0012), or `null` when the request could not be joined to a session
   * summary at all.
   *
   * REQUIRED, INCLUDING THE `null` — the same rule `OperateBoardRow` states,
   * and for the same reason. The first version made this optional and simply
   * omitted it on a join miss, which is an absence a script cannot tell from
   * "an older CLI did not emit this field" — so the honest gap this arm
   * exists to name would have been folded back to "answerable" by exactly
   * the consumer it was written for. Two sites holding the same three-state
   * fact under opposite rules is the divergence ADR 0012 is about.
   *
   * This is read, never computed. Two of `projectRequestAnswerability`'s
   * three inputs (thread attachment, adapter registry) exist only inside the
   * serving process; the CLI is a different process over HTTP and has no
   * standing to derive them. A local re-derivation would be a label.
   */
  answerability: RequestAnswerability | null;
  /**
   * The human sentence for a row that is NOT plainly answerable — either the
   * unanswerable observation (qualification, observer, timestamp) or the
   * explicit unknown gap. Absent when the join succeeded and the answer was
   * yes, because the positive arm carries no basis to render.
   */
  answerabilityNote?: string;
}

interface OrchestrationSessionDetail {
  session: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
}

/**
 * Join one thread's pending approvals to the serving Station's answerability
 * observation for that thread's session.
 *
 * ANNOTATE, NEVER FILTER (ADR 0012, station#1782 AC2/AC4). Nothing here
 * removes a row and nothing here gates `station approvals respond`:
 * enforcement stays server-side, and a `respond` against a stranded request
 * still round-trips and reports the server's own rejection. The annotation
 * is advance notice, not a client-side veto — a client-side veto against a
 * possibly-stale observation would be exactly the "one surface hides what
 * another offers" divergence this decoration exists to end.
 *
 * A MISSING SESSION IS AN EXPLICIT GAP, never a silent "answerable" (AC5;
 * `docs/guides/code-quality.md`, "a default that decides"). Note the
 * distinction from a missing FIELD: a session that IS present but carries no
 * decoration is a pre-ADR-0012 peer, and `normalizeRequestAnswerability`
 * owns that case deliberately — the reader cannot observe a remote's adapter
 * registry, so the absence of a claim is not a claim, and it reads as
 * answerable there rather than being second-guessed here.
 */
function joinAnswerability(
  threadId: string,
  session: Record<string, unknown> | undefined,
): Pick<PendingApproval, 'answerability' | 'answerabilityNote'> {
  if (!session) {
    return {
      answerability: null,
      answerabilityNote: unknownAnswerabilityNotice(`session ${threadId}`),
    };
  }
  const answerability = normalizeRequestAnswerability(session.answerability);
  const provider =
    typeof session.provider === 'string' ? session.provider : undefined;
  const note = unanswerableRequestNotice(answerability, { provider });
  return { answerability, ...(note ? { answerabilityNote: note } : {}) };
}

/**
 * Mirrors `orchestration-session-state.ts:174-184`'s pending derivation:
 * resolved requestIds are excluded from the `request.opened` set.
 *
 * `session` is the decorated summary the same response already carried
 * (`GET /api/orchestration/sessions/:id` returns `{session, events}`), so
 * the join costs no extra request.
 */
function derivePendingApprovals(
  threadId: string,
  events: Array<Record<string, unknown>>,
  session?: Record<string, unknown>,
): PendingApproval[] {
  const answerability = joinAnswerability(threadId, session);
  const resolvedRequestIds = new Set(
    events
      .filter((event) => event.method === 'request.resolved')
      .map((event) => event.requestId as string | undefined)
      .filter((id): id is string => typeof id === 'string'),
  );

  const pending: PendingApproval[] = [];
  for (const event of events) {
    if (event.method !== 'request.opened') {
      continue;
    }
    const requestId =
      typeof event.requestId === 'string' ? event.requestId : undefined;
    if (!requestId || resolvedRequestIds.has(requestId)) {
      continue;
    }
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : undefined;
    const createdAt =
      typeof event.createdAt === 'string' ? event.createdAt : undefined;

    pending.push({
      threadId,
      requestId,
      requestType:
        typeof event.requestType === 'string' ? event.requestType : 'unknown',
      title: typeof event.title === 'string' ? event.title : '',
      toolName:
        typeof payload?.toolName === 'string' ? payload.toolName : undefined,
      ageMs: createdAt ? Date.now() - Date.parse(createdAt) : undefined,
      ...answerability,
    });
  }
  return pending;
}

function printApprovals(pending: PendingApproval[], jsonMode: boolean): void {
  // Compact single-line JSON is an approvals-local opt-in (AC3) — the
  // repo-wide `--json`-becomes-default flip proposed in the CLI audit is
  // explicitly out of scope for this wave. `printJsonMode` (core-api.ts)
  // owns the compact-vs-pretty branch, shared with `runApprovalsRespond`.
  //
  // station#1782: BOTH branches print the same payload, so the human
  // (pretty) branch carries `answerabilityNote` — the readable sentence with
  // qualification, observer and timestamp — and the `--json` branch carries
  // the structured `answerability` object verbatim alongside it. There is no
  // second, prose-only rendering of this command to keep in step, which is
  // the point: one payload cannot disagree with itself.
  printJsonMode(pending, jsonMode);
}

async function listPendingForThread(
  apiBase: string,
  threadId: string,
): Promise<PendingApproval[]> {
  const detail = await getOrchestrationSession<OrchestrationSessionDetail>(
    apiBase,
    threadId,
  );
  return derivePendingApprovals(threadId, detail.events ?? [], detail.session);
}

async function listPendingForProvider(
  apiBase: string,
  provider: string,
): Promise<PendingApproval[]> {
  const sessions =
    await listOrchestrationSessions<Array<Record<string, unknown>>>(apiBase);
  const matching = sessions.filter((session) => session.provider === provider);

  const pending: PendingApproval[] = [];
  for (const session of matching) {
    const threadId = String(session.threadId);
    const detail = await getOrchestrationSession<OrchestrationSessionDetail>(
      apiBase,
      threadId,
    );
    pending.push(
      // The detail response's own summary, not the list entry: both are
      // decorated, but the detail was read later, so its observation is the
      // fresher of the two and `observedAt` says which one this is.
      ...derivePendingApprovals(threadId, detail.events ?? [], detail.session),
    );
  }
  return pending;
}

/**
 * Built on `session-client.ts`'s shared `consumeSseFrames` (#165
 * iteration-2 code-review MEDIUM fix): that helper owns the
 * reader/decoder/buffer/frame-split/`data: `-extraction plumbing and the
 * `threadId` filter; this function only supplies the `method`-dispatch this
 * watch loop cares about (`request.opened`/`request.resolved` plus
 * `session.exited`), which differs from `sendMessage`'s
 * `content.text-delta`/`turn.completed` dispatch in `session-client.ts`.
 *
 * `onExit` is called (not just a bare `return`) once `session.exited` is
 * observed — the caller uses it to abort the underlying fetch, because the
 * real `/api/orchestration/events` route never ends its own response (see
 * `watchApprovals`'s docblock below); ending the frame loop alone would
 * leave the HTTP connection open.
 */
async function watchApprovalEvents({
  response,
  threadId,
  events,
  session,
  signal,
  onUpdate,
  onExit,
}: {
  response: Response;
  threadId: string;
  events: Array<Record<string, unknown>>;
  /**
   * The seed fetch's decorated summary, or `undefined` when that fetch found
   * nothing. Carried through so every re-print keeps the annotation; the SSE
   * frames re-derive the pending SET, not the observation, and the
   * observation's own `observedAt` is what discloses its age.
   */
  session: Record<string, unknown> | undefined;
  signal: AbortSignal;
  onUpdate: (pending: PendingApproval[]) => void;
  onExit: () => void;
}): Promise<void> {
  await consumeSseFrames({
    response,
    threadId,
    signal,
    onFrame: (event) => {
      if (
        event.method === 'request.opened' ||
        event.method === 'request.resolved'
      ) {
        events.push(event);
        onUpdate(derivePendingApprovals(threadId, events, session));
        return;
      }

      if (event.method === 'session.exited') {
        onExit();
        return true;
      }
    },
  });
}

/**
 * The real `GET /api/orchestration/events` route
 * (`src-server/routes/orchestration/orchestration.ts:319-362`) never ends its own
 * response — it streams a keepalive `ping` and only stops via
 * `stream.onAbort()`, i.e. only when the *client* disconnects. So this
 * function creates its own `AbortController`, passes `signal` to `fetch`
 * (mirroring `session-client.ts`'s `sendMessage`), and calls
 * `abortController.abort()` on every exit path — `session.exited` via
 * `watchApprovalEvents`'s `onExit`, and any error via the `catch` below —
 * so the socket is actually torn down and the CLI process can exit on its
 * own (#165 iteration-2 code-review HIGH fix).
 */
async function watchApprovals(
  apiBase: string,
  threadId: string,
  jsonMode: boolean,
): Promise<void> {
  // Seed with the thread's already-recorded events so any approval that was
  // opened before `--watch` attached is shown immediately, not only ones
  // that arrive after the SSE connection opens.
  let events: Array<Record<string, unknown>> = [];
  let session: Record<string, unknown> | undefined;
  try {
    const detail = await getOrchestrationSession<OrchestrationSessionDetail>(
      apiBase,
      threadId,
    );
    events = detail.events ?? [];
    session = detail.session;
  } catch (error) {
    // The thread may not exist yet (e.g. `--watch` attached before the
    // session starts) — that specific case (the server's own 404 text, see
    // `getOrchestrationSession`'s docblock) falls through silently and
    // relies on the live stream alone. Any other failure (5xx, malformed
    // body, network error, wrong `--api-base`) is a real problem the
    // operator should see, so it's surfaced as a stderr warning rather than
    // swallowed identically (#165 iteration-2 code-review LOW fix) — we
    // still continue to the SSE attempt below, which will itself raise if
    // the server is genuinely unreachable.
    if (!(error instanceof Error) || error.message !== 'Session not found') {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `Warning: could not seed approvals for thread ${threadId}: ${message}\n`,
      );
    }
  }
  printApprovals(derivePendingApprovals(threadId, events, session), jsonMode);

  const abortController = new AbortController();
  const response = await authenticatedFetch(
    `${apiBase}/api/orchestration/events?threadId=${encodeURIComponent(threadId)}`,
    { signal: abortController.signal },
  );
  if (!response.ok) {
    abortController.abort();
    throw new Error(
      `Orchestration event stream failed with HTTP ${response.status}`,
    );
  }

  try {
    await watchApprovalEvents({
      response,
      threadId,
      events,
      session,
      signal: abortController.signal,
      onUpdate: (pending) => printApprovals(pending, jsonMode),
      onExit: () => abortController.abort(),
    });
  } catch (error) {
    abortController.abort();
    throw error;
  }
}

async function runApprovalsList(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const agentSlug =
    typeof parsed.flags.agent === 'string' ? parsed.flags.agent : undefined;
  if (!agentSlug) {
    throw new Error('Missing required flag: --agent=<slug>');
  }

  const threadId =
    typeof parsed.flags.thread === 'string' ? parsed.flags.thread : undefined;
  const jsonMode = parsed.flags.json === true;
  const watch = parsed.flags.watch === true;

  // Pure usage validation before any request — station#979: provider
  // resolution below now always makes a live `/api/connections/:id` call
  // (AC5, reading `config.provider` instead of a hardcoded map), so this
  // check must stay ahead of it or `--watch` without `--thread` would no
  // longer fail before any network call.
  if (watch && !threadId) {
    throw new Error(
      '--watch requires --thread (per-thread SSE only; no multi-thread watch route exists)',
    );
  }

  const provider = await resolveApprovalsAgentProvider(
    apiBase,
    agentId(agentSlug),
  );
  if (!provider) {
    throw new Error(
      `Agent '${agentSlug}' is not bound to an approvals-capable external engine.`,
    );
  }

  if (watch) {
    await watchApprovals(apiBase, threadId as string, jsonMode);
    return;
  }

  const pending = threadId
    ? await listPendingForThread(apiBase, threadId)
    : await listPendingForProvider(apiBase, provider);

  printApprovals(pending, jsonMode);
}

async function runApprovalsRespond(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const threadId = requirePositional(parsed, 1, 'thread id');
  const requestId = requirePositional(parsed, 2, 'request id');
  const decision = requirePositional(parsed, 3, 'decision');

  if (!VALID_DECISIONS.includes(decision as ApprovalDecision)) {
    throw new Error(
      `Unknown decision: ${decision}. Use one of: ${VALID_DECISIONS.join(', ')}.`,
    );
  }

  const { receipt } = await respondToRequest(apiBase, {
    threadId,
    requestId,
    decision: decision as ApprovalDecision,
  });

  const jsonMode = parsed.flags.json === true;
  const output = { success: true, threadId, requestId, decision, receipt };
  printJsonMode(output, jsonMode);
}

export async function runApprovalsCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const action = requirePositional(parsed, 0, 'approvals action');

  if (action === 'list') {
    await runApprovalsList(apiBase, parsed);
    return;
  }

  if (action === 'respond') {
    await runApprovalsRespond(apiBase, parsed);
    return;
  }

  throw new Error("Unknown approvals action. Use 'list' or 'respond'.");
}
