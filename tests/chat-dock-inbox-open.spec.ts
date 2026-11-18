import { copyFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import gallerySessionInventory from './fixtures/gallery-session-inventory.json' with {
  type: 'json',
};
import { buildLongSessionTurns } from './fixtures/long-session';
import { mockChatShell } from './helpers/chat-shell-fixture';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  installMockOrchestrationSse,
} from './helpers/orchestration';
import { chooseChatRegionRow } from './helpers/region-placement';
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
const PROMPT = 'Review the stored pricing.';

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

async function capturePlacement(page: Page, testInfo: TestInfo, name: string) {
  const directory = process.env.STATION_UI_REVIEW_SCREENSHOT_DIR;
  const screenshot = await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    animations: 'disabled',
  });
  await testInfo.attach(name, { body: screenshot, contentType: 'image/png' });
  if (directory)
    await copyFile(
      testInfo.outputPath(`${name}.png`),
      `${directory}/${name}.png`,
    );
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

test('the desktop Inbox hover card scrolls to Basis in a short window', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 300 });
  await page.emulateMedia({ colorScheme: 'light' });
  await mockChatShell(page);
  await installMockOrchestrationSse(page);
  await storeConversation(page);

  await page.goto('/?dock=open&maximize=true');
  await dismissSetupLauncher(page);
  const inbox = page.locator('#chat-dock').getByRole('complementary', {
    name: 'Inbox chats',
    exact: true,
  });
  const row = inbox.getByRole('button', { name: /^Station session\b/i });
  await row.hover();
  const card = page
    .getByRole('tooltip')
    .filter({ has: page.getByRole('heading', { name: 'Basis', exact: true }) });
  const basis = card.getByRole('region', { name: 'Basis', exact: true });
  await expect(basis).toBeAttached();
  await expect
    .poll(() =>
      card.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return bounds.top >= 8 && bounds.bottom <= window.innerHeight - 8;
      }),
    )
    .toBe(true);
  const cardBox = await card.boundingBox();
  const rowBox = await row.boundingBox();
  if (!cardBox || !rowBox)
    throw new Error('The Inbox row and hover card must have bounds');
  expect(
    await basis.evaluate(
      (node) =>
        node.getBoundingClientRect().bottom >
        node.closest('[role="tooltip"]')!.getBoundingClientRect().bottom,
    ),
  ).toBe(true);
  await capturePlacement(page, testInfo, 'inbox-basis-before-wheel');
  await page.mouse.move(
    cardBox.x + cardBox.width / 2,
    Math.max(cardBox.y + 12, rowBox.y + rowBox.height / 2),
    { steps: 8 },
  );
  await page.mouse.wheel(0, 480);
  await expect
    .poll(() => card.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await expect(basis).toBeInViewport({ ratio: 0.9 });
  await capturePlacement(page, testInfo, 'inbox-basis-scrolled');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
});

test('This chat opens on the roomier side of the actual dock header', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 880, height: 820 });
  await mockChatShell(page);
  await installMockOrchestrationSse(page);
  await storeConversation(page);
  await page.goto('/?dock=open');
  await dismissSetupLauncher(page);

  const dock = page.locator('#chat-dock');
  await dock.getByRole('button', { name: /^Station session\b/i }).click();
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  const chip = dock.getByRole('button', { name: /^This chat(?: — |$)/ });
  const sheet = page.getByRole('dialog', { name: 'This chat' });
  for (const side of ['above', 'below']) {
    await chip.click();
    await expect(sheet).toBeVisible();
    await expect
      .poll(async () => {
        const trigger = await chip.boundingBox();
        const panel = await sheet.boundingBox();
        if (!trigger || !panel) return null;
        const height = page.viewportSize()!.height;
        return {
          roomier:
            trigger.y >= height - (trigger.y + trigger.height)
              ? 'above'
              : 'below',
          placed:
            panel.y >= trigger.y + trigger.height
              ? 'below'
              : panel.y + panel.height <= trigger.y
                ? 'above'
                : 'overlap',
          contained: panel.y >= 0 && panel.y + panel.height <= height,
        };
      })
      .toEqual({ roomier: side, placed: side, contained: true });
    await capturePlacement(page, testInfo, `chat-context-${side}`);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(chip).toBeFocused();
    if (side === 'above') await chooseChatRegionRow(page, 'Maximize');
  }
});
