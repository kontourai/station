import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  openChatRegion,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

const SESSION_ID = 'session-1';
const CONVERSATION_ID = 'conv-1';

async function emit(
  page: Page,
  method: string,
  extra: Record<string, unknown> = {},
) {
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      provider: 'codex',
      threadId: SESSION_ID,
      turnId: 'turn-buffered-1',
      createdAt: '2026-09-20T12:00:00.000Z',
      method,
      ...extra,
    },
  });
}

async function settleBrowserFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test.describe('buffered answer delivery (#585)', () => {
  test.beforeEach(async ({ page }) => {
    await seedActiveChats(page, [
      {
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        agentSlug: 'dev-agent',
        model: 'claude-sonnet',
        provider: 'codex',
        projectSlug: 'dev',
        orchestrationSessionStarted: true,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await installMockOrchestrationEventWindow(page, 'codex', {
      [SESSION_ID]: [
        {
          method: 'turn.started',
          provider: 'codex',
          threadId: SESSION_ID,
          turnId: 'turn-0',
          createdAt: '2026-09-20T11:59:58.000Z',
          prompt: 'Set up the repo',
        },
        {
          method: 'turn.completed',
          provider: 'codex',
          threadId: SESSION_ID,
          turnId: 'turn-0',
          createdAt: '2026-09-20T11:59:59.000Z',
          outputText: 'Ready.',
        },
      ],
    });
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
            {
              threadId: SESSION_ID,
              provider: 'codex',
              status: 'running',
              lifecycleState: 'running',
              hasActiveTurn: true,
              controlMode: 'station-owned',
              answerability: { answerable: true },
              isLoaded: true,
              isPersisted: true,
              eventCount: 2,
              createdAt: '2026-09-20T11:59:58.000Z',
              updatedAt: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
      }),
    );
  });

  test('the device preference reveals at tool, approval, and terminal boundaries and disabling flushes mid-turn', async ({
    page,
  }, testInfo) => {
    await page.goto(
      `/projects/dev/layouts/code?chat=${encodeURIComponent(CONVERSATION_ID)}`,
    );
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);

    await page.getByRole('button', { name: 'More dock actions' }).click();
    await page.getByRole('menuitem', { name: 'Chat settings' }).click();
    const delivery = page.getByLabel('Answer delivery');
    await delivery.selectOption('buffered');
    await expect(delivery).toHaveValue('buffered');
    await page.getByRole('button', { name: 'Done' }).click();

    await emit(page, 'session.started', { sessionId: SESSION_ID });
    await emit(page, 'turn.started', { prompt: 'Buffer this answer.' });
    const transcript = page.getByRole('log', {
      name: 'Conversation transcript',
    });

    await emit(page, 'content.text-delta', {
      itemId: 'answer-1',
      delta: 'Visible at tool boundary.',
    });
    // Give the mocked fetch-SSE reader several paint opportunities. The
    // absence is meaningful only after the frame has crossed into the app.
    await settleBrowserFrames(page);
    await expect(transcript.getByText('Visible at tool boundary.')).toHaveCount(
      0,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const heldMobilePath = testInfo.outputPath(
      'buffered-answer-held-mobile.png',
    );
    await page.screenshot({ path: heldMobilePath, fullPage: true });
    await emit(page, 'tool.started', {
      itemId: 'tool-1',
      toolCallId: 'call-1',
      toolName: 'read_file',
      arguments: { path: 'README.md' },
    });
    await expect(transcript).toContainText('Visible at tool boundary.');
    const toolMobilePath = testInfo.outputPath(
      'buffered-answer-tool-boundary-mobile.png',
    );
    await page.screenshot({ path: toolMobilePath, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });

    await emit(page, 'content.text-delta', {
      itemId: 'answer-1',
      delta: ' Visible at approval boundary.',
    });
    await settleBrowserFrames(page);
    await expect(transcript).not.toContainText('Visible at approval boundary.');
    await emit(page, 'request.opened', {
      requestId: 'approval-1',
      requestType: 'tool-approval',
      title: 'Approve tool use',
      payload: { toolName: 'read_file' },
    });
    await expect(transcript).toContainText('Visible at approval boundary.');
    await expect(
      page.getByRole('button', { name: '1 pending approval' }),
    ).toBeVisible();

    await emit(page, 'content.text-delta', {
      itemId: 'answer-1',
      delta: ' Visible at completion.',
    });
    await settleBrowserFrames(page);
    await expect(transcript).not.toContainText('Visible at completion.');
    await emit(page, 'turn.completed', {
      finishReason: 'stop',
      outputText:
        'Visible at tool boundary. Visible at approval boundary. Visible at completion.',
    });
    await expect(transcript).toContainText('Visible at completion.');
    await expect(
      transcript.getByText(
        'Visible at tool boundary. Visible at approval boundary. Visible at completion.',
        { exact: true },
      ),
    ).toHaveCount(1);

    await emit(page, 'turn.started', {
      turnId: 'turn-buffered-2',
      prompt: 'Switch delivery modes.',
    });
    await emit(page, 'content.text-delta', {
      turnId: 'turn-buffered-2',
      itemId: 'answer-2',
      delta: 'Flushed by disabling.',
    });
    await settleBrowserFrames(page);
    await expect(transcript).not.toContainText('Flushed by disabling.');

    await page.getByRole('button', { name: 'More dock actions' }).click();
    await page.getByRole('menuitem', { name: 'Chat settings' }).click();
    await page.getByLabel('Answer delivery').selectOption('token');
    await expect(transcript).toContainText('Flushed by disabling.');
    await page.getByRole('button', { name: 'Done' }).click();

    await emit(page, 'content.text-delta', {
      turnId: 'turn-buffered-2',
      itemId: 'answer-2',
      delta: ' Then immediate.',
    });
    await expect(transcript).toContainText(
      'Flushed by disabling. Then immediate.',
    );
    const screenshotPath = testInfo.outputPath('buffered-answer-delivery.png');
    const observationPath = testInfo.outputPath(
      'buffered-answer-delivery.json',
    );
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });
    await writeFile(
      observationPath,
      `${JSON.stringify(
        {
          preference: 'token',
          observedBoundaries: [
            'tool.started',
            'request.opened',
            'turn.completed',
          ],
          midTurnDisableFlushed: true,
          finalTranscript: 'Flushed by disabling. Then immediate.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const evidenceRoot = join(process.cwd(), '.kontourai', 'chat-563');
    await mkdir(evidenceRoot, { recursive: true });
    await Promise.all([
      copyFile(
        screenshotPath,
        join(evidenceRoot, 'buffered-answer-delivery.png'),
      ),
      copyFile(
        heldMobilePath,
        join(evidenceRoot, 'buffered-answer-held-mobile.png'),
      ),
      copyFile(
        toolMobilePath,
        join(evidenceRoot, 'buffered-answer-tool-boundary-mobile.png'),
      ),
      copyFile(
        observationPath,
        join(evidenceRoot, 'buffered-answer-delivery.json'),
      ),
    ]);
  });
});
