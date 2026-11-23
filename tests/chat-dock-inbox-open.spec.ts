import { copyFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { mockChatShell } from './helpers/chat-shell-fixture';
import { test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  installMockOrchestrationSse,
} from './helpers/orchestration';
import { chooseChatRegionRow } from './helpers/region-placement';
import {
  ANSWER,
  json,
  mockStoredTurnDirectory,
  storeConversation,
  THREAD_ID,
  UPDATED_AT,
} from './helpers/stored-conversation-fixture';

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
        ? page.getByRole('region', { name: 'Chats', exact: true })
        : page.getByRole('complementary', { name: 'Chats', exact: true });
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

/**
 * A conversation the Station keeps, with no chat open for it in this
 * browser: only the inventory names it.
 */
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
  await mockStoredTurnDirectory(page);

  await page.goto('/?dock=open&maximize=true');
  await dismissSetupLauncher(page);
  // With no chat open, the phone dock opens on its Inbox.
  const inbox = page.getByRole('region', { name: 'Chats', exact: true });
  await expect(inbox).toBeVisible();
  // The Station's session row; no chat for it is open in this browser.
  await inbox
    .getByRole('button', { name: /^Station session.*default/ })
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
    name: 'Chats',
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
  await page.mouse.move(0, 0);
  await expect(card).toBeHidden();
  await row.hover();
  await expect(card).toBeVisible();
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
