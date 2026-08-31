import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { createDailyDriverScenarioObservation } from '../scripts/lib/daily-driver-scenario-observation.mjs';
import {
  buildLongSessionTurns,
  createLongSessionEventWindowHandler,
  LONG_SESSION_TURN_COUNT,
} from './fixtures/long-session';
import {
  completeDispatchedTurn,
  emitTurnEvent,
  expectSettled,
  loadedTranscriptRows,
  mountedTranscriptRows,
  nextEmittedEventId,
  readSettled,
  seedDailyDriverChats,
  seedDailyDriverShell,
  transcriptLocator,
} from './helpers/daily-driver-shell';
import {
  dismissSetupLauncher,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

/**
 * Daily-driver qualification scenario producer (archive#3307).
 *
 * Browser-layer evidence for the three declared-but-previously-unimplemented
 * scenarios: `conversation-agreement`, `transcript-stability`, and
 * `performance-stress`. Each test drives the real UI product path (composer →
 * `POST /api/orchestration/chat` dispatch → orchestration SSE → transcript)
 * against a deterministic engine-shaped backend, then writes a bounded
 * scenario observation artifact the qualification bridge
 * (`scripts/daily-driver-scenario-qualification.mjs`) ingests.
 *
 * `liveness-settlement` resumes by re-navigating the same tab, and the resumed
 * page really does carry archive#3300's precondition — the persisted chat
 * keeps `orchestrationStatus: 'running'` (confirmed in sessionStorage at the
 * moment the assertions run) while `orchestrationTurnOpen`/`status`, which
 * are not persisted, come back unset over a transcript whose turn has already
 * closed. Two things are required for a resumed page to have a chat at all,
 * and both are properties of the fixture rather than of the product: the
 * conversation must be in the `/api/conversations` inventory, and its session
 * must be in the serving Station's session read-model. Without the latter the
 * rehydrate path drops the chat as dead and the resumed page renders "No
 * active session" with the composer text demoted to an unsent draft.
 *
 * WHAT THIS SCENARIO NETS, both halves proven against a build carrying the
 * genuine defects archive#3330 fixed:
 * - archive#3299 — the banner-ownership arbitration. Without it,
 *   `failureRenderings` reds: "the recorded cause appeared 2 times".
 * - archive#3300 — the settled-turn suppression. Without it,
 *   `liveRowsAfterResume` reds: "a settled turn must not reconstruct a
 *   live-work row after a resume; 1 live row(s) rendered" — the settled
 *   answer with a live "Working…" row beneath it, the reported symptom.
 *   Note for whoever reproduces this next: a single-symbol revert of
 *   `isTurnStreamLive` alone into a HEAD tree does NOT reproduce it, so the
 *   suppression is over-determined across the files archive#3330 moved
 *   together. Reproduce this one against a historical bundle, not by
 *   reverting one derivation.
 *
 * The resume's power comes from the fixture prerequisites above: without the
 * session read-model entry the resumed page has no chat at all, and the
 * assertion passes over an empty surface.
 *
 * The deterministic backend follows the two-layer rule in
 * docs/strategy/daily-driver-qualification.md: an engine-shaped fake whose
 * reply derives ONLY from the accumulated per-conversation history it
 * observed through the dispatch seam — so context carry-over passes only when
 * the product genuinely threads one conversation across turns.
 */

const OBSERVATION_DIR_ENV = 'STATION_DAILY_DRIVER_SCENARIO_OBSERVATION_DIR';
const WRAPPER_ENV = 'STATION_DAILY_DRIVER_SCENARIO_OBSERVATION_WRAPPER';
const SOURCE_REVISION_ENV = 'STATION_DAILY_DRIVER_SCENARIO_SOURCE_REVISION';

/** Budget cap from docs/strategy/daily-driver-qualification.md. */
const MOUNTED_ROW_CAP = 200;

const PROFILE_PATHS = [
  {
    profile: 'claude-default' as const,
    agentSlug: 'claude',
    provider: 'claude',
    runtimeName: 'Claude Runtime',
    connectionId: 'claude',
    model: 'claude-sonnet-4-20250514',
    conversationId: 'dd-agree-claude',
    contextToken: 'CARRY-7391',
  },
  {
    profile: 'codex-default' as const,
    agentSlug: 'codex',
    provider: 'codex',
    runtimeName: 'Codex Runtime',
    connectionId: 'codex',
    model: 'gpt-5-codex',
    conversationId: 'dd-agree-codex',
    contextToken: 'CARRY-8412',
  },
];

const SHELL_AGENTS = PROFILE_PATHS.map((path) => ({
  agentSlug: path.agentSlug,
  provider: path.provider,
  runtimeName: path.runtimeName,
  connectionId: path.connectionId,
  models: [{ id: path.model, name: path.model }],
  defaultModel: path.model,
}));

const STABILITY_THREADS: Record<string, string> = {
  'claude-default': 'dd-stability-claude',
  'codex-default': 'dd-stability-codex',
};
const STRESS_THREADS: Record<string, string> = {
  'claude-default': 'dd-stress-claude',
  'codex-default': 'dd-stress-codex',
};
const STRESS_SIBLING_THREAD = 'dd-stress-sibling';
const SETTLE_THREADS: Record<string, string> = {
  'claude-default': 'dd-settle-claude',
  'codex-default': 'dd-settle-codex',
};
const FAILURE_THREADS: Record<string, string> = {
  'claude-default': 'dd-failure-claude',
  'codex-default': 'dd-failure-codex',
};

/**
 * The exact raw text archive#3299 found rendered to users as a headline. It
 * is a browser/parser internal, so the product must not present it as the
 * explanation — and it must present the failure ONCE.
 */
const RAW_STREAM_FAILURE =
  "Failed to execute 'close' on 'ReadableStreamDefaultController': Unexpected end of JSON input";

const SHELL_CONVERSATIONS = [
  ...PROFILE_PATHS.map((path) => ({
    id: path.conversationId,
    title: `${path.runtimeName} agreement`,
    agentSlug: path.agentSlug,
  })),
  ...PROFILE_PATHS.map((path) => ({
    id: STABILITY_THREADS[path.profile]!,
    title: `${path.runtimeName} stability`,
    agentSlug: path.agentSlug,
  })),
  ...PROFILE_PATHS.map((path) => ({
    id: STRESS_THREADS[path.profile]!,
    title: `${path.runtimeName} stress`,
    agentSlug: path.agentSlug,
  })),
  ...PROFILE_PATHS.map((path) => ({
    id: SETTLE_THREADS[path.profile]!,
    title: `${path.runtimeName} settlement`,
    agentSlug: path.agentSlug,
  })),
  ...PROFILE_PATHS.map((path) => ({
    id: FAILURE_THREADS[path.profile]!,
    title: `${path.runtimeName} failure`,
    agentSlug: path.agentSlug,
  })),
  { id: STRESS_SIBLING_THREAD, title: 'Stress sibling', agentSlug: 'claude' },
];

/**
 * Engine-shaped deterministic reply: derives its answer exclusively from the
 * FIRST message of the accumulated history plus the history length. A
 * dispatch that arrives on a fresh or different conversation cannot recall
 * the token, so only real carry-over produces a `Recalled <token> turns=N`
 * reply.
 */
function agreementReply(history: string[]): string {
  const match = /CARRY-[0-9]+/.exec(history[0] ?? '');
  return match
    ? `Recalled ${match[0]} turns=${history.length}`
    : 'CONTEXT_MISSING';
}

/**
 * Attaches an observation carrying evidence fields ONLY. This producer never
 * authors a `classification`: the contract derives it from that evidence, so
 * there is no second expression here to drift from the derivation the
 * qualification report re-checks.
 */
async function attachScenarioObservation(
  testInfo: TestInfo,
  scenario: string,
  observations: Array<Record<string, unknown>>,
) {
  const artifact = createDailyDriverScenarioObservation({
    sourceRevision: process.env[SOURCE_REVISION_ENV] ?? 'unverified',
    observations,
  });
  const serialized = JSON.stringify(artifact);
  await testInfo.attach(`daily-driver-scenario-${scenario}`, {
    body: serialized,
    contentType: 'application/json',
  });
  const directory = process.env[OBSERVATION_DIR_ENV];
  if (process.env[WRAPPER_ENV] === '1' && directory)
    writeFileSync(join(directory, `${scenario}.json`), serialized, {
      encoding: 'utf8',
      flag: 'wx',
    });
}

/**
 * Pages "Load earlier events" until the transcript MODEL holds more rows than
 * the mounted-row budget allows, and reports the loaded count and the largest
 * mounted count seen on the way. Both scenarios that assert the budget need
 * this: a cap assertion over a transcript that never loaded that many rows is
 * unfalsifiable.
 */
async function pageEarlierBeyondCap(
  page: Page,
  seedMountedRows = 0,
): Promise<{ loadedRows: number; maxMountedRows: number }> {
  const loadEarlier = page.getByRole('button', { name: 'Load earlier events' });
  await expect(loadEarlier).toBeVisible({ timeout: 10_000 });
  let loadedRows = await loadedTranscriptRows(page);
  let maxMountedRows = Math.max(
    seedMountedRows,
    await mountedTranscriptRows(page),
  );
  for (
    let pageIndex = 0;
    pageIndex < 40 && loadedRows <= MOUNTED_ROW_CAP;
    pageIndex += 1
  ) {
    await loadEarlier.click();
    await expect
      .poll(() => loadedTranscriptRows(page), { timeout: 10_000 })
      .toBeGreaterThan(loadedRows);
    loadedRows = await loadedTranscriptRows(page);
    maxMountedRows = Math.max(
      maxMountedRows,
      await mountedTranscriptRows(page),
    );
  }
  return { loadedRows, maxMountedRows };
}

/**
 * In-app conversation switch through the conversation-history surface — the
 * product's own task switcher, with no navigation or reload.
 */
async function openConversationHistory(page: Page) {
  const chatList = page.getByRole('complementary', { name: 'Inbox chats' });
  await chatList.getByRole('button', { name: 'Conversation history' }).click();
  await expect(page.locator('.conversation-history')).toBeVisible({
    timeout: 10_000,
  });
}

/** Selects an already-listed conversation; the panel closes behind it. */
async function selectHistoryConversation(page: Page, title: string) {
  const history = page.locator('.conversation-history');
  await history
    .locator('.session-item')
    .filter({
      has: page.locator('.session-item__title-row', { hasText: title }),
    })
    .first()
    .click();
  await expect(history).toBeHidden({ timeout: 10_000 });
}

async function openSiblingConversation(page: Page, title: string) {
  await openConversationHistory(page);
  await selectHistoryConversation(page, title);
}

async function openScenarioChat(page: Page, conversationId: string) {
  await page.goto(`/?dock=open&maximize=true&chat=${conversationId}`);
  await dismissSetupLauncher(page);
  await waitForMockOrchestrationSse(page);
}

/** Occurrences of `needle` in the rendered chat surface. */
function occurrences(page: Page, needle: string) {
  return page
    .locator('.chat-dock, .chat-workspace-pane, body')
    .first()
    .evaluate(
      (element, text) => (element.textContent ?? '').split(text).length - 1,
      needle,
    );
}

test.describe('daily-driver scenario qualification (station#3307)', () => {
  for (const path of PROFILE_PATHS)
    test(`liveness-settlement (${path.profile}): a settled turn stays settled across a resume, and one failure renders once`, async ({
      page,
    }, testInfo) => {
      // archive#3769: a failure replayed from the durable event window is a
      // visible failure surface, so the banner defers to it exactly as it does
      // to the live `[CHAT_ERROR]` marker — the projection stamps
      // `runtimeError: true` on the row it writes and `rendersAsFailureSurface`
      // matches that flag rather than the `⚠️` its display copy starts with.
      test.setTimeout(180_000);
      const settleThread = SETTLE_THREADS[path.profile]!;
      const failureThread = FAILURE_THREADS[path.profile]!;
      const settledAnswer = `Settled answer for ${path.profile}.`;
      // The serving Station's own session record: empty until the failure
      // phase, then the failed session archive#3213's banner exists for.
      // Typed against the SDK's own summary rather than a bag of fields: a
      // rename on the server's serializer then breaks typecheck here instead
      // of leaving this scenario green on a shape the product stopped
      // emitting. It does not pin field SEMANTICS — only the shape.
      let sessionReadModel: OrchestrationSessionSummary[] = [];
      const shell = await seedDailyDriverShell(page, {
        agents: SHELL_AGENTS,
        conversations: SHELL_CONVERSATIONS,
        extraRoutes: async (routePath, route) => {
          if (routePath !== '/api/orchestration/sessions/read-model')
            return false;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: sessionReadModel }),
          });
          return true;
        },
      });

      // ── archive#3300 precondition: open a turn, persist 'running', and
      // let it settle unseen so the resume restores a stale live flag ──
      await openScenarioChat(page, settleThread);
      const transcript = transcriptLocator(page);
      const textarea = page.locator('textarea[placeholder*="Type a message"]');
      await expect(textarea).toBeVisible({ timeout: 15_000 });
      const requestsBefore = shell.executionRequests.length;
      await textarea.fill('Do the long thing.');
      await textarea.press('Enter');
      await expect
        .poll(() => shell.executionRequests.length, { timeout: 10_000 })
        .toBe(requestsBefore + 1);
      const settleTurnId = `dd-settle-${path.profile}-turn`;
      await emitTurnEvent(page, {
        threadId: settleThread,
        turnId: settleTurnId,
        provider: path.provider,
        method: 'turn.started',
        extra: { prompt: 'Do the long thing.' },
      });
      // Negative control for every assertion below: while the turn really IS
      // open, the live-work row renders. A resume that renders nothing at all
      // would otherwise satisfy "no flash" by rendering nothing.
      await expect(page.locator('.streaming-message')).toHaveCount(1, {
        timeout: 10_000,
      });
      // The archive#3300 precondition, built exactly: `orchestrationStatus`
      // reaches sessionStorage as 'running' while the turn is open, and the
      // turn then settles while this app cannot see it — so the reload
      // restores a stale 'running' flag over a transcript whose turn is
      // already closed. `orchestrationTurnOpen` and `status` are not
      // persisted, which is what let the two derivations disagree.
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (sessionStorage.getItem('activeChats') ?? '').includes(
                '"orchestrationStatus":"running"',
              ),
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
      // A resumed page rehydrates its open chats against the serving
      // Station's own session list; a chat whose session that list does not
      // carry is dropped as dead. The settled session is recorded here for
      // exactly that reason.
      sessionReadModel = [
        {
          threadId: settleThread,
          provider: path.provider,
          // The serving Station still believes this session is running: the
          // turn settled after its last lifecycle write. That is the shape
          // archive#3300 was reported against — a resumed page whose stale
          // 'running' flag has nothing to correct it.
          lifecycleState: 'running',
          status: 'running',
          controlMode: 'station-owned',
          answerability: { answerable: true },
          isLoaded: true,
          isPersisted: true,
          eventCount: 2,
          createdAt: '2026-08-19T09:00:00Z',
          updatedAt: '2026-08-19T09:00:05Z',
        },
      ];
      await page.route(
        `**/api/orchestration/sessions/${settleThread}/event-window**`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: {
                protocolVersion: 1,
                session: {
                  threadId: settleThread,
                  provider: path.provider,
                  status: 'idle',
                },
                events: [
                  {
                    sequence: 1,
                    event: {
                      eventId: `${settleTurnId}-started`,
                      method: 'turn.started',
                      provider: path.provider,
                      threadId: settleThread,
                      turnId: settleTurnId,
                      createdAt: '2026-08-19T09:00:00Z',
                      prompt: 'Do the long thing.',
                    },
                  },
                  {
                    sequence: 2,
                    event: {
                      eventId: `${settleTurnId}-completed`,
                      method: 'turn.completed',
                      provider: path.provider,
                      threadId: settleThread,
                      turnId: settleTurnId,
                      createdAt: '2026-08-19T09:00:05Z',
                      outputText: settledAnswer,
                    },
                  },
                ],
                hasMore: false,
                watermark: 2,
              },
            }),
          }),
      );
      // The resume itself: a fresh document on the same tab, so the persisted
      // chat state survives while every in-memory flag is rebuilt.
      await openScenarioChat(page, settleThread);
      await expect(
        transcript.getByText(settledAnswer, { exact: true }).first(),
      ).toBeVisible({ timeout: 20_000 });
      const answerRenderings = await occurrences(page, settledAnswer);
      const liveRowsAfterResume = await page
        .locator('.streaming-message')
        .count();
      expect(
        answerRenderings,
        `liveness-settlement (${path.profile}): a settled answer must render exactly once after a resume; rendered ${answerRenderings} times`,
      ).toBe(1);
      expect(
        liveRowsAfterResume,
        `liveness-settlement (${path.profile}): a settled turn must not reconstruct a live-work row after a resume; ${liveRowsAfterResume} live row(s) rendered under the settled answer`,
      ).toBe(0);
      await expectSettled(page, 10_000);

      // ── archive#3299: one failure, one surface, in product words ──
      sessionReadModel = [
        {
          threadId: failureThread,
          provider: path.provider,
          lifecycleState: 'failed',
          status: 'error',
          controlMode: 'station-owned',
          blockedReason: RAW_STREAM_FAILURE,
          answerability: { answerable: true },
          isLoaded: true,
          isPersisted: true,
          eventCount: 3,
          createdAt: '2026-08-19T09:10:00Z',
          updatedAt: '2026-08-19T09:10:05Z',
        },
      ];
      await page.route(
        `**/api/orchestration/sessions/${failureThread}/event-window**`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: {
                protocolVersion: 1,
                session: {
                  threadId: failureThread,
                  provider: path.provider,
                  status: 'error',
                },
                events: [
                  {
                    sequence: 1,
                    event: {
                      eventId: 'failure-started',
                      method: 'turn.started',
                      provider: path.provider,
                      threadId: failureThread,
                      turnId: 'failure-turn',
                      createdAt: '2026-08-19T09:10:00Z',
                      prompt: 'Summarize this repo.',
                    },
                  },
                  {
                    sequence: 2,
                    event: {
                      eventId: 'failure-error',
                      method: 'runtime.error',
                      provider: path.provider,
                      threadId: failureThread,
                      createdAt: '2026-08-19T09:10:04Z',
                      message: RAW_STREAM_FAILURE,
                    },
                  },
                  {
                    sequence: 3,
                    event: {
                      eventId: 'failure-aborted',
                      method: 'turn.aborted',
                      provider: path.provider,
                      threadId: failureThread,
                      turnId: 'failure-turn',
                      createdAt: '2026-08-19T09:10:05Z',
                    },
                  },
                ],
                hasMore: false,
                watermark: 3,
              },
            }),
          }),
      );
      await openScenarioChat(page, failureThread);
      await expect
        .poll(() => occurrences(page, RAW_STREAM_FAILURE), { timeout: 20_000 })
        .toBeGreaterThan(0);
      const failureRenderings = await occurrences(page, RAW_STREAM_FAILURE);
      const failureBanners = await page
        .locator('[data-testid="chat-dock-session-failure"]')
        .count();
      expect(
        failureRenderings,
        `liveness-settlement (${path.profile}): one stream failure must render once; the recorded cause appeared ${failureRenderings} times`,
      ).toBe(1);
      expect(
        failureBanners,
        `liveness-settlement (${path.profile}): the session banner must defer to the turn-adjacent surface that already carries this failure`,
      ).toBe(0);

      await attachScenarioObservation(
        testInfo,
        `liveness-settlement-${path.profile}`,
        [
          {
            profile: path.profile,
            surface: 'ui',
            scenario: 'liveness-settlement',
            capability: 'liveness-settlement',
            repetition: 1,
            answerRenderings,
            liveRowsAfterResume,
            failureRenderings,
            failureBanners,
          },
        ],
      );
    });

  for (const path of PROFILE_PATHS)
    test(`conversation-agreement (${path.profile}): three completed turns in one conversation carry turn-1 context to turn 3`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const shell = await seedDailyDriverShell(page, {
        agents: SHELL_AGENTS,
        conversations: SHELL_CONVERSATIONS,
      });
      await seedDailyDriverChats(page, [
        {
          conversationId: path.conversationId,
          agentSlug: path.agentSlug,
          title: `${path.runtimeName} agreement`,
          model: path.model,
        },
      ]);

      await openScenarioChat(page, path.conversationId);
      const textarea = page.locator('textarea[placeholder*="Type a message"]');
      await expect(textarea).toBeVisible({ timeout: 15_000 });
      const transcript = transcriptLocator(page);

      const turnTexts = [
        `Remember the exact token ${path.contextToken}.`,
        'Continue without repeating the token.',
        'Recall the token from the first turn.',
      ];
      const requestsBefore = shell.executionRequests.length;
      let completedTurns = 0;
      let lastReply = '';
      for (const [index, userText] of turnTexts.entries()) {
        await textarea.fill(userText);
        await textarea.press('Enter');
        await expect
          .poll(() => shell.executionRequests.length - requestsBefore, {
            timeout: 10_000,
          })
          .toBe(index + 1);
        const history =
          shell.historyByConversation.get(path.conversationId) ?? [];
        lastReply = agreementReply(history);
        const currentSessionId = shell.sessionIds(path.conversationId).at(-1);
        if (!currentSessionId)
          throw new Error('daily-driver dispatch returned no child Session');
        await completeDispatchedTurn(page, {
          threadId: currentSessionId,
          turnId: `dd-agree-${path.profile}-turn-${index + 1}`,
          provider: path.provider,
          userText,
          reply: lastReply,
        });
        await shell.markCurrentSessionTerminal(path.conversationId);
        // `.first()`: this step only establishes that the turn's reply
        // arrived. Whether it arrived ONCE is the carry-over assertion's
        // business below — a history-blind engine repeats one reply, and a
        // strict-mode violation here would hide the assertion that names the
        // real defect.
        await expect(
          transcript.getByText(lastReply, { exact: true }).first(),
        ).toBeVisible({ timeout: 5_000 });
        await expectSettled(page);
        completedTurns += 1;
      }

      const submitted = shell.executionRequests.slice(requestsBefore);
      const conversationStable =
        submitted.length === 3 &&
        submitted.every(
          (request) => request.conversationId === path.conversationId,
        );
      expect(
        conversationStable,
        `conversation-agreement (${path.profile}): all three dispatches must carry the same conversationId — got ${JSON.stringify(submitted.map((request) => request.conversationId))}`,
      ).toBe(true);
      const sessionIds = shell.sessionIds(path.conversationId);
      const continuationRouteUsed =
        submitted[0]?.route === 'start' &&
        submitted.slice(1).every((request) => request.route === 'continue');
      const distinctSessionCount = new Set(sessionIds).size;
      const terminalPredecessorCount = shell.terminalPredecessorCount(
        path.conversationId,
      );
      const terminalReuseRefused = await shell.attemptTerminalSessionReuse(
        path.conversationId,
      );
      expect(continuationRouteUsed).toBe(true);
      expect(distinctSessionCount).toBe(3);
      expect(terminalPredecessorCount).toBe(2);
      expect(terminalReuseRefused).toBe(true);
      const persistedLineage = await shell.restorePersistedLineage(
        path.conversationId,
      );
      await openScenarioChat(page, path.conversationId);
      await expect(
        transcript.getByText(lastReply, { exact: true }).first(),
      ).toBeVisible({ timeout: 10_000 });
      const reloadExactlyOnce = (await occurrences(page, lastReply)) === 1;
      expect(reloadExactlyOnce).toBe(true);
      expect(persistedLineage).toBe(true);
      expect(shell.sessionIds(path.conversationId)).toEqual(sessionIds);

      // The core carry-over binding: the deterministic engine can only say
      // `Recalled <token> turns=3` when the dispatch seam accumulated the
      // first turn's token under this conversation. A history-blind or
      // conversation-splitting regression yields CONTEXT_MISSING here.
      const carryOverBound =
        lastReply === `Recalled ${path.contextToken} turns=3`;
      expect(
        carryOverBound,
        `conversation-agreement (${path.profile}): turn 3 reply must derive the ${path.contextToken} token from turn 1 history; engine replied '${lastReply}'`,
      ).toBe(true);
      await expect(
        transcript.getByText(`Recalled ${path.contextToken} turns=3`, {
          exact: true,
        }),
      ).toBeVisible();

      await attachScenarioObservation(
        testInfo,
        `conversation-agreement-${path.profile}`,
        [
          {
            profile: path.profile,
            surface: 'ui',
            scenario: 'conversation-agreement',
            capability: 'conversation-agreement',
            repetition: 1,
            completedTurns,
            conversationStable,
            carryOverBound,
            continuationRouteUsed,
            distinctSessionCount,
            terminalPredecessorCount,
            terminalReuseRefused,
            persistedLineage,
            reloadExactlyOnce,
            settled: await readSettled(page),
          },
        ],
      );
      await page.evaluate(
        (key) => localStorage.removeItem(key),
        `station-dd-lineage:${path.conversationId}`,
      );
      expect(
        await shell.restorePersistedLineage(path.conversationId),
        'conversation-agreement persistence negative control: clearing the durable snapshot must make a memory-cleared restore fail',
      ).toBe(false);
    });

  for (const path of PROFILE_PATHS)
    test(`transcript-stability (${path.profile}): 10k-turn restore stays inside the mounted-row budget with stable order`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(180_000);
      const threadId = STABILITY_THREADS[path.profile]!;
      const stabilityTitle = `${path.runtimeName} stability`;
      const turns = buildLongSessionTurns({
        threadId,
        provider: path.provider,
      });
      await seedDailyDriverShell(page, {
        agents: SHELL_AGENTS,
        conversations: SHELL_CONVERSATIONS,
      });
      await page.route(
        `**/api/orchestration/sessions/${threadId}/event-window**`,
        createLongSessionEventWindowHandler({
          threadId,
          provider: path.provider,
          availableTurns: () => turns,
        }),
      );
      // Every sample restores the 10k conversation INTO A RUNNING APP, from a
      // sibling conversation, through the product's own task switcher. The
      // budget names a restored transcript, so a cold navigation — whose
      // elapsed time is dominated by SPA boot — cannot be the measurement.
      await openScenarioChat(page, STRESS_SIBLING_THREAD);

      const tailMarker = `Transcript fixture ${LONG_SESSION_TURN_COUNT - 1}: retained content for selection.`;
      const restoreSamplesMs: number[] = [];
      let maxMountedRows = 0;
      for (let index = 0; index < 3; index += 1) {
        // The history panel is opened OUTSIDE the measured span — the budget
        // names the transcript restore, not the reader's route to it.
        await openConversationHistory(page);
        // Started before the row click: the span runs from just before the
        // gesture to the frame in which the restored tail is part of the
        // transcript DOM. The driver's dispatch latency lands inside the
        // span, so the sample over-reports rather than flattering the budget.
        const measurement = page.evaluate(
          (marker) =>
            new Promise<number>((resolve, reject) => {
              const start = performance.now();
              const deadline = start + 30_000;
              const check = () => {
                if (
                  document
                    .querySelector('.chat-messages')
                    ?.textContent?.includes(marker)
                )
                  return resolve(Math.round(performance.now() - start));
                if (performance.now() > deadline)
                  return reject(
                    new Error(`10k transcript tail '${marker}' never restored`),
                  );
                requestAnimationFrame(check);
              };
              check();
            }),
          tailMarker,
        );
        await selectHistoryConversation(page, stabilityTitle);
        restoreSamplesMs.push(await measurement);
        maxMountedRows = Math.max(
          maxMountedRows,
          await mountedTranscriptRows(page),
        );
        if (index < 2) await openSiblingConversation(page, 'Stress sibling');
      }

      const transcript = transcriptLocator(page);
      const paged = await pageEarlierBeyondCap(page, maxMountedRows);
      const loadedRows = paged.loadedRows;
      maxMountedRows = paged.maxMountedRows;

      expect(
        loadedRows,
        `transcript-stability (${path.profile}): the restored transcript must hold more rows than the ${MOUNTED_ROW_CAP}-row mounted budget, or the budget assertion proves nothing; loaded ${loadedRows}`,
      ).toBeGreaterThan(MOUNTED_ROW_CAP);
      expect(
        maxMountedRows,
        `transcript-stability (${path.profile}): mounted transcript rows must stay at or under the documented ${MOUNTED_ROW_CAP}-row budget for a 10,000-turn restore; observed ${maxMountedRows} mounted of ${loadedRows} loaded`,
      ).toBeLessThanOrEqual(MOUNTED_ROW_CAP);

      const order = await transcript.evaluate((element, marker) => {
        const text = element.textContent ?? '';
        return {
          prompt: text.indexOf(
            marker.replace(': retained content for selection.', ': prompt.'),
          ),
          reply: text.indexOf(marker),
        };
      }, tailMarker);
      const orderStable =
        order.prompt >= 0 && order.reply >= 0 && order.prompt < order.reply;
      expect(
        orderStable,
        `transcript-stability (${path.profile}): tail turn must restore user-then-assistant in order; got ${JSON.stringify(order)}`,
      ).toBe(true);

      const tailDistance = await transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      );
      const tailBound = tailDistance <= 400;

      await attachScenarioObservation(
        testInfo,
        `transcript-stability-${path.profile}`,
        [
          {
            profile: path.profile,
            surface: 'ui',
            scenario: 'transcript-stability',
            capability: 'transcript-stability',
            repetition: 1,
            fixtureTurnCount: turns.length,
            mountedRowCap: MOUNTED_ROW_CAP,
            maxMountedRows,
            loadedRows,
            orderStable,
            tailBound,
            restoreSamplesMs,
          },
        ],
      );
    });

  for (const path of PROFILE_PATHS)
    test(`performance-stress (${path.profile}): stream while scrolled up, switch tasks mid-stream, and drain the queue`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(180_000);
      const shell = await seedDailyDriverShell(page, {
        agents: SHELL_AGENTS,
        conversations: SHELL_CONVERSATIONS,
      });
      const threadId = STRESS_THREADS[path.profile]!;
      await seedDailyDriverChats(page, [
        {
          conversationId: threadId,
          agentSlug: path.agentSlug,
          title: `${path.runtimeName} stress`,
          model: path.model,
        },
        {
          conversationId: STRESS_SIBLING_THREAD,
          agentSlug: 'claude',
          title: 'Stress sibling',
        },
      ]);
      const turns = buildLongSessionTurns({
        threadId,
        provider: path.provider,
        turnCount: 1_000,
      });
      await page.route(
        `**/api/orchestration/sessions/${threadId}/event-window**`,
        createLongSessionEventWindowHandler({
          threadId,
          provider: path.provider,
          availableTurns: () => turns,
        }),
      );

      await openScenarioChat(page, threadId);
      const transcript = transcriptLocator(page);
      await expect(
        transcript.getByText('Transcript fixture 999: prompt.', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 30_000 });
      // Load past the mounted-row budget BEFORE anything is measured over
      // this transcript: an initial window holds ~20 rows, so a cap claim
      // taken there could not fail whatever the product did.
      const { loadedRows } = await pageEarlierBeyondCap(page);
      expect(
        loadedRows,
        `performance-stress (${path.profile}): the transcript must hold more rows than the ${MOUNTED_ROW_CAP}-row mounted budget before the stream is measured over it; loaded ${loadedRows}`,
      ).toBeGreaterThan(MOUNTED_ROW_CAP);

      // 1. Stream while scrolled up: an incoming turn must not hijack the
      // reader's scroll position, and mounted rows must stay bounded.
      await transcript.evaluate((element) => {
        element.scrollTop = Math.max(
          1,
          Math.floor(element.scrollHeight / 2) - element.clientHeight,
        );
        // Wheel-then-scroll is how a real reader leaves the tail; the
        // transcript's follow-the-tail state keys off user gestures, not
        // bare programmatic scrollTop writes.
        element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      const scrollBefore = await transcript.evaluate(
        (element) => element.scrollTop,
      );
      const scrolledTurnId = `dd-stress-${path.profile}-scrolled`;
      const scrolledText = `Scrolled-up stream for ${path.profile}.`;
      await emitTurnEvent(page, {
        threadId,
        turnId: scrolledTurnId,
        provider: path.provider,
        method: 'turn.started',
        extra: { prompt: 'External stress turn' },
      });
      for (let delta = 0; delta < 3; delta += 1)
        await emitTurnEvent(page, {
          threadId,
          turnId: scrolledTurnId,
          provider: path.provider,
          method: 'content.text-delta',
          extra: { itemId: scrolledTurnId, delta: `${scrolledText} ` },
        });
      const scrollAfter = await transcript.evaluate(
        (element) => element.scrollTop,
      );
      const scrollHeldDuringStream = Math.abs(scrollAfter - scrollBefore) <= 2;
      expect(
        scrollHeldDuringStream,
        `performance-stress (${path.profile}): streaming while scrolled up must not move the reader; scrollTop ${scrollBefore} -> ${scrollAfter}`,
      ).toBe(true);
      const mountedRowsDuringStream = await mountedTranscriptRows(page);
      await emitTurnEvent(page, {
        threadId,
        turnId: scrolledTurnId,
        provider: path.provider,
        method: 'turn.completed',
        extra: {
          outputText: `${scrolledText} ${scrolledText} ${scrolledText}`,
        },
      });

      // 2. Task switch during stream: start a dispatched turn, switch to a
      // sibling conversation mid-stream, come back, and the streamed content
      // must be present exactly once.
      // Placeholder-independent: `ChatInputArea.tsx:261-267` swaps
      // "Type a message…" for "Queue a follow-up…" while a turn is in flight,
      // which is exactly the state the drain step below needs. The composer's
      // own fieldset carries the stable accessible name (`:430-432`).
      const textarea = page
        .getByRole('group', { name: 'Message composer file drop area' })
        .getByRole('textbox');
      await expect(textarea).toBeVisible({ timeout: 10_000 });
      const requestsBefore = shell.executionRequests.length;
      await textarea.fill('Start the switch turn.');
      await textarea.press('Enter');
      await expect
        .poll(() => shell.executionRequests.length, { timeout: 10_000 })
        .toBe(requestsBefore + 1);
      const switchTurnId = `dd-stress-${path.profile}-switch`;
      const switchMarker = `Switch stream marker for ${path.profile}`;
      await emitTurnEvent(page, {
        threadId,
        turnId: switchTurnId,
        provider: path.provider,
        method: 'turn.started',
        extra: { prompt: 'Start the switch turn.' },
      });
      await emitTurnEvent(page, {
        threadId,
        turnId: switchTurnId,
        provider: path.provider,
        method: 'content.text-delta',
        extra: { itemId: switchTurnId, delta: switchMarker },
      });
      await expect(transcript.getByText(switchMarker)).toBeVisible({
        timeout: 5_000,
      });

      // Switch to a sibling conversation and back through the conversation
      // history — a real task switch inside the running app, not a page
      // reload.
      await openSiblingConversation(page, 'Stress sibling');
      await expect(transcript.getByText(switchMarker)).toHaveCount(0, {
        timeout: 10_000,
      });
      // The turn settles while the reader is away, so the session's own event
      // log carries it — the fixture window grows the same way the server's
      // does, otherwise coming back would only prove the fixture forgot.
      turns.push([
        {
          eventId: `${switchTurnId}-started`,
          method: 'turn.started',
          provider: path.provider,
          threadId,
          turnId: switchTurnId,
          createdAt: '2026-07-19T11:00:00Z',
          prompt: 'Start the switch turn.',
        },
        {
          eventId: `${switchTurnId}-completed`,
          method: 'turn.completed',
          provider: path.provider,
          threadId,
          turnId: switchTurnId,
          createdAt: '2026-07-19T11:00:00Z',
          outputText: switchMarker,
        },
      ]);
      await emitTurnEvent(page, {
        threadId,
        turnId: switchTurnId,
        provider: path.provider,
        method: 'turn.completed',
        extra: { outputText: switchMarker },
      });
      await shell.markCurrentSessionTerminal(threadId);
      await openSiblingConversation(page, `${path.runtimeName} stress`);
      await expect(transcript.getByText(switchMarker).first()).toBeVisible({
        timeout: 10_000,
      });
      const markerOccurrences = () =>
        transcript.evaluate(
          (element, marker) =>
            (element.textContent ?? '').split(marker).length - 1,
          switchMarker,
        );
      await expect
        .poll(markerOccurrences, { timeout: 10_000 })
        .toBeGreaterThan(0);
      const taskSwitchStable = (await markerOccurrences()) === 1;
      expect(
        taskSwitchStable,
        `performance-stress (${path.profile}): streamed content must survive a task switch exactly once — '${switchMarker}' occurred ${await markerOccurrences()} time(s)`,
      ).toBe(true);

      // 3. Queue drain: a message sent mid-turn queues, and completing the
      // open turn dispatches it automatically on the same conversation.
      const drainRequestsBefore = shell.executionRequests.length;
      await textarea.fill('Open the drain turn.');
      await textarea.press('Enter');
      await expect
        .poll(() => shell.executionRequests.length, { timeout: 10_000 })
        .toBe(drainRequestsBefore + 1);
      const drainSessionId = shell.sessionIds(threadId).at(-1);
      if (!drainSessionId)
        throw new Error('performance drain dispatch returned no child Session');
      const drainTurnId = `dd-stress-${path.profile}-drain`;
      await emitTurnEvent(page, {
        threadId: drainSessionId,
        turnId: drainTurnId,
        provider: path.provider,
        method: 'turn.started',
        extra: { prompt: 'Open the drain turn.' },
      });
      await textarea.fill('Queued follow-up probe.');
      await textarea.press('Enter');
      await expect(page.locator('.queued-messages')).toContainText(
        '1 message queued',
        { timeout: 10_000 },
      );
      expect(shell.executionRequests.length).toBe(drainRequestsBefore + 1);
      const drainedResponse = page.waitForResponse((response) => {
        const request = response.request();
        return (
          request.method() === 'POST' &&
          request.url().includes('/api/orchestration/chat') &&
          request.postData()?.includes('Queued follow-up probe.') === true
        );
      });
      await shell.markCurrentSessionTerminal(threadId);
      await emitTurnEvent(page, {
        threadId: drainSessionId,
        turnId: drainTurnId,
        provider: path.provider,
        method: 'turn.completed',
        extra: { outputText: 'Drain turn complete.' },
      });
      expect((await drainedResponse).ok()).toBe(true);
      await expect
        .poll(() => shell.executionRequests.length, { timeout: 10_000 })
        .toBe(drainRequestsBefore + 2);
      // Reopen through the real task switcher so the conversation window
      // confirms the queued dispatch's child Session before child-keyed paint
      // events are sampled. This is outside the measured delta-to-paint span.
      await openSiblingConversation(page, 'Stress sibling');
      await openSiblingConversation(page, `${path.runtimeName} stress`);
      await expect(textarea).toBeVisible({ timeout: 10_000 });
      const drained = shell.executionRequests.at(-1);
      const queueDrained =
        drained?.message === 'Queued follow-up probe.' &&
        drained.conversationId === threadId;
      expect(
        queueDrained,
        `performance-stress (${path.profile}): completing the open turn must dispatch the queued message on the same conversation; got ${JSON.stringify({ message: drained?.message, conversationId: drained?.conversationId })}`,
      ).toBe(true);
      const paintSessionId = shell.sessionIds(threadId).at(-1);
      if (!paintSessionId)
        throw new Error('drained follow-up returned no current child Session');
      expect(paintSessionId).not.toBe(threadId);
      expect(paintSessionId).toBe(shell.sessionIds(threadId).at(-1));

      // 4. Delta-to-paint samples on the drained turn, measured in-page at
      // requestAnimationFrame resolution from SSE emit to the frame in which
      // the delta text is part of the transcript DOM.
      const paintTurnId = `dd-stress-${path.profile}-paint`;
      await emitTurnEvent(page, {
        threadId: paintSessionId,
        turnId: paintTurnId,
        provider: path.provider,
        method: 'turn.started',
        extra: { prompt: 'Queued follow-up probe.' },
      });
      const deltaPaintSamplesMs: number[] = [];
      const paintMarkers: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const marker = `PAINTMARK${index}X`;
        paintMarkers.push(marker);
        const sample = await page.evaluate(
          async ({ event, marker: target }) => {
            const start = performance.now();
            (
              window as unknown as {
                __mockOrchestrationSse: {
                  emit: (type: string, payload: unknown) => void;
                };
              }
            ).__mockOrchestrationSse.emit('orchestration:event', { event });
            await new Promise<void>((resolve, reject) => {
              const deadline = start + 5_000;
              const check = () => {
                if (
                  document
                    .querySelector('.chat-messages')
                    ?.textContent?.includes(target)
                )
                  return resolve();
                if (performance.now() > deadline)
                  return reject(new Error(`delta '${target}' never painted`));
                requestAnimationFrame(check);
              };
              check();
            });
            return Math.round(performance.now() - start);
          },
          {
            event: {
              eventId: nextEmittedEventId(),
              provider: path.provider,
              threadId: paintSessionId,
              turnId: paintTurnId,
              createdAt: new Date().toISOString(),
              method: 'content.text-delta',
              itemId: paintTurnId,
              delta: `${marker} `,
            },
            marker,
          },
        );
        deltaPaintSamplesMs.push(sample);
      }
      await emitTurnEvent(page, {
        threadId: paintSessionId,
        turnId: paintTurnId,
        provider: path.provider,
        method: 'turn.completed',
        extra: { outputText: `${paintMarkers.join(' ')} ` },
      });
      await expectSettled(page, 2_000);

      await attachScenarioObservation(
        testInfo,
        `performance-stress-${path.profile}`,
        [
          {
            profile: path.profile,
            surface: 'ui',
            scenario: 'performance-stress',
            capability: 'performance-stress',
            repetition: 1,
            scrollHeldDuringStream,
            taskSwitchStable,
            queueDrained,
            mountedRowsDuringStream,
            loadedRows,
            mountedRowCap: MOUNTED_ROW_CAP,
            settled: await readSettled(page),
            deltaPaintSamplesMs,
          },
        ],
      );
    });
});
