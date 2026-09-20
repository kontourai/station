import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expect } from '@playwright/test';
import { buildLongSessionTurns } from './fixtures/long-session';
import { mockChatShell } from './helpers/chat-shell-fixture';
import { test } from './helpers/fixture-audit';
import { dismissSetupLauncher, seedActiveChats } from './helpers/orchestration';
import { mockRuntimeConversation } from './helpers/runtime-conversation-fixture';

const json = (data: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ success: true, data }),
});

test('conversation timeline restores a checkpoint with bounded refusal copy', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);
  await seedActiveChats(page, [
    {
      sessionId: 'restore-chat',
      conversationId: 'restore-chat',
      agentSlug: 'station',
      title: 'Restore fixture',
      model: 'gpt-5',
      provider: 'codex',
      orchestrationSessionStarted: true,
    },
    {
      sessionId: 'conversation-timeline',
      conversationId: 'conversation-timeline',
      agentSlug: 'station',
      provider: 'codex',
      agentConnectionId: 'codex',
      model: 'gpt-5',
      requestedModel: 'gpt-5',
      projectSlug: 'default',
      projectName: 'Default',
      orchestrationSessionStarted: true,
      orchestrationStatus: 'closed',
      orchestrationTurnOpen: false,
      messages: [],
      ephemeralMessages: [],
    },
  ]);
  const currentTurns = buildLongSessionTurns({
    threadId: 'conversation-timeline',
    provider: 'codex',
    turnCount: 30,
    promptText: (index) => `Current question ${index}`,
  });
  const oldTurns = buildLongSessionTurns({
    threadId: 'older-execution',
    provider: 'codex',
    turnCount: 3,
    promptText: (index) => `Earlier question ${index}`,
  });
  const restoreTurns = buildLongSessionTurns({
    threadId: 'restore-chat',
    provider: 'codex',
    turnCount: 30,
    replyText: () => 'Checkpoint restore fixture.',
  });
  await mockRuntimeConversation(page, {
    id: 'restore-chat',
    agentSlug: 'station',
    title: 'Restore fixture',
    provider: 'codex',
    model: 'gpt-5',
    canContinue: true,
    turns: () => restoreTurns,
  });
  await mockRuntimeConversation(page, {
    id: 'conversation-timeline',
    agentSlug: 'station',
    title: 'Timeline fixture',
    provider: 'codex',
    model: 'gpt-5',
    canContinue: true,
    turns: () => currentTurns,
  });
  await page.route('**/api/conversations/conversation-timeline', (route) =>
    route.fulfill(
      json({
        id: 'conversation-timeline',
        agentSlug: 'station',
        title: 'Timeline fixture',
      }),
    ),
  );
  await page.route('**/api/conversations/restore-chat', (route) =>
    route.fulfill(
      json({
        id: 'restore-chat',
        agentSlug: 'station',
        title: 'Restore fixture',
      }),
    ),
  );
  await page.route(
    '**/api/orchestration/conversations/conversation-timeline/event-window**',
    (route) => {
      const requestedLimit = Number(
        new URL(route.request().url()).searchParams.get('turnLimit') ?? '10',
      );
      const pageTurns = currentTurns.slice(-requestedLimit);
      return route.fulfill(
        json({
          protocolVersion: 1,
          conversationId: 'conversation-timeline',
          currentSessionId: 'conversation-timeline',
          session: { threadId: 'conversation-timeline', status: 'idle' },
          sessionLineage: [
            {
              sessionId: 'older-execution',
              agentSlug: 'station',
              agentDisplayName: 'Station',
            },
            {
              sessionId: 'conversation-timeline',
              agentSlug: 'station',
              agentDisplayName: 'Station',
            },
          ],
          handoffs: [],
          contextBoundaries: [],
          events: pageTurns.flat().map((event, index) => ({
            sequence:
              currentTurns.flat().length - pageTurns.flat().length + index + 1,
            event,
          })),
          hasMore: requestedLimit < currentTurns.length,
          nextCursor:
            requestedLimit < currentTurns.length ? 'older-turns-10' : undefined,
          watermark: currentTurns.length,
        }),
      );
    },
  );
  await page.route(
    (url) =>
      url.pathname.startsWith('/api/orchestration/sessions/') &&
      url.pathname.endsWith('/checkpoints'),
    (route) =>
      route.fulfill(
        json([
          {
            turnId: 'turn-29',
            changedFiles: {
              status: 'available',
              files: [{ status: 'modified', path: 'src/app.ts' }],
            },
          },
        ]),
      ),
  );
  let restoreAttempts = 0;
  await page.route(
    '**/api/orchestration/sessions/restore-chat/checkpoints/turn-29/restore-preview',
    (route) =>
      route.fulfill(
        json({
          previewId: `11111111-1111-4111-8111-${String(restoreAttempts + 1).padStart(12, '0')}`,
          threadId: 'restore-chat',
          turnId: 'turn-29',
          phase: 'settle',
          checkpointId: 'checkpoint-29',
          repoRoot: '/fixture/repo',
          targetTreeSha: 'a'.repeat(40),
          targetCommitSha: 'c'.repeat(40),
          currentTreeSha: 'b'.repeat(40),
          paths: [{ status: 'M', path: 'src/app.ts' }],
          pathsTruncated: false,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
  );
  await page.route(
    '**/api/orchestration/sessions/restore-chat/checkpoints/turn-29/restore',
    (route) => {
      restoreAttempts += 1;
      return route.fulfill(
        restoreAttempts === 1
          ? {
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({
                success: false,
                error: 'Workspace checkpoint restore failed',
                reason: 'workspace_changed',
              }),
            }
          : json({ restored: true }),
      );
    },
  );
  await page.route(
    /\/api\/orchestration\/sessions\/(conversation-timeline|older-execution)\/event-page(?:\?.*)?$/,
    (route) => {
      const threadId = decodeURIComponent(
        new URL(route.request().url()).pathname.split('/').at(-2)!,
      );
      const events = (
        threadId === 'older-execution' ? oldTurns : currentTurns
      ).flat();
      return route.fulfill(
        json({
          session: { model: 'gpt-5' },
          events: events.map((event, index) => ({
            sequence: index + 1,
            event,
          })),
          nextSequence: events.length,
          hasMore: false,
        }),
      );
    },
  );

  await page.goto('/?dock=open&maximize=true&chat=restore-chat');
  await dismissSetupLauncher(page);
  const restoreAnswer = page
    .locator('[id="transcript-message-turn-29-started%3Aassistant"]')
    .locator('.message-row');
  await restoreAnswer
    .getByRole('button', { name: 'Answer details and actions' })
    .click();
  await page.getByText('1 changed file').click();
  await page
    .getByRole('button', { name: 'Restore workspace to here…' })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('src/app.ts');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByRole('button', { name: 'Restore workspace to here…' })
    .click();
  await page
    .getByRole('button', { name: 'Restore workspace', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveText(
    'The workspace changed after the preview. Review a new preview. No files were changed.',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByRole('button', { name: 'Restore workspace to here…' })
    .click();
  await page
    .getByRole('button', { name: 'Restore workspace', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(restoreAttempts).toBe(2);

  const evidenceRoot = join(
    process.cwd(),
    '.kontourai',
    'chat-563',
    basename(process.env.STATION_E2E_OUTPUT_DIR ?? 'manual'),
  );
  mkdirSync(evidenceRoot, { recursive: true });
  await page.screenshot({
    path: testInfo.outputPath('timeline-workspace-restore-success.png'),
    animations: 'disabled',
  });
  copyFileSync(
    testInfo.outputPath('timeline-workspace-restore-success.png'),
    join(evidenceRoot, 'timeline-workspace-restore-success.png'),
  );
});
