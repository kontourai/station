import { expect, type Page } from '@playwright/test';
import { test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationSse,
  openChatRegion,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

/**
 * A subagent spawned by a tool call is drawn as a card inline in the chat
 * transcript, where that call sits, and follows the child from running to
 * its outcome. Events arrive through the named orchestration SSE fixture
 * seam, in the shapes `claude-adapter-child-work.ts` publishes.
 */

const SESSION_ID = 'session-1';
const CONVERSATION_ID = 'conv-1';
const TOOL_CALL = 'toolu_agent_1';
const STARTED_AT = '2026-10-14T14:25:00.000Z';
const ENDED_AT = '2026-10-14T14:42:04.000Z';

const runningChild = {
  producer: 'engine-subagent',
  reporterThreadId: SESSION_ID,
  childId: 'a1b2c3',
  status: 'running',
  parent: { toolCallId: TOOL_CALL, turnId: 'turn-1' },
  title: '[opus] review station#3657 ADR freeze',
  kindLabel: 'general-purpose',
  model: { id: 'claude-opus-5-5', source: 'subagent-reply' },
  transcript: {
    kind: 'claude-subagent',
    sessionId: '3f1c9b2e-8d4a-4c11-9e2f-5b7a6c0d1e2f',
    agentId: 'a1b2c3',
  },
  backgrounded: true,
  depth: 1,
  startedAt: STARTED_AT,
  controls: { stop: 'provider-task-stop' },
};

/**
 * The stream's global sequence for the next frame. The mocked window numbers
 * the same emitted events 1..n, so a live frame and its replayed copy agree,
 * and a frame emitted after a window read lands past its watermark.
 */
let liveSequence = 0;

async function emit(page: Page, event: Record<string, unknown>) {
  liveSequence += 1;
  await emitMockOrchestrationEvent(
    page,
    'orchestration:event',
    {
      event: {
        provider: 'claude',
        threadId: SESSION_ID,
        createdAt: STARTED_AT,
        ...event,
      },
    },
    { sequence: liveSequence },
  );
}

test.describe('subagent transcript cards', () => {
  test.beforeEach(async ({ page }) => {
    liveSequence = 0;
    // The running card's clock reads Date.now(); pin it six minutes and
    // twelve seconds after the child's reported start.
    await page.clock.setFixedTime(new Date('2026-10-14T14:31:12.000Z'));
    await seedActiveChats(page, [
      {
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        agentSlug: 'dev-agent',
        model: 'claude-opus-5-5',
        provider: 'claude',
        projectSlug: 'dev',
        orchestrationSessionStarted: true,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await installMockOrchestrationConversationEventWindow(
      page,
      (conversationId) =>
        conversationId === CONVERSATION_ID ? [SESSION_ID] : [],
    );
    // The subagent's own transcript, as the server resolves it.
    await page.route(
      `**/api/orchestration/sessions/${SESSION_ID}/child-work/a1b2c3/transcript**`,
      (route) =>
        route.fulfill({
          json: {
            success: true,
            data: {
              entries: [
                {
                  message: 0,
                  kind: 'text',
                  role: 'user',
                  text: 'Review the ADR freeze PR.',
                },
                {
                  message: 1,
                  kind: 'tool-call',
                  name: 'Bash',
                  input: 'gh pr view 3657 --repo kontourai/station',
                },
              ],
            },
          },
        }),
    );
    // The chat's own session, as the read model lists it.
    await page.route('**/api/orchestration/sessions/read-model', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              threadId: SESSION_ID,
              conversationId: CONVERSATION_ID,
              provider: 'claude',
              status: 'running',
              lifecycleState: 'running',
              hasActiveTurn: false,
              controlMode: 'station-owned',
              answerability: { answerable: true },
              isLoaded: true,
              isPersisted: true,
              eventCount: 1,
              createdAt: STARTED_AT,
              updatedAt: STARTED_AT,
            },
          ],
        },
      }),
    );
  });

  test('a spawned subagent gets one inline card that goes from Running to Completed and opens its result', async ({
    page,
  }, testInfo) => {
    // Tall enough that the dock's transcript shows the expanded card whole.
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.goto(`/?chat=${encodeURIComponent(CONVERSATION_ID)}`);
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);

    await emit(page, {
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'Review station#3657',
    });
    await emit(page, {
      method: 'content.text-delta',
      turnId: 'turn-1',
      itemId: 'turn-1:text:1',
      delta: 'Starting an independent review.',
    });
    await emit(page, {
      method: 'tool.started',
      turnId: 'turn-1',
      itemId: TOOL_CALL,
      toolCallId: TOOL_CALL,
      toolName: 'Agent',
      arguments: {
        description: runningChild.title,
        prompt: 'Review the ADR freeze PR.',
        subagent_type: 'general-purpose',
        run_in_background: true,
      },
    });
    await emit(page, {
      method: 'child-work.updated',
      delta: {
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: SESSION_ID,
        running: [runningChild],
      },
    });
    await emit(page, {
      method: 'child-work.updated',
      delta: {
        kind: 'upsert',
        item: { ...runningChild, progress: 'Reading the decision records' },
      },
    });
    await emit(page, {
      method: 'tool.completed',
      turnId: 'turn-1',
      itemId: TOOL_CALL,
      toolCallId: TOOL_CALL,
      toolName: 'Agent',
      status: 'success',
      output: 'Async agent launched successfully.',
    });
    await emit(page, {
      method: 'content.text-delta',
      turnId: 'turn-1',
      itemId: 'turn-1:text:2',
      delta: 'The reviewer is running in the background.',
    });
    await emit(page, {
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
    });

    const card = page.getByTestId('subagent-card');
    await expect(card).toHaveCount(1);
    await expect(card.getByText(runningChild.title)).toBeVisible();
    await expect(card.getByText('Running')).toBeVisible();
    await expect(card.getByText('Reading the decision records')).toBeVisible();
    await expect(card.getByText('claude-opus-5-5')).toBeVisible();
    await expect(card.getByText('6:12')).toBeVisible();
    await card.screenshot({
      path: testInfo.outputPath('subagent-card-running-desktop.png'),
    });

    const identity = {
      parent: runningChild.parent,
      title: runningChild.title,
      kindLabel: runningChild.kindLabel,
      model: runningChild.model,
      transcript: runningChild.transcript,
      backgrounded: true,
      depth: 1,
      startedAt: STARTED_AT,
    };
    await emit(page, {
      createdAt: ENDED_AT,
      method: 'child-work.updated',
      delta: {
        kind: 'settle',
        producer: 'engine-subagent',
        reporterThreadId: SESSION_ID,
        childId: 'a1b2c3',
        status: 'completed',
        identity: { ...identity, endedAt: ENDED_AT },
      },
    });
    await emit(page, {
      createdAt: '2026-10-14T14:42:05.000Z',
      method: 'child-work.updated',
      delta: {
        kind: 'settle',
        producer: 'engine-subagent',
        reporterThreadId: SESSION_ID,
        childId: 'a1b2c3',
        status: 'completed',
        result: {
          summary:
            '**Verdict: merge as-is.** I found no blockers. Every required check has passed except build-ios-verification, which is still running.\n\nNo further action needed.',
        },
        usage: { totalTokens: 48_210, toolUses: 37, durationMs: 1_024_000 },
        identity: { ...identity, endedAt: '2026-10-14T14:42:05.000Z' },
      },
    });

    await expect(card.getByText('Completed')).toBeVisible();
    await expect(card.getByText('17:04')).toBeVisible();
    await expect(
      card.getByText(/Verdict: merge as-is\.\*\* I found no blockers/),
    ).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('subagent-card-completed-desktop.png'),
    });

    await card
      .getByRole('button', { name: /review station#3657 ADR freeze/ })
      .click();
    await expect(card.getByText('No further action needed.')).toBeVisible();
    await expect(
      card.getByText('48,210 tokens · 37 tool uses · ran 17:04'),
    ).toBeVisible();
    await card.screenshot({
      path: testInfo.outputPath('subagent-card-expanded-desktop.png'),
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(390);
    // The card's one action keeps the 44px phone floor and stays on screen.
    const viewTranscript = card.getByRole('button', {
      name: 'View transcript',
    });
    const actionBox = await viewTranscript.boundingBox();
    expect(actionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((actionBox?.x ?? -1) >= 0).toBe(true);
    expect((actionBox?.x ?? 0) + (actionBox?.width ?? 0)).toBeLessThanOrEqual(
      390,
    );
    await viewTranscript.click();
    await expect(
      card.getByText('gh pr view 3657 --repo kontourai/station'),
    ).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('subagent-card-expanded-mobile-390.png'),
    });
    await card
      .getByRole('button', { name: /review station#3657 ADR freeze/ })
      .click();
    await expect(card.getByText('No further action needed.')).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('subagent-card-completed-mobile-390.png'),
    });
  });
});
