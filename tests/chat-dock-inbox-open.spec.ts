import { expect, type Page } from '@playwright/test';
import { buildLongSessionTurns } from './fixtures/long-session';
import { mockChatShell } from './helpers/chat-shell-fixture';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
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
// Recent, so the inbox lists it among current work rather than history.
const UPDATED_AT = new Date(Date.now() - 5 * 60_000).toISOString();
const CREATED_AT = new Date(Date.now() - 10 * 60_000).toISOString();
const TITLE = 'Stored pricing review';
const ANSWER = 'The stored answer is back on screen.';

/**
 * A conversation the Station keeps, with no chat open for it in this
 * browser: only the inventory names it.
 */
async function storeConversation(page: Page) {
  // The inbox row is the Station's session; nothing in this browser has a
  // chat open for it.
  await page.route('**/api/orchestration/sessions/read-model', (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            threadId: THREAD_ID,
            provider: 'bedrock',
            model: 'model-selected',
            cwd: '/repo/project',
            projectSlug: 'default',
            assignedAgentSlug: 'station',
            status: 'ready',
            lifecycleState: 'idle',
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
            isLoaded: true,
            isPersisted: true,
            eventCount: 2,
          },
        ],
      }),
    ),
  );
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
              createdAt: CREATED_AT,
              updatedAt: UPDATED_AT,
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
            updatedAt: UPDATED_AT,
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
  // What an open chat reads next, as each route answers a conversation that
  // has none of it: no Project chat layer (the client's own 404 meaning),
  // no terminal runs, and nothing scheduled.
  await page.route('**/api/projects/default/chat-defaults', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Not found' }),
        })
      : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) =>
      url.pathname === '/api/terminal/runs' &&
      url.searchParams.get('conversationId') === THREAD_ID,
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill(json({ success: true, data: { runs: [] } }))
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    `**/api/orchestration/agent-schedule/${THREAD_ID}`,
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill(
            json({
              success: true,
              data: { wakeUps: [], jobProposals: [], jobs: [] },
            }),
          )
        : rejectUnexpectedFixtureRequest(route),
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
  // With no chat open, the phone dock opens on its Inbox.
  const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
  await expect(inbox).toBeVisible();
  // The Station's session row; no chat for it is open in this browser.
  await inbox
    .getByRole('button', { name: 'Station session, default', exact: true })
    .click();

  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(page.getByText('No chat open', { exact: true })).toHaveCount(0);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('chat'))
    .not.toBeNull();
});
