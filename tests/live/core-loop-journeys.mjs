/**
 * Core-loop journey tests (kontourai/station#766 item 2).
 *
 * Scripted end-to-end journeys against the BUILT app on a throwaway home —
 * the four things that must never break, each the regression net for a
 * Critical/High finding of the #765 fresh-home UX audit:
 *
 *  1. multi-turn-continuity — three turns in one conversation on the Claude
 *     Code engine, including a continuation across an explicit stopSession
 *     (the exact #765 A1 path: child session resumed from a stopped
 *     predecessor's cursor, which only works because persistSession is
 *     forced on for durable conversations — PR #796). Asserts
 *     same-conversation continuity, no "No conversation found with session
 *     ID", and no stray conversations/sessions (#765 A2's fragmentation).
 *  2. capacity-gate — boots a second instance with the attested
 *     STATION_E2E_RESOURCE_POSTURE_CRITICAL override
 *     (src-server/services/infra/resource-posture.ts) and asserts the ONE
 *     forced observation is visible on the posture endpoint and refuses a
 *     real dispatch with the typed `resource_posture_critical` code; then
 *     asserts the chat SURFACE renders that refusal ("Host is at capacity"
 *     ephemeral + Retry) instead of an eternal "Working…" (#765 A3), using
 *     the exact wire shape the server emits (pinned by
 *     orchestration.routes.test.ts "preserves a critical resource refusal
 *     code at the outer HTTP seam").
 *  3. project-deep-link-reload — create a project, chat in it, reload the
 *     exact `?chat=<id>&dock=open` deep link, and assert the browser lands
 *     back in the conversation with the transcript visible — not the
 *     Activity inspector (#765 A5).
 *  4. pairing-delegation-loop — a second temp-home Station requests device
 *     access via the CLI (`station environment access request`), the
 *     pending request surfaces on the host (pairing-request notification /
 *     Needs-attention item — #765 D5), the host approves via the CLI, and
 *     the request reads `confirmed`.
 *
 * Journeys that need the Claude Code CLI report NOT-EXERCISED (loudly, in
 * the summary and the exit report) when the engine is not ready on this
 * host — hosted CI runners have no signed-in `claude`, so there the suite
 * proves journeys 2 (posture + surface) and 4 end-to-end and discloses the
 * rest. Set CORE_LOOP_REQUIRE_CLAUDE=1 to turn those disclosures into
 * failures on hosts where the engine is expected.
 *
 * Run with `npm run journeys:core-loop`. Nightly cadence, never per-PR —
 * see .github/workflows/fresh-home-walkthrough.yml (second job).
 *
 * Like the walkthrough this uses no storageState. It intercepts `/api/**`
 * in exactly ONE place: journey 2's surface assertion replays the server's
 * own pinned refusal wire shape into the composer's dispatch, because no
 * healthy instance can produce a real refusal for an engine that is not
 * ready (assertAdapterReady runs before admitEngineStart —
 * orchestration-service.ts) and the capacity instance refuses before any
 * transcript exists to render into.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  api,
  apiOk,
  pairBrowser,
  poll,
  settlePageReason,
  startTempHomeInstance,
} from './helpers/station-instance.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const INSTANCE = process.env.CORE_LOOP_INSTANCE ?? 'core-loop-journeys';
const SERVER_PORT = Number(process.env.CORE_LOOP_SERVER_PORT ?? 3372);
const UI_PORT = Number(process.env.CORE_LOOP_UI_PORT ?? 5404);
// A full port BLOCK away from the main instance: the launcher reserves
// server..server+3 (terminal, voice, consent) plus the UI port, and refuses
// a start whose block overlaps another live instance's.
const CAPACITY_SERVER_PORT = Number(
  process.env.CORE_LOOP_CAPACITY_SERVER_PORT ?? 3382,
);
const CAPACITY_UI_PORT = Number(process.env.CORE_LOOP_CAPACITY_UI_PORT ?? 5410);
const OUTPUT_ROOT = resolve(
  ROOT,
  process.env.CORE_LOOP_OUTPUT_DIR ?? 'test-results/core-loop-journeys',
);
const UI_ORIGIN = `http://localhost:${UI_PORT}`;
const SETTLE_TIMEOUT_MS = 30_000;
/** A real Claude Code turn on a loaded host; generous, but bounded. */
const TURN_TIMEOUT_MS = Number(
  process.env.CORE_LOOP_TURN_TIMEOUT_MS ?? 240_000,
);
const REQUIRE_CLAUDE = process.env.CORE_LOOP_REQUIRE_CLAUDE === '1';

const SESSION_NOT_FOUND_PATTERN = /No conversation found with session ID/i;

// ---------------------------------------------------------------------------
// Journey accounting: independently reportable, loud, exit-code honest.
// ---------------------------------------------------------------------------

/** @type {{ id: string, status: 'passed'|'failed'|'not-exercised', notes: string[] }[]} */
const results = [];

class NotExercised extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'NotExercised';
  }
}

/**
 * Optional comma-separated journey-id filter (CORE_LOOP_JOURNEYS=1-multi-…)
 * for targeted reruns and fault-injection proofs. A skipped journey is
 * recorded as `skipped` — visibly distinct from passed AND from
 * not-exercised, and never a pass.
 */
const JOURNEY_FILTER = (process.env.CORE_LOOP_JOURNEYS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

/**
 * Journey failures expected on current main, keyed by journey id — the
 * fresh-home walkthrough's EXPECTED_PLUGIN_FAILURES discipline: each entry
 * names the tracking issue AND the exact failure it excuses
 * (`expectedMessageSubstring`); only a failure whose message contains that
 * substring reports EXPECTED-FAIL (visible in the summary, not hidden) —
 * any other failure of the same journey is a REAL failure. A journey listed
 * here that PASSES fails the run: the entry is stale and must be removed.
 */
const EXPECTED_JOURNEY_FAILURES = new Map([
  // (empty since kontourai/station#834 was fixed: the continuation
  // eligibility gate now treats a stopped, unloaded current child as
  // continuable through the successor reserve path.)
]);

async function runJourney(id, title, fn) {
  const notes = [];
  const note = (line) => {
    notes.push(line);
    console.log(`  [${id}] ${line}`);
  };
  if (JOURNEY_FILTER.length > 0 && !JOURNEY_FILTER.includes(id)) {
    results.push({
      id,
      status: 'skipped',
      notes: ['skipped by CORE_LOOP_JOURNEYS filter'],
    });
    console.log(`\n=== journey ${id}: SKIPPED (CORE_LOOP_JOURNEYS filter)`);
    return;
  }
  console.log(`\n=== journey ${id}: ${title}`);
  const expectation = EXPECTED_JOURNEY_FAILURES.get(id);
  try {
    await fn(note);
    if (expectation) {
      notes.push(
        `journey passed but is listed in EXPECTED_JOURNEY_FAILURES (${expectation.issue}) — remove its entry`,
      );
      results.push({ id, status: 'failed', notes });
      console.error(
        `=== journey ${id}: FAILED — passed while listed in EXPECTED_JOURNEY_FAILURES (${expectation.issue}); the entry is stale and must be removed`,
      );
      return;
    }
    results.push({ id, status: 'passed', notes });
    console.log(`=== journey ${id}: PASSED`);
  } catch (error) {
    if (error instanceof NotExercised && !REQUIRE_CLAUDE) {
      notes.push(`NOT-EXERCISED: ${error.message}`);
      results.push({ id, status: 'not-exercised', notes });
      console.error(`=== journey ${id}: NOT-EXERCISED — ${error.message}`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (expectation && message.includes(expectation.expectedMessageSubstring)) {
      notes.push(`EXPECTED-FAIL (${expectation.issue}): ${message}`);
      results.push({ id, status: 'expected-fail', notes });
      console.error(
        `=== journey ${id}: EXPECTED-FAIL — ${expectation.issue}: ${message}`,
      );
      return;
    }
    notes.push(`FAILED: ${error instanceof Error ? error.stack : error}`);
    results.push({ id, status: 'failed', notes });
    console.error(`=== journey ${id}: FAILED — ${error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Shared journey plumbing
// ---------------------------------------------------------------------------

function envelopeData(payload) {
  return payload && typeof payload === 'object' && 'data' in payload
    ? payload.data
    : payload;
}

/**
 * The Claude Code engine connection as the product reports it. Journeys that
 * drive a real engine turn require `ready`; everything else must not silently
 * downgrade — absence of the connection row entirely is a FAILURE (the
 * engines inventory itself broke), only not-ready is a disclosure.
 */
async function claudeEngineState(page) {
  const payload = await apiOk(page, 'GET', '/api/connections/agents');
  const connections = envelopeData(payload);
  assert(
    Array.isArray(connections),
    `GET /api/connections/agents did not return a connection list: ${JSON.stringify(payload)?.slice(0, 300)}`,
  );
  const claude = connections.find(
    (connection) =>
      connection?.engineId === 'claude-code' ||
      connection?.config?.engineId === 'claude-code' ||
      connection?.id === 'claude',
  );
  assert(
    claude,
    'no Claude Code engine connection row exists at all — the runtime connection inventory is broken, which is a failure, not an absent CLI',
  );
  const ready = claude.status === 'ready' || claude.setup?.state === 'ready';
  return { connection: claude, ready };
}

function requireClaudeReady(state, journey) {
  if (state.ready) return;
  throw new NotExercised(
    `${journey} needs a ready Claude Code engine; this host reports status=${state.connection.status ?? 'unknown'} setup.state=${state.connection.setup?.state ?? 'unknown'} (claude CLI absent or not signed in)`,
  );
}

/**
 * The Agent bound to the detected Claude engine connection. A fresh home
 * with a ready `claude` CLI ADOPTS the engine into the agent registry at
 * boot ("Adopted detected native engine into the agent registry"), so the
 * ordinary path is to wait for that row — calling materialize-engine while
 * the boot adoption is still reconciling has been observed answering with
 * an unrelated refusal about the reserved 'station' agent (run 4 of this
 * suite's bring-up). materialize-engine remains the fallback for a home
 * where no adoption produced the row.
 */
async function resolveClaudeAgentSlug(page, state) {
  let slug;
  const findAdopted = async () => {
    const agents = envelopeData(await apiOk(page, 'GET', '/api/agents'));
    const adopted = (Array.isArray(agents) ? agents : []).find(
      (agent) =>
        agent?.execution?.agentConnectionId === state.connection.id ||
        agent?.slug === state.connection.id,
    );
    slug = adopted?.slug;
    return Boolean(slug);
  };
  const found = await poll(
    `the boot-adopted '${state.connection.id}' engine agent to appear`,
    60_000,
    findAdopted,
  ).then(
    () => true,
    () => false,
  );
  if (found) return slug;
  // Mounted un-prefixed (runtime-routes.ts routes createAgentRoutes at
  // '/agents'; '/api/agents' carries the enriched read + chat routes).
  const payload = await apiOk(page, 'POST', '/agents/materialize-engine', {
    engineId: state.connection.id,
  });
  const data = envelopeData(payload);
  assert(
    typeof data?.slug === 'string' && data.slug,
    `materialize-engine returned no agent slug: ${JSON.stringify(payload)?.slice(0, 300)}`,
  );
  return data.slug;
}

/**
 * Two — and only two — declared-transient refusals are retried, bounded;
 * every other failure surfaces immediately:
 *  - "Agent catalog is refreshing after a configuration change; retrying
 *    automatically." — a freshly-materialized engine agent until deferred
 *    activation reconciles (materialize-engine's `activationMode: 'defer'`);
 *  - `resource_posture_override_required` on a HEALTHY (non-forced) instance —
 *    the REAL host remains over the sustained critical threshold from sibling
 *    work. A scripted journey must not silently choose Start anyway, so it
 *    waits and retries without consuming the one-shot capability.
 *    The legacy critical-refusal code remains recognized for older peers, and
 *    tests/helpers/capacity-retry.ts encodes the same recovery; a journey
 *    about chat continuity must ride that recovery, not fail on the host's
 *    weather. (The capacity-gate journey sets retryCapacity:false and asserts
 *    the challenge itself on the forced instance, where it never clears.)
 *  - "This conversation is not writable under its current control state."
 *    right after a turn settles — the #749/#814 conversation-open model's
 *    revalidation window. The product's own composer defers its outbound
 *    drain and rechecks mutability before dispatch (438d52872, 36df2b477),
 *    and upstream's f833f3d51 pins that completed conversations REMAIN
 *    continuable — so a bounded retry mirrors the shipped client, while a
 *    window that never clears still reds the journey (that is a real
 *    regression of the core loop).
 * Every retried refusal is printed — the disclosure is part of the result.
 */
const CATALOG_REFRESHING_PATTERN = /Agent catalog is refreshing/;
const CONTROL_STATE_REVALIDATING_PATTERN =
  /not writable under its current control state/;

async function dispatchWithCatalogSettle(
  page,
  path,
  body,
  { retryCapacity = true } = {},
) {
  let last;
  let capacityRetries = 0;
  let controlRetries = 0;
  await poll(
    `${path} to clear its transient-refusal window`,
    180_000,
    async () => {
      last = await api(page, 'POST', path, body);
      if (
        last.status === 400 &&
        CATALOG_REFRESHING_PATTERN.test(last.payload?.error ?? '')
      ) {
        return false;
      }
      if (
        retryCapacity &&
        ((last.status === 409 &&
          last.payload?.code === 'resource_posture_override_required') ||
          (last.status === 400 &&
            last.payload?.code === 'resource_posture_critical'))
      ) {
        capacityRetries += 1;
        console.log(
          `  (host remains very busy — wait/retry ${capacityRetries} without consuming override: ${last.payload?.error})`,
        );
        return false;
      }
      if (
        last.status === 400 &&
        CONTROL_STATE_REVALIDATING_PATTERN.test(last.payload?.error ?? '')
      ) {
        controlRetries += 1;
        if (controlRetries === 1 || controlRetries % 10 === 0) {
          console.log(
            `  (conversation control state revalidating after the last turn — retry ${controlRetries}, mirroring the composer drain deferral)`,
          );
          await dumpSessionControlStates(page, 'control-state retry');
        }
        return false;
      }
      return true;
    },
  );
  return last;
}

/**
 * Session-control observability for red runs: the read-model row fields the
 * continuation eligibility gate reads (conversation-lineage.ts:43-52), so a
 * refusal names WHICH predicate is false instead of leaving a bare string.
 */
async function dumpSessionControlStates(page, label) {
  try {
    const sessions = envelopeData(
      await apiOk(page, 'GET', '/api/orchestration/sessions'),
    );
    for (const session of Array.isArray(sessions) ? sessions : []) {
      console.log(
        `  [${label}] session=${session.threadId} controlMode=${session.controlMode} lifecycleState=${session.lifecycleState} hasActiveTurn=${session.hasActiveTurn} pendingReview=${session.pendingReview} answerable=${session.answerability?.answerable} qualification=${session.answerability?.qualification ?? 'none'}`,
      );
    }
  } catch (error) {
    console.log(`  [${label}] session dump unreadable: ${error}`);
  }
}

async function startConversation(page, agentSlug, message, workspace) {
  const { status, payload } = await dispatchWithCatalogSettle(
    page,
    '/api/orchestration/chat',
    {
      target: {
        environment: { kind: 'current' },
        agent: agentSlug,
        ...(workspace ? { workspace } : {}),
      },
      message,
    },
  );
  assert(
    status < 400 && payload?.success !== false,
    `POST /api/orchestration/chat failed: HTTP ${status} ${JSON.stringify(payload)?.slice(0, 400)}`,
  );
  const data = envelopeData(payload);
  const conversationId = data?.conversationId;
  const sessionId = data?.sessionId;
  assert(
    typeof conversationId === 'string' && typeof sessionId === 'string',
    `foreground handle missing conversationId/sessionId: ${JSON.stringify(payload)?.slice(0, 400)}`,
  );
  return { conversationId, sessionId };
}

async function continueConversation(page, conversationId, message) {
  const { status, payload } = await dispatchWithCatalogSettle(
    page,
    `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
    { message },
  );
  assert(
    status < 400 && payload?.success !== false,
    `continue ${conversationId} failed: HTTP ${status} ${JSON.stringify(payload)?.slice(0, 400)}`,
  );
  const data = envelopeData(payload);
  return {
    conversationId: data?.conversationId ?? conversationId,
    sessionId: data?.sessionId,
  };
}

/**
 * The session-api reference's recommended read path for turn content:
 * `GET /api/orchestration/sessions/:threadId/messages`, the same shared
 * projection the native-SDK chat refresh uses.
 */
async function sessionMessages(page, threadId) {
  const payload = await apiOk(
    page,
    'GET',
    `/api/orchestration/sessions/${encodeURIComponent(threadId)}/messages`,
  );
  const messages = envelopeData(payload);
  assert(
    Array.isArray(messages),
    `session messages did not return an array: ${JSON.stringify(payload)?.slice(0, 300)}`,
  );
  return messages;
}

function messageText(message) {
  return (message.parts ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * Wait until the session's projected transcript holds at least `count`
 * NON-EMPTY assistant messages. Fails IMMEDIATELY — not at the timeout —
 * when the raw #765 A1 error text shows up in the transcript: that string
 * rendering at all is the exact defect journey 1 exists to catch. On
 * timeout, dumps the last few persisted event methods so a red run says
 * whether the turn never started, is still streaming, or completed into a
 * projection this suite is misreading.
 */
async function awaitAssistantReplies(page, threadId, count) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let lastSummary = 'no observation yet';
  while (Date.now() < deadline) {
    const messages = await sessionMessages(page, threadId);
    for (const message of messages) {
      const text = messageText(message);
      if (SESSION_NOT_FOUND_PATTERN.test(text)) {
        throw new Error(
          `transcript rendered the raw session error (#765 A1): ${text.slice(0, 300)}`,
        );
      }
    }
    const assistants = messages.filter(
      (message) =>
        message.role === 'assistant' && messageText(message).trim().length > 0,
    );
    lastSummary = `${messages.length} message(s), ${assistants.length} non-empty assistant`;
    if (assistants.length >= count) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  // Timed out — say what the event store actually holds for this session.
  let eventTail = 'events unreadable';
  try {
    const events = envelopeData(
      await apiOk(
        page,
        'GET',
        `/api/orchestration/sessions/${encodeURIComponent(threadId)}/events`,
      ),
    );
    eventTail = `${events.length} persisted event(s); tail methods: ${events
      .slice(-8)
      .map((event) => event.method ?? event.type ?? '?')
      .join(', ')}`;
  } catch (error) {
    eventTail = `events unreadable: ${error}`;
  }
  throw new Error(
    `Timed out after ${TURN_TIMEOUT_MS}ms waiting for ${count} assistant repl${count === 1 ? 'y' : 'ies'} in ${threadId}. Last transcript observation: ${lastSummary}. ${eventTail}`,
  );
}

// ---------------------------------------------------------------------------
// Journey 1: multi-turn continuity (Claude Code, #765 A1/A2, PR #796)
// ---------------------------------------------------------------------------

async function journeyMultiTurnContinuity(page, note, shared) {
  const state = await claudeEngineState(page);
  requireClaudeReady(state, 'multi-turn continuity');
  const agentSlug = await resolveClaudeAgentSlug(page, state);
  note(`materialized engine agent '${agentSlug}'`);

  const turn1 = await startConversation(
    page,
    agentSlug,
    'Reply with the single word ACK and nothing else.',
  );
  note(
    `turn 1 accepted: conversation=${turn1.conversationId} session=${turn1.sessionId}`,
  );
  // Per-session assistant-reply expectations: consecutive turns riding one
  // engine session accumulate in that session's transcript; a turn that
  // lands a child session starts a fresh count there.
  const expectedBySession = new Map([[turn1.sessionId, 1]]);
  await awaitAssistantReplies(page, turn1.sessionId, 1);
  note('turn 1 answered');
  // Published for journey 2's chat-surface assert as soon as a transcript
  // exists — the later continuity asserts refine THIS journey's verdict but
  // must not withhold a perfectly usable conversation from journey 2.
  shared.conversation = {
    id: turn1.conversationId,
    sessionId: turn1.sessionId,
    agentSlug,
  };

  const turn2 = await continueConversation(
    page,
    turn1.conversationId,
    'Reply with the single word ACK again.',
  );
  assert(
    turn2.conversationId === turn1.conversationId,
    `turn 2 landed in a different conversation: ${turn2.conversationId} != ${turn1.conversationId}`,
  );
  const turn2Session = turn2.sessionId ?? turn1.sessionId;
  expectedBySession.set(
    turn2Session,
    (expectedBySession.get(turn2Session) ?? 0) + 1,
  );
  await awaitAssistantReplies(
    page,
    turn2Session,
    expectedBySession.get(turn2Session),
  );
  note('turn 2 answered in the same conversation');

  // Deterministically exercise the #765 A1 continuation path: stop the live
  // session so turn 3 must reserve a child session and resume from the
  // stopped predecessor's cursor — the resume that only works when the
  // engine transcript behind the cursor was actually persisted (PR #796).
  const sessions = envelopeData(
    await apiOk(page, 'GET', '/api/orchestration/sessions'),
  );
  const liveThreadIds = (Array.isArray(sessions) ? sessions : [])
    .map((session) => session.threadId)
    .filter(Boolean);
  assert(
    liveThreadIds.length > 0,
    'no orchestration sessions listed after two answered turns',
  );
  const currentThreadId = turn2.sessionId ?? turn1.sessionId;
  const stop = await api(page, 'POST', '/api/orchestration/commands', {
    type: 'stopSession',
    threadId: currentThreadId,
  });
  assert(
    stop.status < 400,
    `stopSession ${currentThreadId} failed: HTTP ${stop.status} ${JSON.stringify(stop.payload)?.slice(0, 300)}`,
  );
  note(`stopped session ${currentThreadId} before turn 3`);

  // #749/#814 conversation-open model: continuing a conversation whose
  // current child was STOPPED first requires the authoritative open resolve
  // (GET /api/conversations/:id/open) — the same call the product's picker
  // and reload paths make before binding a current child; it owns the
  // recovery that makes a stopped conversation continuable again. Poll it
  // to canContinue, bounded: a stopped conversation that never becomes
  // continuable again is the A1-class dead end this journey nets.
  let openState;
  await poll(
    `conversation ${turn1.conversationId} to reopen as continuable after the stop`,
    60_000,
    async () => {
      const { status, payload } = await api(
        page,
        'GET',
        `/api/conversations/${encodeURIComponent(turn1.conversationId)}/open`,
      );
      assert(
        status === 200,
        `GET /api/conversations/:id/open answered HTTP ${status}: ${JSON.stringify(payload)?.slice(0, 300)}`,
      );
      openState = envelopeData(payload);
      return openState?.canContinue === true;
    },
  ).catch((error) => {
    throw new Error(
      `stopped conversation never resolved continuable via the authoritative open (last: ${JSON.stringify(openState)?.slice(0, 300)}): ${error}`,
    );
  });
  note('authoritative open resolved the stopped conversation as continuable');

  const turn3 = await continueConversation(
    page,
    turn1.conversationId,
    'Reply with the single word ACK a third time.',
  );
  assert(
    turn3.conversationId === turn1.conversationId,
    `turn 3 landed in a different conversation: ${turn3.conversationId} != ${turn1.conversationId}`,
  );
  const turn3Session = turn3.sessionId ?? turn2Session;
  expectedBySession.set(
    turn3Session,
    (expectedBySession.get(turn3Session) ?? 0) + 1,
  );
  await awaitAssistantReplies(
    page,
    turn3Session,
    expectedBySession.get(turn3Session),
  );
  note('turn 3 answered after stop/resume — cursor-backed continuation held');

  // Continuity + no-fragmentation asserts (#765 A2): exactly one
  // conversation exists on this fresh home, the sessions the three turns
  // rode carry exactly three user turns between them, and no
  // session-not-found text appears anywhere.
  let userTurnCount = 0;
  for (const [threadId] of expectedBySession) {
    const messages = await sessionMessages(page, threadId);
    for (const message of messages) {
      const text = messageText(message);
      assert(
        !SESSION_NOT_FOUND_PATTERN.test(text),
        `transcript for ${threadId} rendered the raw session error (#765 A1): ${text.slice(0, 300)}`,
      );
      if (message.role === 'user') userTurnCount += 1;
    }
  }
  assert(
    userTurnCount === 3,
    `expected exactly 3 user turns across the conversation's sessions, found ${userTurnCount}`,
  );
  // The conversation inventory legitimately lists 0 rows for a live
  // orchestration conversation on a fresh home (observed run 5 — the
  // history readers project other legs), so "exactly one" is not a valid
  // oracle here. What IS a valid stray-detector: any inventory row whose id
  // is NOT this conversation would be a fragment (#765 A2's "own session"
  // rows surfaced exactly there in the audit).
  const inventory = envelopeData(
    await apiOk(page, 'GET', '/api/conversations'),
  );
  const strays = (inventory?.items ?? []).filter(
    (item) => item.id !== turn1.conversationId,
  );
  assert(
    strays.length === 0,
    `conversation inventory lists ${strays.length} stray item(s) beside ${turn1.conversationId}: ${strays.map((item) => item.id).join(', ')} — fragmented turns create stray conversations/drafts (#765 A2)`,
  );
  const finalSessions = envelopeData(
    await apiOk(page, 'GET', '/api/orchestration/sessions'),
  );
  const sessionIds = (Array.isArray(finalSessions) ? finalSessions : []).map(
    (session) => session.threadId,
  );
  // Turn 1+2 share one session; the post-stop turn 3 adds one child. A small
  // slack of one covers a provider-owned auxiliary session; MORE than that
  // is the fragmentation defect.
  assert(
    sessionIds.length <= 3,
    `expected at most 3 orchestration sessions after 3 turns, found ${sessionIds.length}: ${sessionIds.join(', ')}`,
  );
  note(
    `continuity held: 1 conversation, ${userTurnCount} user turns, ${sessionIds.length} session(s)`,
  );
  shared.conversation = {
    id: turn1.conversationId,
    sessionId: turn1.sessionId,
    agentSlug,
  };
}

// ---------------------------------------------------------------------------
// Journey 2: capacity-gate surfacing (#765 A3)
// ---------------------------------------------------------------------------

function capacityInstanceName() {
  const token = () => Math.random().toString(36).slice(2, 8);
  // Must match the attested namespace in resource-posture.ts
  // (CORE_LOOP_CAPACITY_INSTANCE).
  return `e2e-core-loop-capacity-${token()}-${token()}`;
}

async function journeyCapacityGate(browser, note, shared) {
  const instance = capacityInstanceName();
  note(
    `booting capacity instance ${instance} with STATION_E2E_RESOURCE_POSTURE_CRITICAL=1`,
  );
  const capacity = await startTempHomeInstance({
    root: ROOT,
    instance,
    serverPort: CAPACITY_SERVER_PORT,
    uiPort: CAPACITY_UI_PORT,
    logPath: join(OUTPUT_ROOT, 'capacity-instance.log'),
    env: {
      ...process.env,
      STATION_E2E_RESOURCE_POSTURE_CRITICAL: '1',
    },
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await context.newPage();
    await pairBrowser(page, {
      root: ROOT,
      instance,
      serverPort: CAPACITY_SERVER_PORT,
      uiOrigin: capacity.uiOrigin,
    });

    // The seam must be observably live, and observably THE SEAM: the same
    // derivation admission uses, reporting the forced sample's source. A
    // coincidentally-loaded host cannot fake this (its source differs), and
    // a silently unauthorized override cannot pass it (kind won't be
    // critical on a healthy runner).
    // #837 hysteresis: critical entry is sustained (3 consecutive smoothed
    // samples, one per 2s cache window), so poll the endpoint through the
    // entry window instead of asserting the first read. The SOURCE check on
    // every read still proves the seam took (a coincidentally-loaded host
    // reports a different source even while degraded/critical).
    let posture;
    const postureDeadline = Date.now() + 30_000;
    for (;;) {
      posture = envelopeData(
        await apiOk(page, 'GET', '/api/system/resource-posture'),
      );
      assert(
        posture?.source === 'core-loop-capacity-e2e' &&
          posture?.busyPercent === 97,
        `forced posture not observed: ${JSON.stringify(posture)} — the STATION_E2E_RESOURCE_POSTURE_CRITICAL seam did not take`,
      );
      if (posture?.kind === 'critical') break;
      assert(
        Date.now() < postureDeadline,
        `forced posture never reached critical within the sustained-entry window: ${JSON.stringify(posture)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    note(
      'posture endpoint reports the forced critical observation (source core-loop-capacity-e2e)',
    );

    // Real interactive admission needs an engine ready enough to pass
    // assertAdapterReady (which runs BEFORE admitEngineStart).
    const state = await claudeEngineState(page);
    if (state.ready) {
      const agentSlug = await resolveClaudeAgentSlug(page, state);
      // retryCapacity OFF: on this instance the challenge IS the expectation
      // (the forced posture never clears), so riding the recovery loop here
      // would time out around the very evidence being asserted.
      const { status, payload } = await dispatchWithCatalogSettle(
        page,
        '/api/orchestration/chat',
        {
          target: { environment: { kind: 'current' }, agent: agentSlug },
          message: 'capacity probe — this dispatch must require confirmation',
        },
        { retryCapacity: false },
      );
      assert(
        status === 409,
        `interactive dispatch under critical posture returned HTTP ${status}, expected 409: ${JSON.stringify(payload)?.slice(0, 400)}`,
      );
      assert(
        payload?.code === 'resource_posture_override_required',
        `challenge carried code ${payload?.code ?? 'none'}, expected resource_posture_override_required: ${JSON.stringify(payload)?.slice(0, 400)}`,
      );
      assert(
        typeof payload?.resourceAdmissionOverride?.token === 'string' &&
          payload.resourceAdmissionOverride.token.length > 0 &&
          Number.isFinite(payload.resourceAdmissionOverride.expiresAt),
        `challenge did not carry a bounded override capability: ${JSON.stringify(payload)?.slice(0, 400)}`,
      );
      note(
        'real interactive dispatch returned a typed one-shot resource_posture_override_required challenge',
      );

      const background = await dispatchWithCatalogSettle(
        page,
        '/api/orchestration/chat/background',
        {
          target: { environment: { kind: 'current' }, agent: agentSlug },
          message: 'capacity probe — automatic work must defer',
        },
        { retryCapacity: false },
      );
      assert(
        background.status === 400 &&
          background.payload?.code === 'resource_posture_deferred',
        `background dispatch did not defer before provider effect: HTTP ${background.status} ${JSON.stringify(background.payload)?.slice(0, 400)}`,
      );
      note('real background dispatch deferred with resource_posture_deferred');
    } else {
      note(
        'real interactive/background dispatch admission NOT exercised on this host (Claude engine not ready; the posture gate sits behind assertAdapterReady) — covered by the posture assert above plus the surface assert below',
      );
      if (REQUIRE_CLAUDE) {
        throw new Error(
          'CORE_LOOP_REQUIRE_CLAUDE=1 but the Claude engine is not ready for the capacity-gate dispatch assertions',
        );
      }
    }
  } finally {
    await context.close();
    await capacity.stop();
  }

  // Surface half (#798): the challenge must reach the CONVERSATION UI as
  // the "Host remains busy" ephemeral with a Start anyway action, and the
  // retry must carry the exact one-shot token. Replayed via route interception on the MAIN
  // healthy instance because a real refusal requires a ready engine (see
  // module docblock); the injected body is byte-shaped after
  // orchestration.routes.test.ts "preserves a critical resource refusal
  // code at the outer HTTP seam".
  // Its OWN one-turn conversation, never stopped: journey 1 deliberately
  // ends its conversation in the stopped-then-continued state
  // (kontourai/station#834's recovered population) — borrowing that
  // conversation would entangle this surface assert with journey 1's
  // post-stop lineage instead of a plain writable composer. Driven
  // from a FRESHLY paired page: the run-long first page's device session
  // has been observed aging into 401/429 refusals by this point (journey 4
  // learned the same lesson).
  const context2 = await shared.newMainContext();
  try {
    const apiPage = await context2.newPage();
    await pairBrowser(apiPage, {
      root: ROOT,
      instance: INSTANCE,
      serverPort: SERVER_PORT,
      uiOrigin: UI_ORIGIN,
    });
    const mainState = await claudeEngineState(apiPage);
    if (!mainState.ready) {
      throw new NotExercised(
        'chat-surface refusal assert needs one answered Claude turn to open in the dock, and the Claude engine is not ready on this host',
      );
    }
    const surfaceAgent = await resolveClaudeAgentSlug(apiPage, mainState);
    const surfaceTurn = await startConversation(
      apiPage,
      surfaceAgent,
      'Reply with the single word ACK and nothing else.',
    );
    await awaitAssistantReplies(apiPage, surfaceTurn.sessionId, 1);
    note(`surface conversation ${surfaceTurn.conversationId} answered`);
    const conversationId = surfaceTurn.conversationId;
    const sessionId = surfaceTurn.sessionId;
    const agentSlug = surfaceAgent;
    const page = await context2.newPage();
    // Same restore basis as journey 3: the state a user with this chat open
    // in the dock actually has (the product's own sessionStorage shape).
    await page.addInitScript(
      (chat) => {
        sessionStorage.setItem(
          'activeChats',
          JSON.stringify([
            {
              sessionId: chat.sessionId,
              conversationId: chat.conversationId,
              agentSlug: chat.agentSlug,
              title: 'Core loop chat',
              executionMode: 'external',
              provider: 'claude',
              providerOptions: {},
              orchestrationSessionStarted: true,
              ephemeralMessages: [],
              inputHistory: [],
            },
          ]),
        );
      },
      { conversationId, sessionId, agentSlug },
    );
    // Same context as apiPage — the device-session cookie is already there;
    // a second mint/exchange would only spend the auth limiter's budget.
    // Intercept BOTH canonical execution spellings (start and continue) —
    // the composer may dispatch either depending on the restored chat's
    // binding — and record what it actually posted so a red run names the
    // route instead of guessing.
    const interceptedDispatches = [];
    const overrideToken = 'core-loop-capacity-override';
    let overrideRequest;
    await page.route(
      (url) => url.pathname.startsWith('/api/orchestration/chat'),
      (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        interceptedDispatches.push(new URL(route.request().url()).pathname);
        const body = route.request().postDataJSON();
        if (interceptedDispatches.length > 1) {
          overrideRequest = body;
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: {
                conversationId,
                sessionId,
                providerTurnId: 'core-loop-capacity-override-turn',
                target: { kind: 'agent', id: agentSlug },
                resolution: {
                  environment: { kind: 'current' },
                  agentId: agentSlug,
                  provider: 'claude',
                },
              },
            }),
          });
        }
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error:
              'This Station remains very busy (97% averaged CPU). Start anyway?',
            code: 'resource_posture_override_required',
            retryable: true,
            resourceAdmissionOverride: {
              token: overrideToken,
              expiresAt: Date.now() + 30_000,
            },
          }),
        });
      },
    );
    await page.goto(
      `${UI_ORIGIN}/?chat=${encodeURIComponent(conversationId)}&dock=open`,
      {
        waitUntil: 'load',
      },
    );
    const settleFailure = await settlePageReason(page, SETTLE_TIMEOUT_MS);
    assert(!settleFailure, `chat deep link did not settle: ${settleFailure}`);
    const composer = page.locator('textarea[placeholder^="Type a message"]');
    await composer
      .first()
      .waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT_MS })
      .catch(async () => {
        const shot = join(OUTPUT_ROOT, 'journey2-no-composer.png');
        await page.screenshot({ path: shot }).catch(() => undefined);
        throw new Error(
          `capacity surface: no composer became visible on the chat deep link — screenshot at ${shot}`,
        );
      });
    // fill() waits for editability — the #749/#814 conversation-open model
    // keeps the restored composer disabled until the conversation
    // revalidates, so give that window a full settle budget and name it on
    // failure instead of a bare actionability timeout.
    await composer
      .first()
      .fill('capacity surface probe', { timeout: 60_000 })
      .catch(async () => {
        const shot = join(OUTPUT_ROOT, 'journey2-composer-disabled.png');
        await page.screenshot({ path: shot }).catch(() => undefined);
        throw new Error(
          `capacity surface: the composer never became editable (conversation still not writable after 60s?) — screenshot at ${shot}`,
        );
      });
    await composer.first().press('Enter');

    const capacityNotice = page
      .locator('.ephemeral-message')
      .filter({ hasText: 'Host remains busy' })
      .last();
    await capacityNotice
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(async () => {
        const shot = join(OUTPUT_ROOT, 'journey2-no-refusal.png');
        await page.screenshot({ path: shot }).catch(() => undefined);
        throw new Error(
          `capacity surface: the "Host remains busy" challenge never rendered. Intercepted ${interceptedDispatches.length} dispatch(es): ${interceptedDispatches.join(', ') || 'NONE — the composer posted somewhere this interception does not cover'} — screenshot at ${shot}`,
        );
      });
    const startAnyway = capacityNotice.getByRole('button', {
      name: 'Start anyway',
      exact: true,
    });
    assert(
      (await startAnyway.count()) > 0,
      'capacity challenge rendered without its Start anyway action',
    );
    // The challenge replaced the first attempt's streaming state: no
    // "Working…" label may survive it (the eternal-spinner defect).
    await poll(
      'Working… indicator to clear after the challenge',
      15_000,
      async () => {
        const working = await page
          .locator('.streaming-activity__label', { hasText: /^Working/ })
          .count();
        return working === 0;
      },
    );
    await startAnyway.click();
    await poll(
      'Start anyway retry to carry its exact token',
      15_000,
      async () =>
        overrideRequest?.resourceAdmissionOverrideToken === overrideToken,
    );
    note(
      'chat surface rendered "Host remains busy" with Start anyway, cleared the challenged attempt, and carried the exact token',
    );
  } finally {
    await context2.close();
  }
}

// ---------------------------------------------------------------------------
// Journey 3: project deep-link reload (#765 A5)
// ---------------------------------------------------------------------------

async function journeyProjectDeepLinkReload(note, shared) {
  const state = await claudeEngineState(shared.mainPage);
  requireClaudeReady(state, 'project deep-link reload');
  const agentSlug = await resolveClaudeAgentSlug(shared.mainPage, state);
  const projectSlug = 'core-loop-journey';
  // A project-bound dispatch requires a configured working directory
  // ("Project '<slug>' has no working directory configured" otherwise).
  const projectDir = mkdtempSync(join(tmpdir(), 'core-loop-project-'));
  shared.projectDir = projectDir;
  await apiOk(shared.mainPage, 'POST', '/api/projects', {
    name: 'Core Loop Journey',
    slug: projectSlug,
    workingDirectory: projectDir,
  });
  note(`created project ${projectSlug} (workdir ${projectDir})`);

  const turn = await startConversation(
    shared.mainPage,
    agentSlug,
    'Reply with the single word ACK and nothing else.',
    { kind: 'project', projectSlug },
  );
  await awaitAssistantReplies(shared.mainPage, turn.sessionId, 1);
  note(`project conversation ${turn.conversationId} answered`);

  const context = await shared.newMainContext();
  try {
    const page = await context.newPage();
    // The state a user reloading FROM actually has: the chat open in the
    // dock, persisted by the app itself into sessionStorage's `activeChats`
    // (the same shape tests/helpers/daily-driver-shell.ts seeds and the
    // product restores on load). A bare URL pointer with no client state is
    // a different journey — the dock prunes restored chats the conversation
    // inventory cannot vouch for, which on a fresh home includes this one.
    await page.addInitScript(
      ({ conversationId, sessionId, agentSlug }) => {
        sessionStorage.setItem(
          'activeChats',
          JSON.stringify([
            {
              sessionId,
              conversationId,
              agentSlug,
              title: 'Core Loop Journey chat',
              executionMode: 'external',
              provider: 'claude',
              providerOptions: {},
              orchestrationSessionStarted: true,
              ephemeralMessages: [],
              inputHistory: [],
            },
          ]),
        );
      },
      {
        conversationId: turn.conversationId,
        sessionId: turn.sessionId,
        agentSlug,
      },
    );
    await pairBrowser(page, {
      root: ROOT,
      instance: INSTANCE,
      serverPort: SERVER_PORT,
      uiOrigin: UI_ORIGIN,
    });
    const deepLink = `${UI_ORIGIN}/projects/${encodeURIComponent(projectSlug)}?chat=${encodeURIComponent(turn.conversationId)}&dock=open`;
    const assertConversationVisible = async (phase) => {
      const settleFailure = await settlePageReason(page, SETTLE_TIMEOUT_MS);
      assert(!settleFailure, `${phase}: did not settle: ${settleFailure}`);
      const path = new URL(page.url()).pathname;
      assert(
        !path.startsWith('/activity'),
        `${phase}: decayed into the Activity inspector (${page.url()}) — #765 A5`,
      );
      assert(
        (await page.getByText('Page not found').count()) === 0,
        `${phase}: renders "Page not found"`,
      );
      // The conversation, not an events inspector: the transcript container
      // is visible and the composer is present to continue the conversation.
      await page
        .locator('.chat-messages')
        .first()
        .waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT_MS })
        .catch(async () => {
          const shot = join(
            OUTPUT_ROOT,
            `journey3-${phase.replaceAll(' ', '-')}.png`,
          );
          await page.screenshot({ path: shot }).catch(() => undefined);
          throw new Error(
            `${phase}: no chat transcript (.chat-messages) became visible — screenshot at ${shot}`,
          );
        });
      const composer = page.locator('textarea[placeholder^="Type a message"]');
      assert(
        (await composer.count()) > 0,
        `${phase}: transcript visible but no composer — an inspector, not the conversation`,
      );
    };
    await page.goto(deepLink, { waitUntil: 'load' });
    await assertConversationVisible('deep link');
    note('deep link opened the conversation with transcript and composer');
    await page.reload({ waitUntil: 'load' });
    await assertConversationVisible('reload');
    note('reload landed back in the conversation, not the Activity inspector');
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Journey 4: pairing/delegation loop (#765 D4/D5 pending-request surfacing)
// ---------------------------------------------------------------------------

function runCli(args, { home, timeoutMs = 60_000 }) {
  const result = spawnSync('./station', args, {
    cwd: ROOT,
    env: { ...process.env, STATION_HOME: home },
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

async function journeyPairingLoop(note, shared) {
  const apiBase = `http://127.0.0.1:${SERVER_PORT}`;
  const requesterHome = mkdtempSync(join(tmpdir(), 'core-loop-station-b-'));
  note(`second temp-home Station at ${requesterHome}`);

  // A freshly paired observer for this journey's host-side reads: the
  // long-lived first page's device session has been observed answering 401
  // by the time this journey runs (run 6), which is session aging — not the
  // pairing surface under test — so the observation rides its own pairing.
  const observerContext = await shared.newMainContext();
  const observer = await observerContext.newPage();
  await pairBrowser(observer, {
    root: ROOT,
    instance: INSTANCE,
    serverPort: SERVER_PORT,
    uiOrigin: UI_ORIGIN,
  });

  // The requester CLI blocks until the host approves (or its timeout), so it
  // runs detached from this journey's control flow while the host-side
  // asserts and the approval happen.
  const requester = spawn(
    './station',
    [
      'environment',
      'access',
      'request',
      `--api-base=${apiBase}`,
      '--device-name=core-loop-journey-b',
      '--timeout=180',
      '--force',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, STATION_HOME: requesterHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let requesterOutput = '';
  requester.stdout.on('data', (chunk) => {
    requesterOutput += String(chunk);
  });
  requester.stderr.on('data', (chunk) => {
    requesterOutput += String(chunk);
  });
  const requesterExit = new Promise((resolvePromise) => {
    requester.on('close', (code) => resolvePromise(code));
  });

  try {
    // The CLI prints "Request id: <id>" the moment the host accepted the
    // pending request.
    let requestId;
    await poll('the access request id to be printed', 60_000, () => {
      const match = /Request id: (\S+)/.exec(requesterOutput);
      if (match) requestId = match[1];
      return Boolean(requestId);
    });
    note(`access request pending on the host: ${requestId}`);

    // Host-side surfacing (#765 D5): the pending request must reach the
    // operator as a pairing-request notification — the pointer the
    // Needs-attention surface derives from. The notification provider polls
    // every 60s, so this waits past one full cycle.
    // Mounted un-prefixed (runtime-routes.ts routes createNotificationRoutes
    // at '/notifications'). Probe the route ONCE before polling so a
    // route-level failure (404/500) fails fast with its status instead of
    // being retried into an uninformative timeout — poll() swallows probe
    // throws by design. 429 is the route's own rate limiter answering a
    // busy suite (observed run 5), not absence: it stays on the retry path.
    const routeProbe = await api(observer, 'GET', '/notifications');
    assert(
      routeProbe.status === 200 || routeProbe.status === 429,
      `GET /notifications answered HTTP ${routeProbe.status} — cannot observe pairing notifications at all`,
    );
    const notified = await poll(
      'the pairing-request notification to surface',
      90_000,
      async () => {
        const { status, payload } = await api(
          observer,
          'GET',
          '/notifications',
        );
        if (status !== 200) return false;
        const notifications = envelopeData(payload);
        const list = Array.isArray(notifications) ? notifications : [];
        return list.some(
          (notification) =>
            notification?.source === 'device-pairing' ||
            notification?.category === 'pairing-request' ||
            /pair/i.test(notification?.title ?? ''),
        );
      },
    ).then(
      () => true,
      (error) => {
        throw new Error(
          `pending pairing request never surfaced as a notification (#765 D5): ${error}`,
        );
      },
    );
    if (notified)
      note('pending request surfaced as a pairing-request notification');

    // Needs-attention projection over the same fact.
    const attention = envelopeData(
      await apiOk(observer, 'GET', '/api/attention'),
    );
    const attentionItems = attention?.items ?? [];
    const attentionHasPairing = attentionItems.some((item) =>
      /pair/i.test(JSON.stringify(item)),
    );
    assert(
      attentionHasPairing,
      `pending pairing request is not a Needs-attention item (#765 D5); attention lists ${attentionItems.length} item(s): ${JSON.stringify(attentionItems).slice(0, 400)}`,
    );
    note('pending request present in the Needs-attention projection');

    // Approve on the host via the CLI, from the host instance's own home.
    const hostHome = shared.mainHome;
    const approve = runCli(
      [
        'environment',
        'access',
        'approve',
        requestId,
        '--force',
        `--api-base=${apiBase}`,
      ],
      { home: hostHome },
    );
    assert(
      approve.status === 0,
      `access approve exited ${approve.status}: ${approve.output.slice(-800)}`,
    );
    note('host approved the request via the CLI');

    // Confirmation evidence, strongest first: the requester's own pairing
    // exchange only succeeds against an APPROVED request, so its completion
    // is direct proof of confirmation. The host-side `access list` is read
    // as corroboration — but a confirmed request is CONSUMED once the
    // exchange completes (run 4 of this suite's bring-up read `requests: []`
    // moments after a successful approve), so the list assert accepts
    // confirmed-or-consumed and refuses pending/denied.
    const exitCode = await Promise.race([
      requesterExit,
      new Promise((resolvePromise) =>
        setTimeout(() => resolvePromise('timeout'), 60_000),
      ),
    ]);
    const list = runCli(
      ['environment', 'access', 'list', `--api-base=${apiBase}`],
      { home: hostHome },
    );
    assert(
      list.status === 0,
      `access list exited ${list.status}: ${list.output.slice(-800)}`,
    );
    // The CLI pretty-prints its JSON payload (possibly after other output
    // lines) — parse from the first opening brace, not a single line.
    const jsonStart = list.output.indexOf('{');
    assert(
      jsonStart >= 0,
      `access list printed no JSON payload: ${list.output.slice(-400)}`,
    );
    const parsed = JSON.parse(list.output.slice(jsonStart));
    const listed = (parsed.requests ?? []).find(
      (request) => request.requestId === requestId,
    );
    assert(
      listed === undefined || listed.status === 'confirmed',
      `request ${requestId} reads '${listed?.status}' after approval: ${JSON.stringify(parsed).slice(0, 400)}`,
    );
    note(
      listed
        ? `request ${requestId} reads confirmed on the host`
        : `request ${requestId} was consumed by the completed exchange (no longer listed)`,
    );

    // The requester's own completion: pairing exchange + credential persist.
    // On hosts without an OS keyring (headless CI) the CLI fails at the
    // final persist with its explicit refusal — approve → exchange is
    // already proven above, so that specific tail is a disclosure, not a
    // pass.
    if (exitCode === 0) {
      assert(
        /Paired with|Saved as Station/i.test(requesterOutput),
        `requester exited 0 without reporting a paired Station:\n${requesterOutput.slice(-800)}`,
      );
      note('requester completed pairing and saved the Station');
      // The bearer credential lands in the OS keyring, which outlives the
      // throwaway home — forget the saved Station so repeated runs do not
      // accrete keyring entries. Best-effort: a failed forget is reported,
      // not fatal (the pairing loop under test already completed).
      const savedName = /Saved as Station "([^"]+)"/.exec(requesterOutput)?.[1];
      if (savedName) {
        const forget = runCli(['stations', 'forget', savedName], {
          home: requesterHome,
        });
        note(
          forget.status === 0
            ? `cleanup: forgot saved Station "${savedName}" (keyring entry released)`
            : `cleanup WARNING: stations forget "${savedName}" exited ${forget.status}: ${forget.output.slice(-200)}`,
        );
      } else {
        note(
          'cleanup WARNING: could not parse the saved Station name; its keyring entry remains',
        );
      }
    } else if (/credential store is unavailable/i.test(requesterOutput)) {
      note(
        `NOT-EXERCISED tail: requester exchanged pairing but could not persist the credential (no OS keyring on this host): exit=${exitCode}`,
      );
    } else {
      throw new Error(
        `requester CLI did not complete pairing (exit=${exitCode}):\n${requesterOutput.slice(-1200)}`,
      );
    }
  } finally {
    if (requester.exitCode === null) requester.kill('SIGTERM');
    rmSync(requesterHome, { recursive: true, force: true });
    await observerContext.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(OUTPUT_ROOT, { recursive: true });
console.log(
  `core-loop journeys: instance=${INSTANCE} ports=${SERVER_PORT}/${UI_PORT} (capacity ${CAPACITY_SERVER_PORT}/${CAPACITY_UI_PORT})`,
);

console.log('starting main instance (builds on first run)...');
const main = await startTempHomeInstance({
  root: ROOT,
  instance: INSTANCE,
  serverPort: SERVER_PORT,
  uiPort: UI_PORT,
  logPath: join(OUTPUT_ROOT, 'station.log'),
});

let browser;
/** Cross-journey handles, visible to teardown for temp-dir cleanup. */
let sharedTeardown = {};
try {
  browser = await chromium.launch({ headless: true });
  const mainContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const mainPage = await mainContext.newPage();
  await pairBrowser(mainPage, {
    root: ROOT,
    instance: INSTANCE,
    serverPort: SERVER_PORT,
    uiOrigin: UI_ORIGIN,
  });

  /** Cross-journey handles: the paired API page and journey-1's conversation. */
  const shared = {
    mainPage,
    mainHome: main.home,
    conversation: null,
    newMainContext: () =>
      browser.newContext({ viewport: { width: 1440, height: 900 } }),
  };
  sharedTeardown = shared;

  await runJourney(
    '1-multi-turn-continuity',
    'three turns, one conversation (#765 A1/A2)',
    (note) => journeyMultiTurnContinuity(mainPage, note, shared),
  );
  await runJourney(
    '3-project-deep-link-reload',
    'project chat deep link survives reload (#765 A5)',
    (note) => journeyProjectDeepLinkReload(note, shared),
  );
  await runJourney(
    '2-capacity-gate',
    'capacity refusal reaches the chat surface (#765 A3)',
    (note) => journeyCapacityGate(browser, note, shared),
  );
  await runJourney(
    '4-pairing-delegation-loop',
    'second Station pairs via offer/request/approve (#765 D4/D5)',
    (note) => journeyPairingLoop(note, shared),
  );
} finally {
  await browser?.close();
  await main.stop();
  if (sharedTeardown.projectDir) {
    rmSync(sharedTeardown.projectDir, { recursive: true, force: true });
  }
  // The capacity instance stops inside journey 2; a crashed journey may
  // leave it running — stop it best-effort by name pattern is impossible
  // (random name), so its own finally owns that.
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

writeFileSync(
  join(OUTPUT_ROOT, 'summary.json'),
  `${JSON.stringify({ results }, null, 2)}\n`,
);

console.log('\ncore-loop journey results:');
for (const result of results) {
  console.log(`  ${result.status.toUpperCase().padEnd(14)} ${result.id}`);
}
const failed = results.filter((result) => result.status === 'failed');
const passed = results.filter((result) => result.status === 'passed');
const skipped = results.filter((result) => result.status === 'skipped');
const expectedFails = results.filter(
  (result) => result.status === 'expected-fail',
);
const notExercised = results.filter(
  (result) => result.status === 'not-exercised',
);
if (expectedFails.length > 0) {
  console.error(
    `\n${expectedFails.length} journey(s) EXPECTED-FAIL (tracked issues; the run FAILS when one starts passing):`,
  );
  for (const result of expectedFails) {
    console.error(`  ${result.id}: ${result.notes.at(-1)}`);
  }
}
if (notExercised.length > 0) {
  console.error(
    `\n${notExercised.length} journey(s) NOT-EXERCISED on this host — see summary.json; these are disclosures, not passes:`,
  );
  for (const result of notExercised) {
    console.error(`  ${result.id}: ${result.notes.at(-1)}`);
  }
}
if (failed.length > 0) {
  console.error(`\ncore-loop journeys FAILED (${failed.length}):`);
  for (const result of failed) {
    console.error(`  ${result.id}: ${result.notes.at(-1)}`);
  }
  process.exit(1);
}
console.log(
  `\ncore-loop journeys passed — ${passed.length} passed, ${expectedFails.length} expected-fail, ${notExercised.length} disclosed, ${skipped.length} filter-skipped, summary at ${join(OUTPUT_ROOT, 'summary.json')}`,
);
