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
async function storeConversation(page: Page, awaitingApproval = false) {
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

async function mockStoredTurnDirectory(page: Page) {
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

const APPROVAL_REFERENCE = {
  threadId: THREAD_ID,
  requestId: 'approval-stored-1',
  requestEventId: 'approval-open-event-1',
};
const APPROVAL_BODY = 'Allow the agent to write the report to pricing.txt.';

for (const [mode, width, theme, decision] of [
  ['permitted', 390, 'light', 'accept'],
  ['permitted', 390, 'dark', 'accept'],
  ['permitted', 1440, 'light', 'accept'],
  ['permitted', 1440, 'dark', 'decline'],
  ['read-only', 390, 'dark', 'accept'],
  ['missing body', 390, 'dark', 'accept'],
] as const) {
  test(`an Inbox row uses the exact approval inspection when ${mode} (${width}, ${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ colorScheme: theme });
    await mockChatShell(page);
    await installMockOrchestrationSse(page);
    await storeConversation(page, true);
    await mockStoredTurnDirectory(page);
    await page.route('**/api/attention', (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            items: [
              {
                id: 'approval:item-1',
                kind: 'approval',
                title: 'Allow file write',
                requestReference: APPROVAL_REFERENCE,
                source: {
                  notificationId: 'notification-1',
                  notificationSource: 'approval-inbox',
                },
                actions: [],
              },
            ],
            pendingCount: 1,
          },
        }),
      ),
    );
    let attempted = 0;
    await page.route('**/api/orchestration/commands', (route) => {
      const command = route.request().postDataJSON();
      expect(command).toMatchObject({
        type: 'respondToRequest',
        threadId: THREAD_ID,
        requestId: APPROVAL_REFERENCE.requestId,
        expectedRequestEventId: APPROVAL_REFERENCE.requestEventId,
        decision,
      });
      attempted += 1;
      return route.fulfill(json({ success: true }));
    });
    const inspectionPath = `/api/orchestration/sessions/${THREAD_ID}/requests/${APPROVAL_REFERENCE.requestId}`;
    await page.route(
      (url) => url.pathname === inspectionPath,
      (route) => {
        expect(new URL(route.request().url()).searchParams.get('eventId')).toBe(
          APPROVAL_REFERENCE.requestEventId,
        );
        return route.fulfill(
          json({
            success: true,
            data: {
              state: 'open',
              reference: APPROVAL_REFERENCE,
              openedAt: UPDATED_AT,
              requestType: 'approval',
              provider: 'bedrock',
              title: 'Allow file write',
              ...(mode === 'missing body' ? {} : { body: APPROVAL_BODY }),
              answerability: { answerable: true },
              canRespond: mode !== 'read-only',
            },
          }),
        );
      },
    );
    const inspected = page.waitForResponse(
      (response) => new URL(response.url()).pathname === inspectionPath,
    );
    await page.goto('/?dock=open&maximize=true');
    await dismissSetupLauncher(page);
    const inbox =
      width === 390
        ? page.getByRole('region', { name: 'Inbox', exact: true })
        : page.getByRole('complementary', { name: 'Inbox chats', exact: true });
    const row = inbox
      .getByTestId('inbox-row')
      .filter({ hasText: 'Needs approval' });
    await expect(row).toBeVisible();
    await (await inspected).finished();
    await page.locator('.station-startup').first().waitFor({ state: 'hidden' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    if (mode !== 'permitted') {
      await expect(
        row.getByRole('button', { name: /Approve once|Deny/ }),
      ).toHaveCount(0);
      await expect(row.getByText(APPROVAL_BODY)).toHaveCount(0);
      await row
        .getByRole('button', { name: 'Station session, default', exact: true })
        .click();
      await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
      expect(attempted).toBe(0);
      return;
    }
    await expect(row.getByText(APPROVAL_BODY)).toBeVisible();
    if (width === 390) {
      const details = row.getByRole('button', { name: /^Details for/ });
      const box = await details.boundingBox();
      const approvalBox = await row
        .getByRole('button', { name: 'Approve once', exact: true })
        .boundingBox();
      expect(box).not.toBeNull();
      expect(approvalBox).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(approvalBox!.y);
    }
    const screenshot = await row.screenshot();
    await testInfo.attach('approval-row', {
      body: screenshot,
      contentType: 'image/png',
    });
    await row
      .getByRole('button', {
        name: decision === 'accept' ? 'Approve once' : 'Deny',
        exact: true,
      })
      .click();
    await expect(row.getByText('Decision sent.')).toBeVisible();
    expect(attempted).toBe(1);
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
  await mockStoredTurnDirectory(page);

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
