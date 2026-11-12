import { expect, type Page } from '@playwright/test';
import { buildLongSessionTurns } from './fixtures/long-session';
import { mockChatShell } from './helpers/chat-shell-fixture';
import { test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  installMockOrchestrationSse,
} from './helpers/orchestration';
import { mockRuntimeConversation } from './helpers/runtime-conversation-fixture';

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const THREAD_ID = 'thread-stored-conversation';
const TITLE = 'Stored pricing review';
const ANSWER = 'The stored answer is back on screen.';

/**
 * A conversation the Station keeps, with no chat open for it in this
 * browser: only the inventory names it.
 */
async function storeConversation(page: Page) {
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) =>
    route.fulfill(
      json({
        success: true,
        data: {
          items: [
            {
              id: THREAD_ID,
              source: 'runtime',
              agentSlug: 'station',
              provider: 'bedrock',
              model: 'model-selected',
              projectSlug: 'default',
              title: TITLE,
              createdAt: '2026-09-20T00:02:00.000Z',
              updatedAt: '2026-09-20T00:03:00.000Z',
              messageCount: 2,
              mutable: true,
              answerability: { answerable: true },
            },
          ],
          hasMore: false,
        },
      }),
    ),
  );
  await page.route(/\/agents\/station\/conversations(?:\?.*)?$/, (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            id: THREAD_ID,
            title: TITLE,
            agentSlug: 'station',
            updatedAt: '2026-09-20T00:03:00.000Z',
          },
        ],
      }),
    ),
  );
  await page.route(
    new RegExp(`/api/conversations/${THREAD_ID}(?:\\?.*)?$`),
    (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            id: THREAD_ID,
            agentSlug: 'station',
            projectSlug: 'default',
            title: TITLE,
          },
        }),
      ),
  );
  await page.route(
    `**/api/conversations/${THREAD_ID}/acknowledgement`,
    (route) => route.fulfill(json({ success: true })),
  );
  await mockRuntimeConversation(page, {
    id: THREAD_ID,
    agentSlug: 'station',
    title: TITLE,
    provider: 'bedrock',
    model: 'model-selected',
    projectSlug: 'default',
    canContinue: true,
    turns: () =>
      buildLongSessionTurns({
        threadId: THREAD_ID,
        turnCount: 1,
        replyText: () => ANSWER,
      }),
  });
}

// #4814: opening a stored conversation binds a new dock chat to its inbox
// row, which sets the row's `chatSessionId`. The selection must still be
// current after that bind, or the open is cancelled and nothing appears.
test('an inbox row for a stored conversation with no open chat opens its transcript', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);
  await installMockOrchestrationSse(page);
  await storeConversation(page);

  await page.goto('/?dock=open&maximize=true');
  await dismissSetupLauncher(page);
  await page.getByRole('button', { name: /^(Inbox|Back to chat)$/ }).click();
  const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
  await inbox.getByRole('button', { name: `${TITLE}, default` }).click();

  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(page.getByText('No chat open', { exact: true })).toHaveCount(0);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('chat'))
    .not.toBeNull();
});
