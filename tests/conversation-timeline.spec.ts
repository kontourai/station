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

test('conversation timeline crosses execution history, preserves the live draft, and forks explicitly', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);
  await seedActiveChats(page, [
    {
      sessionId: 'conversation-timeline',
      conversationId: 'conversation-timeline',
      agentSlug: 'station',
      model: 'gpt-5',
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

  await page.goto('/?dock=open&maximize=true&chat=conversation-timeline');
  await dismissSetupLauncher(page);
  const composer = page.locator('textarea[placeholder*="Type a message"]');
  await composer.fill('Keep this live draft');
  const openHistory = async () => {
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Conversation history' }).click();
  };
  await openHistory();
  await expect(page.getByText('Earlier in this conversation')).toBeVisible();
  await expect(composer).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Conversation section' })
    .selectOption('older-execution');
  await expect(
    page.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText('Earlier question 0');
  await testInfo.attach('historical-conversation-mobile', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: 'Fork from here…' }).click();
  await expect(
    page.getByRole('heading', { name: 'Fork from here' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel fork' }).click();
  await expect(composer).toHaveValue('Keep this live draft');

  await openHistory();
  await page.getByRole('button', { name: 'Previous turn' }).click();
  await page.getByRole('button', { name: 'Return to latest' }).click();
  await expect(composer).toHaveValue('Keep this live draft');
  await testInfo.attach('returned-live-conversation-mobile', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
