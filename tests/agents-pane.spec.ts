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
let delegateStarted = false;

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
    delegateStarted = false;
    await page.route('**/api/orchestration/sessions/read-model', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            summary(SESSION_ID, { conversationId: CONVERSATION_ID }),
            // A delegate started from the CLI AFTER the page loaded: no
            // parent task, no chat open. `surface: 'cli'` is what the CLI
            // declares since #2459; the server's stamping of it onto the
            // delegate's turn is not exercised here.
            ...(delegateStarted
              ? [
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
                ]
              : []),
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
    // Claude's subagent keeps exactly one Stop, with no duplicate. Since
    // #2533 its `subagentControl` cell is wired and the child-work row
    // carries it. WHICH row carries it is not observable from this count: a
    // TaskRow bridge that failed to retire replaces the child-work row, so
    // the total stays 1. AgentsWorkspacePane.childWork.test.tsx pins that.
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(1);

    await scopeAll.click();
    await expect(scopeAll).toHaveAttribute('aria-pressed', 'true');

    // L1: with the Chat dock gone, the pane alone must keep the session read
    // model fresh. Hide Chat and prove it is not mounted.
    await page.getByRole('button', { name: 'Hide Chat' }).first().click();
    await expect(page.getByRole('region', { name: 'Chat dock' })).toHaveCount(
      0,
    );
    await expect(scopeAll).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Nightly audit')).toHaveCount(0);

    // A CLI delegate starts now: the Station lists it, and its first turn
    // is a read-model fact on the stream.
    delegateStarted = true;
    await emit(page, {
      provider: 'codex',
      threadId: CLI_DELEGATE,
      method: 'turn.started',
      turnId: 'turn-cli-1',
      prompt: 'Nightly audit',
    });
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

    // In All, each running child that has a wired stop seam carries exactly
    // one Stop: the delegate's Station interrupt, and (since #2533 wired
    // Claude's `subagentControl` cell) Claude's subagent. The exited chatless
    // subagent has none.
    const runningRow = (title: string) =>
      page.getByRole('listitem').filter({ hasText: title });
    await expect(
      runningRow('Nightly audit').getByRole('button', { name: 'Stop' }),
    ).toHaveCount(1);
    await expect(
      runningRow('Investigate flaky test').getByRole('button', {
        name: 'Stop',
      }),
    ).toHaveCount(1);
    await expect(
      runningRow('Chatless survey').getByRole('button', { name: 'Stop' }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(2);

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
  /**
   * #2510: a phone has no side region and no desktop More menu, so the
   * header's ⋯ sheet carries the Background tasks row, and on a bottom-only
   * device it opens the Background tasks sheet rather than the Agents pane.
   */
  test.describe('on a phone (#2510)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('the ⋯ sheet opens the Background tasks sheet with the running task', async ({
      page,
    }, testInfo) => {
      await page.goto(
        `/projects/dev/layouts/code?chat=${encodeURIComponent(CONVERSATION_ID)}`,
      );
      await dismissSetupLauncher(page);
      await waitForMockOrchestrationSse(page);

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

      await page
        .getByRole('button', { name: 'Chat actions', exact: true })
        .click();
      const actions = page.getByRole('menu', { name: 'Chat actions' });
      await expect(actions).toBeVisible();
      const row = actions.getByRole('menuitem', {
        name: 'Background tasks — 1 running',
      });
      await expect(row).toBeVisible();
      const box = await row.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await row.click();

      await expect(actions).toBeHidden();
      const sheet = page.getByRole('dialog', { name: 'Background tasks' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText('Investigate flaky test')).toBeVisible();
      // Bottom-only: the sheet, never the Agents pane's scope controls.
      await expect(
        page.getByRole('button', { name: 'This conversation' }),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath('mobile-background-tasks-390.png'),
      });
    });
  });
});
