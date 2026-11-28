import { copyFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { createLongSessionEventWindowHandler } from './fixtures/long-session';
import { mockChatShell } from './helpers/chat-shell-fixture';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  installJourneyProfile,
  profileJourney,
} from './helpers/journey-profile';
import {
  dismissSetupLauncher,
  installMockOrchestrationSse,
  seedActiveChats,
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

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`profiles Inbox refresh while retaining the reader draft and list position at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await installJourneyProfile(page);
    await mockChatShell(page);
    await installMockOrchestrationSse(page);
    await storeConversation(page);
    await seedActiveChats(page, [
      {
        sessionId: THREAD_ID,
        conversationId: THREAD_ID,
        agentSlug: 'station',
        projectSlug: 'default',
        projectName: 'Default',
        model: 'model-selected',
        title: 'Stored pricing review',
        provider: 'bedrock',
        orchestrationSessionStarted: true,
      },
    ]);
    let refreshed = false;
    const sessions = Array.from({ length: 64 }, (_, index) => ({
      threadId: index === 0 ? THREAD_ID : `inbox-refresh-${index}`,
      conversationId: index === 0 ? THREAD_ID : `inbox-refresh-${index}`,
      displayTitle:
        index === 0 ? 'Stored pricing review' : `Inbox chat ${index}`,
      provider: 'bedrock',
      model: 'model-selected',
      projectSlug: 'default',
      assignedAgentSlug: 'station',
      status: 'ready',
      lifecycleState: 'idle',
      answerability: { answerable: true },
      createdAt: UPDATED_AT,
      updatedAt: new Date(
        Date.parse(UPDATED_AT) - index * 60_000,
      ).toISOString(),
      isLoaded: true,
      isPersisted: true,
      eventCount: index === 0 ? 2 : 0,
    }));
    const freshTitle = 'Refreshed Inbox chat 32';
    for (const session of sessions.slice(1)) {
      await page.route(
        `**/api/orchestration/conversations/${session.conversationId}/event-window?*`,
        createLongSessionEventWindowHandler({
          threadId: session.threadId,
          conversationId: session.conversationId,
          provider: session.provider,
          availableTurns: () => [],
        }),
      );
      await page.route(
        `**/api/orchestration/sessions/${session.threadId}/inventory?*`,
        (route) =>
          route.request().method() === 'GET'
            ? route.fulfill({
                ...json({
                  success: false,
                  error: 'Workspace inventory unavailable',
                }),
                status: 503,
              })
            : rejectUnexpectedFixtureRequest(route),
      );
      const history = createLongSessionEventWindowHandler({
        threadId: session.threadId,
        provider: session.provider,
        availableTurns: () => [],
      });
      await page.route(
        `**/api/orchestration/sessions/${session.threadId}/event-window?*`,
        (route) => {
          const query = new URL(route.request().url()).searchParams;
          return route.request().method() === 'GET' &&
            query.get('direction') === 'newest' &&
            query.get('turnLimit') === '1' &&
            !query.has('cursor')
            ? history(route)
            : rejectUnexpectedFixtureRequest(route);
        },
      );
    }
    const currentSessions = () =>
      sessions.map((session, index) =>
        refreshed && index === 32
          ? { ...session, displayTitle: freshTitle }
          : session,
      );
    await page.route('**/api/orchestration/sessions/read-model', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill(json({ success: true, data: currentSessions() }))
        : rejectUnexpectedFixtureRequest(route),
    );
    await page.route(/\/api\/conversations(?:\?.*)?$/, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill(
            json({
              success: true,
              data: {
                items: currentSessions().map((session) => ({
                  id: session.conversationId,
                  source: 'runtime',
                  lifecycleState: session.lifecycleState,
                  agentSlug: 'station',
                  provider: session.provider,
                  model: session.model,
                  projectSlug: 'default',
                  title: session.displayTitle,
                  createdAt: session.createdAt,
                  updatedAt: session.updatedAt,
                  messageCount: session.eventCount,
                  mutable: true,
                  answerability: { answerable: true },
                })),
                hasMore: false,
              },
            }),
          )
        : rejectUnexpectedFixtureRequest(route),
    );
    const waitForReads = (clickedAt?: () => Promise<number>) =>
      Promise.all(
        [
          '/api/orchestration/sessions/read-model',
          '/api/tasks',
          '/api/conversations?limit=100',
          '/api/environments/ssh/sessions',
        ].map(async (endpoint) => {
          const response = await page.waitForResponse(async (response) => {
            const url = new URL(response.url());
            const target = new URL(endpoint, url.origin);
            return (
              response.request().method() === 'GET' &&
              url.pathname === target.pathname &&
              url.search === target.search &&
              response.ok() &&
              (!clickedAt ||
                response.request().timing().startTime >= (await clickedAt()))
            );
          });
          expect(await response.json()).toMatchObject({ success: true });
        }),
      );
    const initialReads = waitForReads();
    await page.goto(`/?chat=${THREAD_ID}&dock=open&maximize=true`);
    await dismissSetupLauncher(page);
    await initialReads;
    const inbox =
      viewport.width === 390
        ? page.getByRole('region', { name: 'Chats', exact: true })
        : page.getByRole('complementary', { name: 'Chats', exact: true });
    const answer = page.getByText(ANSWER, { exact: true });
    await expect(answer).toBeVisible();
    const composer = page.getByRole('textbox', {
      name: 'Message',
      exact: true,
    });
    const draft = 'Keep this reply while refreshing Inbox';
    await composer.fill(draft);
    const readerUrl = page.url();
    const transcriptTop = await answer.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    if (viewport.width === 390)
      await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await expect(inbox).toBeVisible();
    await inbox
      .getByRole('button', {
        name: 'Show more earlier chats and tasks',
        exact: true,
      })
      .click();
    const list = inbox.locator(
      viewport.width === 390
        ? '.mobile-inbox__list'
        : '.chat-dock-inbox__scroll',
    );
    await inbox
      .getByText('Inbox chat 32', { exact: true })
      .scrollIntoViewIfNeeded();
    const scrollTop = await list.evaluate((element) => element.scrollTop);
    expect(scrollTop).toBeGreaterThan(100);
    const trigger = page.getByRole('button', {
      name: viewport.width === 390 ? 'Actions for Chats' : 'More dock actions',
      exact: true,
    });
    await trigger.click();
    const refresh = page.getByRole('menuitem', {
      name: 'Refresh chats',
      exact: true,
    });
    await expect(refresh).toBeVisible();
    const clickObservation = await refresh.evaluateHandle((element) => {
      const observation = { clickedAt: Number.POSITIVE_INFINITY };
      element.addEventListener(
        'click',
        () => {
          observation.clickedAt = performance.timeOrigin + performance.now();
        },
        { capture: true, once: true },
      );
      return observation;
    });
    refreshed = true;
    await profileJourney(
      page,
      testInfo,
      viewport.width === 390 ? 'inbox-refresh-mobile' : 'inbox-refresh',
      { sessions: sessions.length, authoritativeReads: 4 },
      async () => {
        const freshReads = waitForReads(() =>
          clickObservation.evaluate((observation) => observation.clickedAt),
        );
        await refresh.click();
        await freshReads;
        await expect(
          inbox.getByText(freshTitle, { exact: true }),
        ).toBeVisible();
        await expect(inbox.getByText('Updated', { exact: true })).toBeVisible();
        await expect(trigger).toBeFocused();
        expect(
          Math.abs(
            (await list.evaluate((element) => element.scrollTop)) - scrollTop,
          ),
        ).toBeLessThanOrEqual(2);
      },
    );
    await clickObservation.dispose();
    if (viewport.width === 390) {
      await trigger.click();
      await page
        .getByRole('menuitem', { name: 'Back to chat', exact: true })
        .click();
    }
    await expect(page).toHaveURL(readerUrl);
    await expect(composer).toHaveValue(draft);
    await expect(answer).toBeVisible();
    expect(
      Math.abs(
        (await answer.evaluate(
          (element) => element.getBoundingClientRect().top,
        )) - transcriptTop,
      ),
    ).toBeLessThanOrEqual(2);
  });
}

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
      const primary = row.getByRole('button', { name: /^Station session/ });
      const box = await primary.boundingBox();
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
    if (width === 390) {
      await page.getByRole('button', { name: 'Actions for Chats' }).click();
      await page
        .getByRole('menuitem', { name: 'Select conversations' })
        .click();
      await row.getByRole('button', { name: /^Station session/ }).click();
      await page
        .getByRole('region', { name: 'Selected conversations' })
        .getByRole('button', { name: 'Details', exact: true })
        .click();
      const details = page.getByRole('dialog', {
        name: 'Details for Station session',
        exact: true,
      });
      await expect(
        details.getByRole('button', { name: /^In 1 hour/ }),
      ).toBeVisible();
      await testInfo.attach('approval-details', {
        body: await details.screenshot(),
        contentType: 'image/png',
      });
      await details.getByRole('button', { name: 'Close details' }).click();
      await expect(details).toHaveCount(0);
    } else {
      const trigger = row.getByRole('button', {
        name: 'Actions for Station session',
      });
      await row.hover();
      await trigger.click();
      const menu = row.getByRole('menu');
      await expect(
        menu.getByRole('menuitem', { name: /^In 1 hour/ }),
      ).toBeVisible();
      await testInfo.attach('approval-actions', {
        body: await menu.screenshot(),
        contentType: 'image/png',
      });
      await menu.press('Escape');
      await expect(trigger).toBeFocused();
    }
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

for (const theme of ['light', 'dark'] as const) {
  for (const width of [390, 1440] as const) {
    test(`Inbox row actions at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const mobile = width === 390;
      await page.setViewportSize({ width, height: mobile ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await mockChatShell(page);
      await installMockOrchestrationSse(page);
      await storeConversation(page);
      await mockStoredTurnDirectory(page);
      await page.route(/\/api\/me\/preferences(?:\?.*)?$/, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill(
              json({
                success: true,
                data: {
                  schemaVersion: 1,
                  values: { developerToolsEnabled: true },
                },
              }),
            )
          : rejectUnexpectedFixtureRequest(route),
      );
      await page.addInitScript(() => {
        localStorage.setItem(
          'station-device-settings-v1',
          JSON.stringify({
            version: 3,
            values: {
              developerToolsEnabled: true,
              experimentalInboxRowActionsEnabled: true,
            },
          }),
        );
      });
      await page.goto('/?dock=open&maximize=true');
      await dismissSetupLauncher(page);
      await page
        .locator('.station-startup')
        .first()
        .waitFor({ state: 'hidden' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const inbox = mobile
        ? page.getByRole('region', { name: 'Chats', exact: true })
        : page.getByRole('complementary', { name: 'Chats', exact: true });
      const row = inbox.getByRole('button', { name: /^Station session/i });
      await expect(row).toBeVisible();
      const screenshot = (stage: string) =>
        capturePlacement(
          page,
          testInfo,
          `inbox-actions-${width}-${theme}-${stage}`,
        );
      const pinned = inbox.getByRole('region', { name: /^Pinned(?: · 1)?$/ });
      const details = page.getByRole('dialog', {
        name: /^Details for Station session/i,
      });
      if (mobile) {
        const touch = await page.context().newCDPSession(page);
        const hold = async () => {
          await row.scrollIntoViewIfNeeded();
          const bounds = await row.boundingBox();
          if (!bounds) throw new Error('The Inbox row must have bounds');
          await touch.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [
              {
                x: bounds.x + bounds.width / 2,
                y: bounds.y + bounds.height / 2,
              },
            ],
          });
          try {
            await expect(
              page.getByRole('region', { name: 'Selected conversations' }),
            ).toBeVisible();
          } finally {
            await touch.send('Input.dispatchTouchEvent', {
              type: 'touchEnd',
              touchPoints: [],
            });
          }
        };
        try {
          await hold();
          const selection = page.getByRole('region', {
            name: 'Selected conversations',
          });
          for (const button of await selection.getByRole('button').all()) {
            const bounds = await button.boundingBox();
            expect(bounds?.height).toBeGreaterThanOrEqual(44);
            expect(bounds?.width).toBeGreaterThanOrEqual(44);
          }
          await screenshot('selection');
          await selection
            .getByRole('button', { name: 'Pin', exact: true })
            .click();
          await expect(pinned.locator('.inbox-row__open')).toHaveCount(1);
          await screenshot('pinned');
          await hold();
          await selection
            .getByRole('button', { name: 'Details', exact: true })
            .click();
        } finally {
          await touch.detach();
        }
      } else {
        await row.click({ button: 'right' });
        const menu = page.getByRole('menu', {
          name: /^Actions for Station session/i,
        });
        await expect(
          menu.getByRole('menuitem', { name: 'Pin to top' }),
        ).toBeFocused();
        await expect(
          menu.getByRole('menuitem', { name: 'Copy chat ID' }),
        ).toBeVisible();
        await screenshot('menu');
        await menu.getByRole('menuitem', { name: 'Pin to top' }).click();
        await expect(pinned.locator('.inbox-row__open')).toHaveCount(1);
        await screenshot('pinned');
        await row.press('Shift+F10');
        await menu.getByRole('menuitem', { name: 'View details' }).click();
      }
      await expect(details.getByText(THREAD_ID, { exact: true })).toBeVisible();
      await expect(
        details.getByRole('button', { name: 'Copy chat ID' }),
      ).toBeVisible();
      await expect(
        details.getByRole('button', { name: 'Unpin', exact: true }),
      ).toBeVisible();
      await screenshot('details');
      await details.getByRole('button', { name: 'Close details' }).click();
      await expect(row).toBeFocused();
    });
  }
}
