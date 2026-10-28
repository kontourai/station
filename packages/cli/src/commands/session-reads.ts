/**
 * #3427: the person's Session reads from the CLI — `station sessions
 * wait|digest|transcript|search` and `station activity`. Each is a thin
 * client over one person-facing route and its one SDK fetcher (as `station
 * delegate` is), with the profile credential as a PERSON: never a
 * station-control caller, so the agent-only leaves keep refusing it.
 *
 * `--json` prints the route's projection re-projected here: the fields this
 * command documents, never whatever else a newer server adds.
 *
 * `sessions wait` keeps `station delegate wait`'s honesty contract: waiting
 * only observes, and the exit code says what was observed.
 *
 * - 0: the turn completed (`turn-settled`), or the Session is idle (`idle`,
 *   or `turn-settled` with no turn running to wait on).
 * - 3: the turn ended without completing: aborted, failed, exited, or cut off
 *   by a Station restart (`restart-interrupted`, never read as settled).
 * - 5: the wait budget ran out with the Session still running.
 * - 6: a newer Session now serves the conversation (`superseded`: wait on
 *   `currentSessionId`), or an answer this CLI cannot classify.
 * - 2: observation was lost: a read failed after the wait began, or the
 *   Station stayed unreachable for the reconnect window. A Station that stops
 *   answering (a restart) and a full wait budget are waited out, not reported.
 * - 130: Ctrl-C. The Session keeps running in every case.
 */

import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import {
  getSessionDigest,
  listSessionActivity,
  readConversation,
  type SessionActivityRow,
  type SessionDigestPage,
  SessionReadsUnsupportedError,
  type SessionWaitAnswer,
  type SessionWaitUntil,
  StationHttpError,
  StationRequestTimeoutError,
  searchStation,
  waitForSession,
} from '@kontourai/station-sdk/client';
import {
  cliRequestScope,
  optionalValueFlag,
  type ParsedCoreArgs,
  requirePositional,
} from './core-api.js';

/** The longest one server-held wait runs (the route's own cap). */
const WAIT_CALL_MAX_MS = 50_000;
/** The request deadline beyond the server's hold, for the answer to arrive. */
const WAIT_CALL_SLACK_MS = 15_000;
/**
 * How long a wait keeps reaching for a Station that stopped answering, such
 * as one restarting: the restart is exactly when a turn can be cut off, and
 * giving up at once would report observation lost instead of that turn.
 */
const RECONNECT_WINDOW_MS = 60_000;
/** The pause before calling again after a capacity refusal or a lost call. */
const RETRY_DELAY_MS = 2_000;
export const SESSION_WAIT_DEFAULT_TIMEOUT_SECONDS = 3600;
export const SESSION_WAIT_MAX_TIMEOUT_SECONDS = 86_400;

export type SessionWaitOutcome =
  | 'completed'
  | 'idle'
  | 'failed'
  | 'restart-interrupted'
  | 'wait-timeout'
  | 'superseded'
  | 'unknown'
  | 'observation-lost'
  | 'cancelled';

const EXIT_CODES: Record<SessionWaitOutcome, number> = {
  completed: 0,
  idle: 0,
  'observation-lost': 2,
  failed: 3,
  'restart-interrupted': 3,
  'wait-timeout': 5,
  superseded: 6,
  unknown: 6,
  cancelled: 130,
};

export interface SessionWaitResult {
  outcome: SessionWaitOutcome;
  exitCode: number;
  sessionId: string;
  until: SessionWaitUntil;
  /** The last answer's fields, when any call answered. */
  state?: 'running' | 'idle';
  openTurnId?: string;
  settledTurn?: SessionWaitAnswer['settledTurn'];
  interruptedTurn?: SessionWaitAnswer['interruptedTurn'];
  alreadyIdle?: true;
  eventCursor?: number;
  superseded?: true;
  currentSessionId?: string;
  calls: number;
  elapsedMs: number;
  timeoutMs: number;
  /** A safe category for `observation-lost`: never a raw message or body. */
  lastError?: string;
}

/** A safe, fixed description of a failed wait call. */
function describeWaitError(error: unknown): string {
  if (error instanceof StationRequestTimeoutError)
    return `wait call timed out after ${error.timeoutMs}ms`;
  if (error instanceof StationHttpError)
    return `wait call failed with HTTP ${error.status}${error.code ? ` (${error.code})` : ''}`;
  if (error instanceof TypeError) return 'the Station could not be reached';
  return 'wait call failed';
}

const isAbort = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError';

const isCapacityRefusal = (error: unknown) =>
  error instanceof StationHttpError &&
  error.status === 429 &&
  error.code === 'wait_capacity';

/**
 * Statuses a proxy or edge answers while the Station behind it is down:
 * gateway errors, and an edge's "origin unreachable" family (520-524, 530).
 * A plain 500 is the Station's own failure, reported at once.
 */
const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);

/** The Station did not answer, or answered as a proxy does while it is down. */
const isUnreachable = (error: unknown) =>
  error instanceof TypeError ||
  error instanceof StationRequestTimeoutError ||
  (error instanceof StationHttpError && GATEWAY_STATUSES.has(error.status));

function abortableSleep(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** What one answer says, or `undefined` to keep waiting. */
function classify(
  until: SessionWaitUntil,
  answer: SessionWaitAnswer,
): SessionWaitOutcome | undefined {
  // A turn a restart cut off is never a settlement, whatever else held.
  if (answer.interruptedTurn) return 'restart-interrupted';
  const turn = answer.settledTurn;
  // A turn that ended after the cursor answers the wait, superseded or not.
  if (
    until === 'turn-settled' &&
    !answer.alreadyIdle &&
    turn &&
    (answer.settled || answer.timedOut)
  )
    return turn.outcome === 'completed' ? 'completed' : 'failed';
  // A newer Session serves the conversation: this one being idle says
  // nothing about the work, so it is never reported as idle.
  if (answer.superseded) return 'superseded';
  // Nothing was running to wait on; an earlier turn's outcome is not this
  // wait's (it stays in the output).
  if (until === 'turn-settled' && answer.alreadyIdle) return 'idle';
  if (answer.settled) return until === 'idle' ? 'idle' : 'unknown';
  return undefined;
}

/**
 * The wait loop: one bounded server-held wait after another until the
 * condition holds or the budget runs out. A `turn-settled` wait with no
 * cursor waits on the turn running now; after a call times out, the next
 * call carries that answer's `eventCursor`, so a turn ending between calls
 * is still seen.
 */
export async function waitOnSession(input: {
  apiBase?: string;
  sessionId: string;
  until: SessionWaitUntil;
  afterEventCursor?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** A line for the person while the wait keeps going without an answer. */
  onNotice?: (message: string) => void;
  deps?: {
    now?: () => number;
    /** Resolves after `ms`, or as soon as `signal` aborts. */
    sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
    call?: (
      query: { timeoutMs: number; afterEventCursor?: number },
      signal: AbortSignal | undefined,
    ) => Promise<SessionWaitAnswer>;
  };
}): Promise<SessionWaitResult> {
  const now = input.deps?.now ?? Date.now;
  const sleep = input.deps?.sleep ?? abortableSleep;
  const call =
    input.deps?.call ??
    ((query, signal) =>
      waitForSession(
        input.apiBase!,
        input.sessionId,
        { until: input.until, ...query },
        {
          ...(signal ? { signal } : {}),
          timeoutMs: query.timeoutMs + WAIT_CALL_SLACK_MS,
        },
      ));
  const started = now();
  const deadline = started + input.timeoutMs;
  let cursor = input.afterEventCursor;
  let last: SessionWaitAnswer | undefined;
  let calls = 0;
  /** When calls started failing to reach the Station, if they are failing. */
  let unreachableSince: number | undefined;
  let toldCapacity = false;
  const finish = (
    outcome: SessionWaitOutcome,
    lastError?: string,
  ): SessionWaitResult => ({
    outcome,
    exitCode: EXIT_CODES[outcome],
    sessionId: input.sessionId,
    until: input.until,
    ...(last
      ? {
          state: last.state,
          ...(last.openTurnId ? { openTurnId: last.openTurnId } : {}),
          ...(last.settledTurn ? { settledTurn: last.settledTurn } : {}),
          ...(last.interruptedTurn
            ? { interruptedTurn: last.interruptedTurn }
            : {}),
          ...(last.alreadyIdle ? { alreadyIdle: true as const } : {}),
          eventCursor: last.eventCursor,
          ...(last.superseded ? { superseded: true as const } : {}),
          ...(last.currentSessionId
            ? { currentSessionId: last.currentSessionId }
            : {}),
        }
      : {}),
    calls,
    elapsedMs: now() - started,
    timeoutMs: input.timeoutMs,
    ...(lastError ? { lastError } : {}),
  });
  while (true) {
    if (input.signal?.aborted) return finish('cancelled');
    const remaining = deadline - now();
    if (remaining <= 0) return finish('wait-timeout');
    let answer: SessionWaitAnswer;
    try {
      calls += 1;
      answer = await call(
        {
          timeoutMs: Math.max(1, Math.min(remaining, WAIT_CALL_MAX_MS)),
          ...(input.until === 'turn-settled' && cursor !== undefined
            ? { afterEventCursor: cursor }
            : {}),
        },
        input.signal,
      );
    } catch (error) {
      if (input.signal?.aborted || isAbort(error)) return finish('cancelled');
      // Every wait slot is taken (this person's, or Station's): nothing was
      // lost, so wait for one within the budget.
      if (isCapacityRefusal(error)) {
        if (!toldCapacity) {
          toldCapacity = true;
          // The route says which limit it is (this person's, or Station's).
          input.onNotice?.(
            `Waiting for a free wait slot (${(error as StationHttpError).message.replace(/\.$/, '')}).`,
          );
        }
        await sleep(Math.min(RETRY_DELAY_MS, remaining), input.signal);
        continue;
      }
      // A Station that stopped answering may be restarting: keep reaching
      // for it, carrying the cursor, so a turn the restart cut off is seen.
      if (isUnreachable(error)) {
        unreachableSince ??= now();
        if (now() - unreachableSince < RECONNECT_WINDOW_MS) {
          await sleep(Math.min(RETRY_DELAY_MS, remaining), input.signal);
          continue;
        }
      }
      // Before anything was observed, a refusal is the command's answer
      // (not found, preview off, an older Station): its message is shown.
      if (
        last === undefined &&
        (error instanceof SessionReadsUnsupportedError ||
          (error instanceof StationHttpError &&
            error.status >= 400 &&
            error.status < 500))
      )
        throw error;
      return finish('observation-lost', describeWaitError(error));
    }
    unreachableSince = undefined;
    // An abort that raced this answer wins: it never claims an outcome.
    if (input.signal?.aborted) return finish('cancelled');
    last = answer;
    const outcome = classify(input.until, answer);
    if (outcome) return finish(outcome);
    if (input.until === 'turn-settled') cursor = answer.eventCursor;
  }
}

function parseSeconds(parsed: ParsedCoreArgs): number {
  const raw = optionalValueFlag(parsed, 'timeout');
  if (raw === undefined) return SESSION_WAIT_DEFAULT_TIMEOUT_SECONDS;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!(value >= 1 && value <= SESSION_WAIT_MAX_TIMEOUT_SECONDS))
    throw new Error(
      `--timeout must be a whole number of seconds from 1 to ${SESSION_WAIT_MAX_TIMEOUT_SECONDS}.`,
    );
  return value;
}

function parseCount(
  parsed: ParsedCoreArgs,
  name: string,
  min: number,
): number | undefined {
  const raw = optionalValueFlag(parsed, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < min)
    throw new Error(`--${name} must be a whole number of at least ${min}.`);
  return Number(raw);
}

/**
 * These reads answer on the targeted Station. `--on` names an Environment to
 * RUN on; it does not select whose Sessions are read, so it is refused rather
 * than ignored.
 */
function refuseEnvironmentSelector(parsed: ParsedCoreArgs): void {
  if (parsed.flags.on !== undefined)
    throw new Error(
      '--on selects where work runs; Session reads answer on the targeted Station. Use --station=<name> to read another Station.',
    );
}

function waitLine(result: SessionWaitResult): string {
  const id = result.sessionId;
  switch (result.outcome) {
    case 'completed':
      return `Session ${id}: the turn${result.settledTurn?.turnId ? ` ${result.settledTurn.turnId}` : ''} completed.`;
    case 'idle':
      return result.alreadyIdle
        ? `Session ${id} is idle: no turn was running to wait on.`
        : `Session ${id} is idle.`;
    case 'failed':
      return `Session ${id}: the turn ended without completing (${result.settledTurn?.outcome ?? 'unknown'}).`;
    case 'restart-interrupted':
      return `Session ${id}: turn ${result.interruptedTurn?.turnId} was interrupted when Station restarted, before it finished. Nothing proves its work completed.`;
    case 'wait-timeout':
      return `Wait budget reached; Session ${id} is still ${result.state ?? 'running'}. Waiting never stops the Session: wait again to keep watching${result.eventCursor !== undefined ? ` (--after-cursor=${result.eventCursor})` : ''}.`;
    case 'superseded':
      return `Session ${id} no longer serves its conversation; wait on ${result.currentSessionId} instead.`;
    case 'observation-lost':
      return `Observation stopped while waiting on Session ${id}: ${result.lastError}. Its outcome is not known from here; the Session was not stopped.${result.eventCursor !== undefined && result.until === 'turn-settled' ? ` Wait again with --after-cursor=${result.eventCursor} to see what happened since.` : ''}`;
    case 'cancelled':
      return `Stopped waiting on Session ${id}. The Session keeps running.`;
    default:
      return `Session ${id}: the answer could not be classified (state ${result.state ?? 'unknown'}).`;
  }
}

export async function runSessionsWait(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  refuseEnvironmentSelector(parsed);
  const sessionId = requirePositional(parsed, 1, 'session id');
  const until = optionalValueFlag(parsed, 'until') ?? 'turn-settled';
  if (until !== 'turn-settled' && until !== 'idle')
    throw new Error('--until must be turn-settled or idle.');
  const afterEventCursor = parseCount(parsed, 'after-cursor', 0);
  if (afterEventCursor !== undefined && until !== 'turn-settled')
    throw new Error('--after-cursor applies only to --until=turn-settled.');
  const timeoutMs = parseSeconds(parsed) * 1000;
  const jsonMode = parsed.flags.json === true;

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);
  let result: SessionWaitResult;
  try {
    result = await waitOnSession({
      apiBase,
      sessionId,
      until,
      ...(afterEventCursor !== undefined ? { afterEventCursor } : {}),
      timeoutMs,
      signal: controller.signal,
      // Progress goes to stderr, and not at all under --json.
      ...(jsonMode
        ? {}
        : {
            onNotice: (message: string) => process.stderr.write(`${message}\n`),
          }),
    });
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
  if (jsonMode)
    console.log(
      JSON.stringify({
        ok: result.exitCode === 0,
        kind: 'sessions.wait',
        data: result,
      }),
    );
  else console.log(waitLine(result));
  process.exit(result.exitCode);
}

/** The digest as this command documents it. */
function projectDigest(page: SessionDigestPage) {
  return {
    session: {
      sessionId: page.session.sessionId,
      conversationId: page.session.conversationId,
      ...(page.session.title ? { title: page.session.title } : {}),
      ...(page.session.projectSlug
        ? { projectSlug: page.session.projectSlug }
        : {}),
      engine: page.session.engine,
      ...(page.session.agent ? { agent: page.session.agent } : {}),
      status: page.session.status,
      turnCount: page.session.turnCount,
      ...(page.session.worktree ? { worktree: page.session.worktree } : {}),
    },
    turns: page.turns,
    ...(page.delegatedChildrenIncomplete
      ? { delegatedChildrenIncomplete: true as const }
      : {}),
    nextCursor: page.nextCursor,
  };
}

export async function runSessionsDigest(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  refuseEnvironmentSelector(parsed);
  const sessionId = requirePositional(parsed, 1, 'session id');
  const turnLimit = parseCount(parsed, 'turn-limit', 1);
  const cursor = optionalValueFlag(parsed, 'cursor');
  const page = projectDigest(
    await getSessionDigest(apiBase, sessionId, {
      ...(turnLimit !== undefined ? { turnLimit } : {}),
      ...(cursor ? { cursor } : {}),
    }),
  );
  if (parsed.flags.json === true) {
    console.log(JSON.stringify(page));
    return;
  }
  const { session } = page;
  console.log(
    `${session.title ?? session.sessionId} — ${session.status}, ${session.turnCount} turn(s), ${session.engine}${session.projectSlug ? `, Project ${session.projectSlug}` : ''}`,
  );
  for (const turn of page.turns) {
    const request =
      typeof turn.request === 'string' ? turn.request : '(no request text)';
    const outcome = typeof turn.outcome === 'string' ? turn.outcome : '';
    console.log(`  ${outcome.padEnd(11)} ${request}`);
  }
  if (page.nextCursor) console.log(`More: --cursor=${page.nextCursor}`);
}

export async function runSessionsTranscript(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  refuseEnvironmentSelector(parsed);
  const id = requirePositional(parsed, 1, 'session or conversation id');
  const aroundMessageId = optionalValueFlag(parsed, 'around');
  const cursor = optionalValueFlag(parsed, 'cursor');
  if (aroundMessageId && cursor)
    throw new Error('Use --around or --cursor, not both.');
  const limit = parseCount(parsed, 'limit', 1);
  const page = await readConversation(apiBase, id, {
    ...(aroundMessageId ? { aroundMessageId } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  const projected = {
    conversationId: page.conversationId,
    messageCount: page.messageCount,
    messages: page.messages.map((message) => ({
      id: message.id,
      index: message.index,
      role: message.role,
      text: message.text,
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
      ...(message.tools ? { tools: message.tools } : {}),
      ...(message.textTruncated
        ? { textTruncated: message.textTruncated }
        : {}),
    })),
    prevCursor: page.prevCursor,
    nextCursor: page.nextCursor,
  };
  if (parsed.flags.json === true) {
    console.log(JSON.stringify(projected));
    return;
  }
  for (const message of projected.messages)
    console.log(`[${message.index}] ${message.role}: ${message.text}`);
  if (projected.prevCursor)
    console.log(`Older: --cursor=${projected.prevCursor}`);
  if (projected.nextCursor)
    console.log(`Newer: --cursor=${projected.nextCursor}`);
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Two provider tokens, as `search_sessions` carries them. */
function encodeContinuation(
  sources: readonly Record<string, unknown>[],
): string | undefined {
  const entries = sources.flatMap((source) =>
    text(source.providerId) && text(source.continuation)
      ? [{ providerId: source.providerId, token: source.continuation }]
      : [],
  );
  return entries.length > 0
    ? Buffer.from(JSON.stringify(entries)).toString('base64url')
    : undefined;
}

function decodeContinuation(
  value: string,
): Array<{ providerId: string; token: string }> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length >= 1 &&
      parsed.length <= 2 &&
      parsed.every(
        (entry) =>
          typeof entry?.providerId === 'string' &&
          typeof entry?.token === 'string',
      )
    )
      return parsed.map((entry) => ({
        providerId: entry.providerId,
        token: entry.token,
      }));
  } catch {
    // Refused below.
  }
  throw new Error(
    '--continuation is not one this command printed. Search again without it.',
  );
}

export async function runSessionsSearch(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  refuseEnvironmentSelector(parsed);
  const query = parsed.positionals.slice(1).join(' ').trim();
  if (query.length < 2 || query.length > 256)
    throw new Error('A search query must be 2 to 256 characters.');
  const continuation = optionalValueFlag(parsed, 'continuation');
  const data = await searchStation(
    apiBase,
    {
      version: UNIFIED_SEARCH_V1,
      query,
      filters: { kinds: ['session', 'message'] },
      ...(continuation
        ? { continuations: decodeContinuation(continuation) }
        : {}),
    },
    { requestScope: cliRequestScope(apiBase) },
  );
  // `search_sessions`'s projection: where each hit is, what it says and how
  // to open it. A source that could not answer in full is stated, never
  // dropped: an empty list is an answer only when every source was available.
  const body = record(data);
  const sources = (Array.isArray(body.sources) ? body.sources : []).map(record);
  const next = encodeContinuation(sources);
  const projected = {
    state: text(body.state) ?? 'unavailable',
    results: (Array.isArray(body.results) ? body.results : []).map((value) => {
      const hit = record(value);
      const scope = record(hit.scope);
      const open = record(hit.openIntent);
      return {
        kind: text(hit.kind),
        sessionId: text(scope.sessionId) ?? text(open.sessionId),
        projectId: text(scope.projectId),
        title: text(hit.title),
        snippet: text(hit.snippet),
        messageId: text(open.messageId),
      };
    }),
    incompleteSources: sources.flatMap((source) =>
      source.state === 'available'
        ? []
        : [
            {
              source: text(source.providerId),
              state: text(source.state),
              reason: text(source.reason),
            },
          ],
    ),
    ...(next ? { continuation: next } : {}),
  };
  if (parsed.flags.json === true) {
    console.log(JSON.stringify(projected));
    return;
  }
  for (const hit of projected.results)
    console.log(
      `${hit.sessionId ?? '?'}${hit.messageId ? ` (message ${hit.messageId})` : ''}: ${hit.title ?? ''}${hit.snippet ? ` — ${hit.snippet}` : ''}`,
    );
  if (projected.results.length === 0) console.log('No matches.');
  for (const source of projected.incompleteSources)
    console.log(
      `Partial: ${source.source ?? 'a source'} was ${source.state}${source.reason ? ` (${source.reason})` : ''}; results may be missing.`,
    );
  if (projected.continuation)
    console.log(`More: --continuation=${projected.continuation}`);
}

/** One activity row as this command documents it. */
function projectRow(row: SessionActivityRow) {
  return {
    sessionId: row.sessionId,
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.projectSlug ? { projectSlug: row.projectSlug } : {}),
    engine: row.engine,
    ...(row.agent ? { agent: row.agent } : {}),
    status: row.status,
    turnRunning: row.turnRunning,
    lastActivityAt: row.lastActivityAt,
    ...(row.workingDirectory ? { workingDirectory: row.workingDirectory } : {}),
    ...(row.worktree ? { worktree: row.worktree } : {}),
    ...(row.claims ? { claims: row.claims } : {}),
  };
}

export async function runActivityCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  refuseEnvironmentSelector(parsed);
  if (parsed.positionals.length > 0)
    throw new Error(
      `Unexpected argument: ${parsed.positionals[0]}. Use --project=<slug> to narrow to one Project.`,
    );
  const projectSlug = optionalValueFlag(parsed, 'project');
  const limit = parseCount(parsed, 'limit', 1);
  const activeWithinMinutes = parseCount(parsed, 'active-within', 1);
  const cursor = optionalValueFlag(parsed, 'cursor');
  const page = await listSessionActivity(apiBase, {
    ...(projectSlug ? { projectSlug } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(activeWithinMinutes !== undefined ? { activeWithinMinutes } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const projected = {
    sessions: page.sessions.map(projectRow),
    nextCursor: page.nextCursor,
  };
  if (parsed.flags.json === true) {
    console.log(JSON.stringify(projected));
    return;
  }
  if (projected.sessions.length === 0) console.log('No Sessions.');
  for (const row of projected.sessions) {
    const where = row.worktree
      ? ` ${row.worktree.branch}`
      : row.workingDirectory
        ? ` ${row.workingDirectory}`
        : '';
    console.log(
      `${row.sessionId}  ${row.status}${row.turnRunning ? ' (turn running)' : ''}  ${row.projectSlug ?? 'global'}  ${row.title ?? ''}${where}`,
    );
    for (const claim of row.claims ?? [])
      console.log(
        `    claims ${claim.workItemRef ?? claim.paths?.join(', ') ?? claim.claimId} until ${claim.expiresAt}`,
      );
  }
  if (projected.nextCursor)
    console.log(`More: --cursor=${projected.nextCursor}`);
}

/** Exported for tests: the documented wait outcomes and their exit codes. */
export const SESSION_WAIT_EXIT_CODES: Readonly<
  Record<SessionWaitOutcome, number>
> = EXIT_CODES;
