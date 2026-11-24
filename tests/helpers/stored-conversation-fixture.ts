import type { Page } from '@playwright/test';
import gallerySessionInventory from '../fixtures/gallery-session-inventory.json' with {
  type: 'json',
};
import { buildLongSessionTurns } from '../fixtures/long-session';
import { rejectUnexpectedFixtureRequest } from './fixture-audit';
import { mockRuntimeConversation } from './runtime-conversation-fixture';

/**
 * One stored Station conversation with no chat open in this browser: the
 * dock's Chats list shows it as a row. Shared by the dock specs.
 */
export const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

export const THREAD_ID = 'thread-stored-conversation';
// Recent, so the inbox lists it among current work rather than history.
export const UPDATED_AT = new Date(Date.now() - 5 * 60_000).toISOString();
const CREATED_AT = new Date(Date.now() - 10 * 60_000).toISOString();
const TITLE = 'Stored pricing review';
export const ANSWER = 'The stored answer is back on screen.';
const PROMPT = 'Review the stored pricing.';

export async function mockStoredTurnDirectory(page: Page) {
  await page.route(
    (url) =>
      url.pathname ===
      `/api/orchestration/session-reads/${THREAD_ID}/turn-directory`,
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill(
            json({
              success: true,
              data: {
                session: {
                  conversationId: THREAD_ID,
                  ...(new URL(route.request().url()).searchParams.get(
                    'includeCount',
                  ) === 'false'
                    ? {}
                    : { turnCount: 1 }),
                },
                turns: [
                  {
                    turnId: 'turn-0',
                    startedAt: '2026-07-19T10:00:00.000Z',
                    request: 'Transcript fixture 0: prompt.',
                    outcome: 'completed',
                  },
                ],
                nextCursor: null,
              },
            }),
          )
        : rejectUnexpectedFixtureRequest(route),
  );
}

export async function storeConversation(page: Page, awaitingApproval = false) {
  // The inbox row is the Station's session; nothing in this browser has a
  // chat open for it.
  await page.route('**/api/orchestration/sessions/read-model', (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            threadId: THREAD_ID,
            conversationId: THREAD_ID,
            provider: 'bedrock',
            model: 'model-selected',
            cwd: '/repo/project',
            projectSlug: 'default',
            assignedAgentSlug: 'station',
            status: 'ready',
            lifecycleState: awaitingApproval ? 'review_pending' : 'idle',
            answerability: { answerable: true },
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
              lifecycleState: awaitingApproval ? 'review_pending' : 'idle',
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
  await page.route(
    `**/api/orchestration/session-reads/${THREAD_ID}/turn-directory*`,
    (route) => {
      if (route.request().method() !== 'GET')
        return rejectUnexpectedFixtureRequest(route);
      const includeCount =
        new URL(route.request().url()).searchParams.get('includeCount') !==
        'false';
      return route.fulfill(
        json({
          success: true,
          data: {
            session: {
              conversationId: THREAD_ID,
              ...(includeCount ? { turnCount: 1 } : {}),
            },
            turns: [
              {
                turnId: 'turn-0',
                startedAt: CREATED_AT,
                request: PROMPT,
                outcome: 'completed',
              },
            ],
            nextCursor: null,
          },
        }),
      );
    },
  );
  await page.route('**/api/coding/git/status**', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          ...json({
            success: false,
            error: 'Git is unavailable for this stored chat fixture',
          }),
          status: 503,
        })
      : rejectUnexpectedFixtureRequest(route),
  );
  // Rebind the captured inventory and its nested references to this chat.
  const { inventory } = JSON.parse(
    JSON.stringify(gallerySessionInventory).replaceAll(
      'gallery-inventory-conversation',
      THREAD_ID,
    ),
  );
  await page.route(
    `**/api/orchestration/sessions/${THREAD_ID}/inventory?**`,
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill(json({ success: true, data: inventory }))
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
        baseTimestamp: CREATED_AT,
        promptText: () => PROMPT,
        replyText: () => ANSWER,
      }),
  });
}
