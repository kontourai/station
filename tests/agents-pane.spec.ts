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
 * #2459: the Agents pane renders child work from the provider-neutral
 * contract, for this conversation and for every conversation.
 *
 * Events arrive through the named orchestration SSE fixture seam
 * (`emitMockOrchestrationEvent`); the session read model is a page-scoped
 * route. The journey is the user's: open the pane from the dock's own
 * "Background tasks" row, then switch scope with the pane's own buttons.
 */

const SESSION_ID = 'session-1';
const CONVERSATION_ID = 'conv-1';
const CLI_DELEGATE = 'delegate-cli-1';
const CHATLESS = 'exec-no-chat-open';

function summary(threadId: string, extra: Record<string, unknown> = {}) {
  return {
    threadId,
    provider: 'claude',
    status: 'running',
    lifecycleState: 'running',
    hasActiveTurn: true,
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    ...extra,
  };
}

async function emit(page: Page, event: Record<string, unknown>) {
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: { createdAt: '2026-09-24T10:00:05.000Z', ...event },
  });
}

test.describe('Agents pane child work (#2459)', () => {
  test.beforeEach(async ({ page }) => {
    await seedActiveChats(page, [
      {
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        agentSlug: 'dev-agent',
        model: 'claude-sonnet',
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
    await page.route('**/api/orchestration/sessions/read-model', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            summary(SESSION_ID, { conversationId: CONVERSATION_ID }),
            // A delegate started from the CLI: no parent task, no chat open.
            summary(CLI_DELEGATE, {
              provider: 'codex',
              turnOrigin: {
                latest: {
                  version: 1,
                  actor: { kind: 'operator' },
                  reported: { version: 1, surface: 'cli', build: null },
                },
                hasOtherOrigins: false,
              },
              childWork: {
                asChild: {
                  producer: 'station-delegate',
                  reporterThreadId: CLI_DELEGATE,
                  childId: CLI_DELEGATE,
                  status: 'running',
                  title: 'Nightly audit',
                  result: {
                    handle: { kind: 'session', threadId: CLI_DELEGATE },
                  },
                  startedAt: '2026-09-24T10:00:00.000Z',
                  controls: { stop: 'delegate-interrupt' },
                },
              },
            }),
          ],
        },
      }),
    );
  });

  test('per chat keeps Claude’s Stop; All shows a CLI delegate and a chatless subagent live, with provenance', async ({
    page,
  }) => {
    await page.goto(
      `/projects/dev/layouts/code?chat=${encodeURIComponent(CONVERSATION_ID)}`,
    );
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);

    // A running Claude subagent on the chat's own session (the legacy tuple
    // is still Claude's live path).
    await emit(page, {
      provider: 'claude',
      threadId: SESSION_ID,
      method: 'extension.notification',
      namespace: 'claude-code',
      type: 'task/registry',
      payload: {
        active: [
          {
            taskId: 'task-1',
            description: 'Investigate flaky test',
            backgrounded: true,
          },
        ],
      },
    });

    await page.getByRole('button', { name: 'More dock actions' }).click();
    await page
      .getByRole('menuitem', { name: /Background tasks — 1 running/ })
      .click();

    const scopeChat = page.getByRole('button', { name: 'This conversation' });
    const scopeAll = page.getByRole('button', { name: 'All', exact: true });
    await expect(scopeChat).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Investigate flaky test')).toBeVisible();
    // Claude's cell is not wired yet: the shipped per-task Stop stays on the
    // pre-contract row.
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(1);

    await scopeAll.click();
    await expect(scopeAll).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Nightly audit')).toBeVisible();
    await expect(page.getByText('Started from the CLI')).toBeVisible();

    // A subagent reported by a session no chat has open arrives live.
    await emit(page, {
      provider: 'codex',
      threadId: CHATLESS,
      method: 'child-work.updated',
      delta: {
        kind: 'upsert',
        item: {
          producer: 'engine-subagent',
          reporterThreadId: CHATLESS,
          childId: 'c-1',
          status: 'running',
          title: 'Chatless survey',
          progress: 'Reading the manifest',
        },
      },
    });
    await expect(page.getByText('Chatless survey')).toBeVisible();
    await expect(page.getByText('Reading the manifest')).toBeVisible();

    // Its end is not an outcome: it reads "No result", never Completed.
    await emit(page, {
      provider: 'codex',
      threadId: CHATLESS,
      method: 'session.exited',
      sessionId: CHATLESS,
    });
    await expect(page.getByText('No result')).toBeVisible();
    await expect(page.getByText('Completed')).toHaveCount(0);

    // Only the delegate's Station interrupt is a Stop in All: Claude's
    // subagent renders from its (unwired) cell and gets none.
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(1);

    // The scope is remembered on this device.
    await page.reload();
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await page.getByRole('button', { name: 'More dock actions' }).click();
    await page.getByRole('menuitem', { name: /Background tasks/ }).click();
    await expect(
      page.getByRole('button', { name: 'All', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
