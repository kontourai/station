import { expect, type Locator, type Page } from '@playwright/test';
import { openDesktopBackgroundTasks } from './helpers/chat-inventory';
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

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/**
 * A row's actions never cover its text, and its title is not crushed: every
 * text line's box is clear of every action's box, and the title keeps room
 * for more than a couple of letters.
 */
async function expectActionsClearOfText(row: Locator) {
  const texts = row.locator(
    '.child-work-row__title, .child-work-row__meta, .child-work-row__model, .child-work-activity, .child-work-row__provenance, .work-status-pill, .background-tasks-sheet__title, .background-tasks-sheet__meta',
  );
  const actions = row.locator(
    '.child-work-row__actions button, .background-tasks-sheet__task-footer button',
  );
  const textBoxes = (await texts.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  )) as Box[];
  const actionBoxes = (await actions.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  )) as Box[];
  for (const action of actionBoxes)
    for (const text of textBoxes) expect(overlaps(action, text)).toBe(false);
  const title = await row
    .locator('.child-work-row__title, .background-tasks-sheet__title')
    .first()
    .boundingBox();
  expect(title?.width ?? 0).toBeGreaterThan(120);
  // Every line stays inside the text column: a nowrap line that is not a
  // block of its own runs past the column, under the pill and the actions.
  const overflowing = await row
    .locator('.child-work-row__text, .background-tasks-sheet__row-text')
    .evaluateAll((columns) =>
      columns.flatMap((column) => {
        const edge = column.getBoundingClientRect().right + 1;
        return [...column.querySelectorAll('*')]
          .filter((node) => node.getBoundingClientRect().right > edge)
          .map((node) => node.className);
      }),
    );
  expect(overflowing).toEqual([]);
  // The latest tool's name ("Read") is shown whole, not cut to "R…".
  const clipped = await row
    .locator('.child-work-activity__name')
    .evaluateAll(
      (nodes) =>
        nodes.filter(
          (node) =>
            (node as HTMLElement).scrollWidth >
            (node as HTMLElement).clientWidth + 1,
        ).length,
    );
  expect(clipped).toBe(0);
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
    await page.route('**/api/agents', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            { slug: 'dev-agent', name: 'Dev Agent' },
            { slug: 'owl', name: 'Owl', icon: '🦉' },
          ],
        },
      }),
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
                    assignedAgentSlug: 'owl',
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
  }, testInfo) => {
    // Home, not the Coding layout: this journey hides the Chat DOCK to prove
    // the pane alone keeps the read model fresh, and on a wide screen the
    // Coding layout's Chat is its centre, not a dock (#928 coding stack).
    await page.goto(`/?chat=${encodeURIComponent(CONVERSATION_ID)}`);
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

    await openDesktopBackgroundTasks(page);

    const scopeChat = page.getByRole('button', {
      name: 'This chat',
      exact: true,
    });
    const scopeAll = page.getByRole('button', {
      name: 'All chats',
      exact: true,
    });
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
    await expect(page.getByText(/^Recorded origin: CLI/)).toBeVisible();
    const delegateRow = page
      .getByRole('listitem')
      .filter({ hasText: 'Nightly audit' });
    await expect(
      delegateRow.getByRole('img', { name: 'Owl · Codex' }),
    ).toContainText('🦉');
    await expect(
      delegateRow.locator(
        '.child-work-identity__engine [data-brand-key="codex"]',
      ),
    ).toBeVisible();
    await emit(page, {
      provider: 'codex',
      threadId: CLI_DELEGATE,
      method: 'tool.started',
      turnId: 'turn-cli-1',
      itemId: 'cli-read',
      toolCallId: 'cli-read',
      toolName: 'Read',
      arguments: {},
    });
    await expect(delegateRow.locator('.child-work-activity__name')).toHaveText(
      'Read',
    );
    await delegateRow.screenshot({
      path: testInfo.outputPath('agents-delegate-artwork-activity.png'),
    });

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

    const childRow = runningRow('Investigate flaky test');
    await expectActionsClearOfText(childRow);
    await childRow.screenshot({
      path: testInfo.outputPath('agents-row-actions.png'),
    });

    // The scope is remembered on this device.
    await page.reload();
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    // The region keeps the Agents pane it showed; open it only if it did not.
    const agentsPane = page.locator('.agents-pane');
    await agentsPane
      .waitFor({ state: 'visible', timeout: 5_000 })
      .catch(() => undefined);
    if (!(await agentsPane.isVisible())) await openDesktopBackgroundTasks(page);
    await expect(
      page.getByRole('button', { name: 'All chats', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
  /**
   * The owner's 2026-11-16 screenshot: a ~380px Agents pane with many
   * running Claude subagents, where the title collapsed to one letter and
   * "Open chat" / "Stop" sat on the model and elapsed time. Seeded with long
   * titles, models and latest tools, plus tool calls from this chat and
   * another, then laid out at 380px and 600px in dark theme.
   */
  test('running rows keep their text clear of actions at 380px and 600px, and All groups by chat', async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`/?chat=${encodeURIComponent(CONVERSATION_ID)}`);
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);

    const subagent = (childId: string, title: string, kindLabel: string) => ({
      producer: 'engine-subagent',
      reporterThreadId: SESSION_ID,
      childId,
      status: 'running',
      title,
      kindLabel,
      startedAt: '2026-09-24T09:52:00.000Z',
      model: { id: 'claude-opus-5-5', source: 'subagent-reply' },
      latestTool: 'Read',
      progress: 'Reading src-server/services/orchestration/event-store.ts',
      controls: { stop: 'provider-task-stop' },
      // A transcript ref the contract accepts, so the row offers Open chat
      // beside Stop, as in the screenshot.
      transcript: {
        kind: 'claude-subagent',
        sessionId: '5f0c7e1a-2b3d-4c5e-8f90-1a2b3c4d5e6f',
        agentId: childId,
      },
    });
    await emit(page, {
      provider: 'claude',
      threadId: SESSION_ID,
      method: 'child-work.updated',
      delta: {
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: SESSION_ID,
        running: [
          subagent(
            'sub-1',
            'Inventory event-row readers for retention and replay',
            'Explore',
          ),
          subagent(
            'sub-2',
            'Reproduce the overwhelmed-server report under load',
            'general-purpose',
          ),
          subagent(
            'sub-3',
            'Profile the station process tree and its child engines',
            'general-purpose',
          ),
        ],
      },
    });
    const tool = (threadId: string, toolCallId: string, description: string) =>
      emit(page, {
        provider: 'claude',
        threadId,
        method: 'tool.started',
        turnId: 'turn-1',
        itemId: toolCallId,
        toolCallId,
        toolName: 'Bash',
        arguments: { description, command: 'npm run gate:for -- src-ui' },
      });
    await tool(SESSION_ID, 'call-gate', 'Run gate:for on paths to edit');
    await tool(
      SESSION_ID,
      'call-telemetry',
      'Run telemetry tests after change',
    );
    // Another chat's tool call: All lists it, under that chat.
    await tool('session-other', 'call-release', 'Build the release candidate');

    // Under load the control can re-render while it opens (its row detaches
    // mid-click); open it again until the pane is on screen. The pane, not
    // the control, is what this journey checks. `openDesktopBackgroundTasks`
    // finds Background tasks wherever the dock puts it (#5076).
    const pane = page.locator('.agents-pane');
    await expect(async () => {
      if (await pane.isVisible()) return;
      await page.keyboard.press('Escape');
      await openDesktopBackgroundTasks(page);
      await expect(pane).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    // The side dock at the owner's pane width, whatever it opened at.
    const setPaneWidth = (px: number) =>
      page.locator('.agents-pane').evaluate((node, width) => {
        // The pane and every box up to its dock, which otherwise keep the
        // width the dock opened at.
        for (
          let box: HTMLElement | null = node as HTMLElement;
          box && !box.classList.contains('app__main');
          box = box.parentElement
        ) {
          box.style.width = `${width}px`;
          box.style.minWidth = `${width}px`;
          box.style.maxWidth = `${width}px`;
          box.style.flex = `0 0 ${width}px`;
          if (box.classList.contains('chat-dock')) {
            // Pinned to the window's right edge, so a wider dock grows into
            // the page instead of past the viewport.
            box.style.position = 'fixed';
            box.style.right = '0';
            box.style.top = '0';
            box.style.bottom = '0';
            box.style.zIndex = '10';
            break;
          }
        }
      }, px);
    await expect(
      page.getByRole('heading', { name: 'Running · 3 agents · 2 tools' }),
    ).toBeVisible();

    for (const width of [380, 600]) {
      await setPaneWidth(width);
      await expect
        .poll(() =>
          pane
            .locator('.background-tasks-sheet__list')
            .first()
            .evaluate(
              (node) => (node as HTMLElement).getBoundingClientRect().right,
            ),
        )
        .toBeGreaterThan(
          await pane.evaluate(
            (node, w) =>
              (node as HTMLElement).getBoundingClientRect().left + w - 40,
            width,
          ),
        );
      // Reachability: the subagent rows carry BOTH actions, as in the
      // screenshot, so the check below meets the crowded case.
      await expect(
        page
          .getByRole('listitem')
          .filter({
            hasText: 'Inventory event-row readers for retention and replay',
          })
          .getByRole('button', { name: 'Open chat' }),
      ).toBeVisible();
      for (const title of [
        'Inventory event-row readers for retention and replay',
        'Reproduce the overwhelmed-server report under load',
        'Run gate:for on paths to edit',
      ])
        await expectActionsClearOfText(
          page.getByRole('listitem').filter({ hasText: title }),
        );
      await pane.screenshot({
        path: testInfo.outputPath(`agents-pane-chat-${width}-dark.png`),
      });
    }

    await page.getByRole('button', { name: 'All chats', exact: true }).click();
    // This chat's group first, then the other chat's.
    await expect(page.locator('.agents-pane__group')).toHaveCount(2);
    await expect(
      page
        .locator('.agents-pane__group')
        .first()
        .locator('.agents-pane__group-meta'),
    ).toContainText('This chat');
    await expect(page.getByText('Build the release candidate')).toBeVisible();
    for (const width of [600, 380]) {
      await setPaneWidth(width);
      await expectActionsClearOfText(
        page.getByRole('listitem').filter({
          hasText: 'Inventory event-row readers for retention and replay',
        }),
      );
      await pane.screenshot({
        path: testInfo.outputPath(`agents-pane-all-${width}-dark.png`),
      });
    }
    // The same list in light theme, for the record.
    await page.emulateMedia({ colorScheme: 'light' });
    for (const width of [600, 380]) {
      await setPaneWidth(width);
      await expectActionsClearOfText(
        page.getByRole('listitem').filter({
          hasText: 'Inventory event-row readers for retention and replay',
        }),
      );
      await pane.screenshot({
        path: testInfo.outputPath(`agents-pane-all-${width}-light.png`),
      });
    }
  });

  /** #2510: the real Chat action opens the retained-work sheet on a
   * bottom-only device, including a wide coarse-pointer device. */
  for (const { width, height } of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    for (const theme of ['dark', 'light'] as const) {
      test.describe(`background tasks sheet ${width} ${theme}`, () => {
        test.use({ viewport: { width, height }, hasTouch: true });
        test('opens the running task with keyboard and returns focus on Escape', async ({
          page,
        }, testInfo) => {
          await page.emulateMedia({ colorScheme: theme });
          await page.goto(
            `/projects/dev/layouts/code?chat=${encodeURIComponent(CONVERSATION_ID)}`,
          );
          await dismissSetupLauncher(page);
          await waitForMockOrchestrationSse(page);
          await expect(page.locator('html')).toHaveAttribute(
            'data-theme',
            theme,
          );
          expect(
            await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
          ).toBe(true);
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

          const trigger =
            width === 390
              ? page.getByRole('button', { name: 'Chat actions', exact: true })
              : page.getByRole('button', { name: /^More dock actions/ });
          await expect(trigger).toBeVisible();
          await expect(trigger).toBeEnabled();
          for (
            let i = 0;
            i < 80 &&
            !(await trigger.evaluate((el) => el === document.activeElement));
            i++
          ) {
            await page.keyboard.press('Tab');
          }
          await expect(trigger).toBeFocused();
          await page.keyboard.press('Enter');
          const row = page.getByRole('menuitem', {
            name: 'Background tasks — 1 running',
          });
          await expect(row).toBeVisible();
          await expect(row).toBeEnabled();
          if (width === 390) {
            const box = await row.boundingBox();
            expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
          }
          for (
            let i = 0;
            i < 80 &&
            !(await row.evaluate((el) => el === document.activeElement));
            i++
          ) {
            await page.keyboard.press(width === 390 ? 'Tab' : 'ArrowDown');
          }
          await expect(row).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(row).toBeHidden();
          const sheet = page.getByRole('dialog', { name: 'Background tasks' });
          await expect(sheet).toBeVisible();
          await expect(sheet.getByText('Investigate flaky test')).toBeVisible();
          await expect(sheet.locator('footer')).toHaveText(
            'Recent tasks only.',
          );
          await expect(
            page.getByRole('button', { name: 'This chat', exact: true }),
          ).toHaveCount(0);
          await expect(page.locator('html')).toHaveAttribute(
            'data-theme',
            theme,
          );
          const screenshotName = `background-tasks-${width}-${theme}.png`;
          await page.screenshot({
            path: testInfo.outputPath(`background-tasks-${width}-${theme}.png`),
            animations: 'disabled',
          });
          await testInfo.attach(screenshotName, {
            path: testInfo.outputPath(screenshotName),
            contentType: 'image/png',
          });
          await page.keyboard.press('Escape');
          await expect(sheet).toBeHidden();
          await expect(trigger).toBeFocused();
        });
      });
    }
  }
});
