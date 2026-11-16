import {
  expect,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  DEFAULT_CONVERSATION_LOOKUPS,
  DEFAULT_CONVERSATIONS,
  dismissSetupLauncher,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

/**
 * A conversation opened from the notification panel while the dock shows
 * another: the dock names what is opening and covers the previous one, a
 * refused conversation says why, and an imported conversation keeps its own
 * header and Continue over the pending open.
 */

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;
const NOW = '2026-11-16T12:00:00.000Z';
const LATER = '2026-11-16T12:00:01.000Z';
const ATTACHED = 'external:claude:notification-reader';
const IMPORTED_TITLE = 'Imported design notes';

const turn = (
  threadId: string,
  provider: string,
  prompt: string,
  reply: string,
) => [
  {
    method: 'turn.started',
    provider,
    threadId,
    turnId: `${threadId}-turn`,
    createdAt: NOW,
    prompt,
  },
  {
    method: 'turn.completed',
    provider,
    threadId,
    turnId: `${threadId}-turn`,
    createdAt: LATER,
    outputText: reply,
  },
];

const ownedSession = (threadId: string) => ({
  threadId,
  provider: 'codex',
  status: 'ready',
  lifecycleState: 'idle',
  hasActiveTurn: false,
  controlMode: 'station-owned',
  answerability: { answerable: true },
  isLoaded: true,
  isPersisted: true,
  eventCount: 2,
  createdAt: NOW,
  updatedAt: LATER,
});

// The attached-session summary shape conversation-surfaces.spec.ts uses.
const attachedSession = {
  threadId: ATTACHED,
  provider: 'claude',
  displayTitle: IMPORTED_TITLE,
  controlMode: 'read-only-attached',
  status: 'ready',
  lifecycleState: 'idle',
  hasActiveTurn: false,
  answerability: { answerable: true },
  attachedSource: {
    kind: 'claude-transcript',
    externalSessionId: 'notification-reader',
    affinity: { kind: 'fixture-home', ref: 'notification-home' },
  },
  isLoaded: true,
  isPersisted: true,
  eventCount: 2,
  createdAt: NOW,
  updatedAt: LATER,
  projectSlug: 'dev',
};

// The station feed record (notifications-inbox.spec.ts) with a v1 envelope
// whose path target the panel's Open follows.
const notification = (id: string, title: string, chat: string) => ({
  id,
  source: 'orchestration',
  category: 'turn-finished',
  title,
  priority: 'normal',
  status: 'delivered',
  createdAt: NOW,
  updatedAt: NOW,
  metadata: {
    envelope: {
      v: 1,
      source: { kind: 'system', subsystem: 'orchestration' },
      audience: { kind: 'owner' },
      urgency: 'done',
      target: { kind: 'path', path: `/?chat=${chat}&dock=open` },
      interrupt: 'default',
    },
  },
});
const NOTIFICATIONS = [
  notification('n-open', 'Finished: Release notes', 'conv-2'),
  notification('n-refused', 'Finished: Private review', 'conv-3'),
];

const json = (route: Route, data: unknown, status = 200) =>
  route.fulfill({ status, json: { success: status < 400, data } });

async function seed(page: Page) {
  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page, {
    conversations: [
      ...DEFAULT_CONVERSATIONS,
      {
        id: 'conv-2',
        title: 'Release notes',
        createdAt: NOW,
        updatedAt: NOW,
        messageCount: 2,
      },
    ],
    conversationLookups: {
      ...DEFAULT_CONVERSATION_LOOKUPS,
      'conv-2': {
        id: 'conv-2',
        currentSessionId: 'session-2',
        agentSlug: 'dev-agent',
        projectSlug: 'dev',
        title: 'Release notes',
      },
    },
  });
  await installMockOrchestrationEventWindow(page, 'codex', {
    'session-1': turn(
      'session-1',
      'codex',
      'Check the first chat',
      'The first chat stays readable.',
    ),
    'session-2': turn(
      'session-2',
      'codex',
      'Draft the release notes',
      'Release notes are ready.',
    ),
    [ATTACHED]: turn(
      ATTACHED,
      'claude',
      'Read the design notes',
      'The imported transcript is here.',
    ),
  });
  await installMockOrchestrationConversationEventWindow(page, (id) =>
    id === 'conv-1' ? ['session-1'] : id === 'conv-2' ? ['session-2'] : [],
  );
  // Newer routes are tried first, so these answer before the shared ones.
  await page.route(
    (url) => url.pathname === '/api/me/preferences',
    (route) =>
      route.request().method() === 'GET'
        ? json(route, { schemaVersion: 1, values: {} })
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => url.pathname === '/api/orchestration/sessions/read-model',
    (route) =>
      route.request().method() === 'GET'
        ? json(route, [
            ownedSession('session-1'),
            ownedSession('session-2'),
            attachedSession,
          ])
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) =>
      url.pathname ===
      `/api/orchestration/sessions/${encodeURIComponent(ATTACHED)}`,
    (route) =>
      route.request().method() === 'GET'
        ? json(route, { session: attachedSession, events: [] })
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => url.pathname === '/api/attention',
    (route) =>
      route.request().method() === 'GET'
        ? json(route, { items: [], pendingCount: 0 })
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => url.pathname === '/notifications',
    (route) =>
      route.request().method() === 'GET'
        ? json(route, NOTIFICATIONS)
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => /^\/notifications\/n-(open|refused)\/read$/.test(url.pathname),
    (route) =>
      route.request().method() === 'POST'
        ? json(route, { outcome: 'read' })
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => url.pathname === '/api/conversations/conv-3/open',
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 403,
            json: { success: false, error: 'Forbidden' },
          })
        : rejectUnexpectedFixtureRequest(route),
  );
}

/** Holds conv-2's open until released; always unrouted. */
async function holdOpen(page: Page) {
  let reached!: () => void;
  const wasReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const matches = (url: URL) =>
    url.pathname === '/api/conversations/conv-2/open';
  const handler = async (route: Route) => {
    reached();
    await released;
    await route.fallback();
  };
  await page.route(matches, handler);
  return {
    reached: wasReached,
    release,
    async dispose() {
      release();
      await page.unroute(matches, handler);
    },
  };
}

async function openFirstChat(page: Page) {
  await page.goto('/?dock=open&chat=conv-1');
  await dismissSetupLauncher(page);
  await waitForMockOrchestrationSse(page);
  await expect(
    page.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText('The first chat stays readable.');
}

async function openFromNotifications(page: Page, title: string) {
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page
    .locator('.notification-history__item')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Open' })
    .click();
}

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 80; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

const headerTitle = (page: Page) =>
  page.locator(
    '[data-surface="chat-header"], .chat-dock__mobile-identity-lines',
  );
const openingStatus = (page: Page) =>
  page.getByRole('status', { name: 'Opening conversation' });

for (const [width, viewport] of [
  ['390', PHONE],
  ['1440', DESKTOP],
] as const) {
  const phone = viewport === PHONE;
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`notification deep link (${width}, ${colorScheme})`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme });
        await seed(page);
      });

      const capture = async (page: Page, testInfo: TestInfo, name: string) => {
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme',
          colorScheme,
        );
        await page.screenshot({
          path: testInfo.outputPath(`${name}-${width}-${colorScheme}.png`),
        });
      };

      test('names the opening conversation and covers the previous one', async ({
        page,
      }, testInfo) => {
        const hold = await holdOpen(page);
        try {
          await openFirstChat(page);
          await openFromNotifications(page, 'Finished: Release notes');
          await hold.reached;
          await expect(openingStatus(page)).toBeVisible();
          await expect(headerTitle(page)).toContainText('Opening conversation');
          await expect(
            page.getByRole('log', { name: 'Conversation transcript' }),
          ).toHaveCount(0);
          await capture(page, testInfo, 'opening');
          hold.release();
          await expect(
            page.getByRole('log', { name: 'Conversation transcript' }),
          ).toContainText('Release notes are ready.');
          await expect(openingStatus(page)).toHaveCount(0);
          await expect(headerTitle(page)).toContainText('Release notes');
        } finally {
          await hold.dispose();
        }
      });

      test('a refused conversation says why and is dismissed from the keyboard', async ({
        page,
      }, testInfo) => {
        await openFirstChat(page);
        await openFromNotifications(page, 'Finished: Private review');
        const notice = page.getByText('No access to this conversation');
        await expect(notice).toBeVisible();
        await capture(page, testInfo, 'refused');
        const dismiss = page.getByRole('button', { name: 'Dismiss' });
        await tabTo(page, dismiss);
        await page.keyboard.press('Enter');
        await expect(notice).toHaveCount(0);
      });

      test('an imported conversation keeps its header and Continue over a pending open', async ({
        page,
      }, testInfo) => {
        const launches: unknown[] = [];
        await page.route(
          (url) => url.pathname === '/api/starter-work/continue-session',
          (route) =>
            route.request().method() === 'GET'
              ? json(route, { state: 'unbound' })
              : rejectUnexpectedFixtureRequest(route),
        );
        await page.route(
          (url) => url.pathname === '/api/starter-work/launch',
          (route) => {
            if (route.request().method() !== 'POST')
              return rejectUnexpectedFixtureRequest(route);
            launches.push(route.request().postDataJSON());
            return json(route, {
              state: 'failed',
              source: { kind: 'session', id: ATTACHED },
              reason: 'The source conversation is still syncing.',
              retrySafe: true,
            });
          },
        );
        const hold = await holdOpen(page);
        try {
          await openFirstChat(page);
          await page
            .getByRole('button', { name: phone ? 'Inbox' : /^Show inbox/ })
            .first()
            .click();
          await page
            .getByRole('button', {
              name: new RegExp(`^${IMPORTED_TITLE},.*third-party session`),
            })
            .click();
          const continueAction = page.getByRole('button', {
            name: 'Continue in Station',
            exact: true,
          });
          await expect(continueAction).toBeVisible();
          await expect(
            page.getByText('The imported transcript is here.'),
          ).toBeVisible();
          await expect(headerTitle(page)).toContainText(IMPORTED_TITLE);
          if (!phone)
            await expect(
              page
                .locator('.chat-dock__header-action')
                .getByRole('button', { name: 'Continue in Station' }),
            ).toBeVisible();
          await openFromNotifications(page, 'Finished: Release notes');
          await hold.reached;
          await expect(continueAction).toBeVisible();
          await expect(headerTitle(page)).toContainText(IMPORTED_TITLE);
          await expect(openingStatus(page)).toHaveCount(0);
          await capture(page, testInfo, 'imported');
          await tabTo(page, continueAction);
          await page.keyboard.press('Enter');
          await expect(
            page.getByRole('alert').filter({
              hasText:
                "Couldn't start the continuation. The source conversation is still syncing.",
            }),
          ).toBeVisible();
          expect(launches).toEqual([
            expect.objectContaining({
              starterId: 'continue-session',
              sourceSessionId: ATTACHED,
            }),
          ]);
        } finally {
          await hold.dispose();
        }
      });
    });
  }
}
