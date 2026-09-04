import { expect, test } from '@playwright/test';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

const now = new Date().toISOString();

function systemStatus() {
  return {
    ready: true,
    prerequisites: [],
    acp: { connected: false, connections: [] },
    providers: { configuredChatReady: true, configured: [], detected: {} },
    capabilities: { chat: { ready: true, source: 'test' } },
    recommendation: {
      code: 'configured-chat-ready',
      type: 'providers',
      title: 'Ready',
      detail: 'Test',
      actionLabel: 'Connections',
    },
    clis: {},
  };
}

test.describe('Notifications hierarchy', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('projects concurrent attention without duplicate approval lifecycle cards', async ({
    page,
  }, testInfo) => {
    let attention = [
      {
        id: 'approval:notif-1',
        kind: 'approval',
        title: 'Approval needed',
        body: 'Workspace Agent wants to use fs.read.',
        createdAt: now,
        updatedAt: now,
        openHref: '/?surface=activity&session=thread-approval',
        source: {
          notificationId: 'notif-1',
          notificationSource: 'approval-inbox',
        },
        actions: [
          { id: 'accept', label: 'Allow Once', variant: 'primary' },
          { id: 'decline', label: 'Deny', variant: 'danger' },
        ],
      },
      {
        id: 'needs_input:thread-input',
        kind: 'needs_input',
        title: 'Input needed',
        createdAt: now,
        updatedAt: now,
        openHref: '/?surface=activity&session=thread-input',
        source: { threadId: 'thread-input' },
      },
      {
        id: 'approval:notif-2',
        kind: 'approval',
        title: 'Second approval needed',
        body: 'Workspace Agent wants to use git.status.',
        createdAt: now,
        updatedAt: now,
        openHref: '/?surface=activity&session=thread-approval-two',
        source: {
          notificationId: 'notif-2',
          notificationSource: 'approval-inbox',
        },
        actions: [{ id: 'accept', label: 'Allow second', variant: 'primary' }],
      },
      {
        id: 'review_pending:thread-review',
        kind: 'review_pending',
        title: 'Review pending',
        createdAt: now,
        updatedAt: now,
        openHref: '/?surface=activity&session=thread-review',
        source: { threadId: 'thread-review' },
      },
    ];
    const continuedTurnBodies: unknown[] = [];
    const approvalActions: string[] = [];
    const dismissedNotificationIds: string[] = [];
    let ordinaryDismissed = false;
    const approvalStatuses = new Map([
      ['notif-1', 'delivered'],
      ['notif-2', 'delivered'],
    ]);

    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(systemStatus()),
      }),
    );
    await page.route('**/api/attention', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { items: attention, pendingCount: attention.length },
        }),
      }),
    );
    await page.route('**/notifications/activity', (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      dismissedNotificationIds.push('activity-bulk');
      ordinaryDismissed = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { clearedCount: 1 },
        }),
      });
    });
    await page.route('**/notifications', (route) => {
      if (route.request().resourceType() === 'document') {
        return route.fallback();
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: 'notif-1',
              source: 'approval-inbox',
              category: 'approval-request',
              title: 'Approval needed',
              priority: 'high',
              status: approvalStatuses.get('notif-1'),
              createdAt: now,
              updatedAt: now,
            },
            {
              id: 'notif-2',
              source: 'approval-inbox',
              category: 'approval-request',
              title: 'Second approval needed',
              priority: 'high',
              status: approvalStatuses.get('notif-2'),
              createdAt: now,
              updatedAt: now,
            },
            ...(!ordinaryDismissed
              ? [
                  {
                    id: 'ordinary',
                    source: 'scheduler',
                    category: 'job',
                    title: 'Job failed',
                    priority: 'normal',
                    status: 'delivered',
                    createdAt: now,
                    updatedAt: now,
                  },
                ]
              : []),
          ],
        }),
      });
    });
    await page.route('**/notifications/*/action/*', (route) => {
      const match = new URL(route.request().url()).pathname.match(
        /\/notifications\/([^/]+)\/action\/([^/]+)$/,
      );
      if (!match) return route.abort();
      const [, notificationId, actionId] = match;
      approvalActions.push(`${notificationId}:${actionId}`);
      approvalStatuses.set(notificationId, 'actioned');
      attention = attention.filter(
        (item) => item.id !== `approval:${notificationId}`,
      );
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });
    await page.route(
      '**/api/orchestration/chat/thread-input/continue',
      async (route) => {
        continuedTurnBodies.push(route.request().postDataJSON());
        attention = attention.filter(
          (item) => item.id !== 'needs_input:thread-input',
        );
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            foregroundMessageReceiptEnvelope({
              conversationId: 'thread-input',
              agent: 'station',
            }),
          ),
        });
      },
    );

    await page.goto('/notifications');
    await expect(
      page.getByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Needs attention (4)')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Recent activity', level: 2 }),
    ).toBeVisible();
    const notificationsButton = page.getByRole('button', {
      name: 'Notifications (4 need attention)',
    });
    await expect(notificationsButton).toBeVisible();
    await notificationsButton.click();
    const compactNotifications = page.locator('.notification-history');
    await expect(compactNotifications).toBeVisible();
    // archive#3222: the tray section names the badge's own population. All
    // four are unacknowledged and all four fit, so it reads as one number —
    // the same number the button the reader just clicked is showing.
    await expect(
      compactNotifications.getByRole('heading', {
        name: 'Needs attention (4)',
        level: 2,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      compactNotifications.getByRole('heading', {
        name: 'Recent activity',
        level: 2,
      }),
    ).toBeVisible();
    await expect(
      compactNotifications.getByRole('button', {
        name: 'View all notifications',
      }),
    ).toBeVisible();
    const compactActions = compactNotifications.locator(
      '.notification-history__action',
    );
    expect(await compactActions.count()).toBeGreaterThan(0);
    for (const action of await compactActions.all()) {
      const box = await action.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box?.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
    const viewport = page.viewportSize();
    await page.mouse.click(2, (viewport?.height ?? 844) / 2);
    await expect(compactNotifications).toBeHidden();
    await expect(
      page.getByText('Approval needed', { exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByText('Second approval needed', { exact: true }),
    ).toHaveCount(1);
    await expect(page.getByText('Job failed')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Allow Once' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
    await expect(page.getByLabel('Answer this session')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open session' })).toHaveCount(
      4,
    );
    const reviewCard = page
      .locator('article')
      .filter({ hasText: 'Review pending' });
    const inputCard = page
      .locator('article')
      .filter({ hasText: 'Input needed' });
    await expect(
      reviewCard.getByRole('link', { name: 'Open session' }),
    ).toHaveAttribute('href', '/?surface=activity&session=thread-review');
    await expect(
      inputCard.getByRole('link', { name: 'Open session' }),
    ).toHaveAttribute('href', '/?surface=activity&session=thread-input');
    expect(
      await page
        .locator('body')
        .evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('notifications-inbox-before.png'),
      fullPage: true,
    });

    await page.getByRole('button', { name: 'Clear notifications' }).click();
    const clearDialog = page.getByRole('dialog');
    await expect(clearDialog).toContainText(
      'Active attention stays until its source changes.',
    );
    await clearDialog
      .getByRole('button', { name: 'Clear notifications' })
      .click();
    await expect
      .poll(() => dismissedNotificationIds)
      .toEqual(['activity-bulk']);
    await expect(page.getByText('Job failed')).toHaveCount(0);
    await expect(page.getByText('Needs attention (4)')).toBeVisible();
    await expect(
      page.getByText('Approval needed', { exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByText('Second approval needed', { exact: true }),
    ).toHaveCount(1);

    await page
      .getByLabel('Answer this session')
      .fill('Continue with the safe option.');
    const sendAnswer = page.getByRole('button', { name: 'Send answer' });
    await sendAnswer.evaluate((button) =>
      button.scrollIntoView({ block: 'center' }),
    );
    expect(
      await sendAnswer.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return topElement === button || button.contains(topElement);
      }),
    ).toBe(true);
    await sendAnswer.click();
    await expect
      .poll(() => continuedTurnBodies)
      .toContainEqual({
        message: 'Continue with the safe option.',
      });
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect.poll(() => approvalActions).toContain('notif-1:decline');
    await expect(page.getByRole('button', { name: 'Deny' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Allow second' }).click();
    await expect.poll(() => approvalActions).toContain('notif-2:accept');
    await expect(
      page.getByRole('button', { name: 'Allow second' }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('notifications-inbox-after.png'),
      fullPage: true,
    });
    await reviewCard.getByRole('link', { name: 'Open session' }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

/*
 * archive#3203 mobile worst case. The failure rows gained a real cause line
 * plus an engine/agent identity line, which is strictly more text in a panel
 * that already carries two actions per entry — the shape that overflows a
 * phone. The fixture is deliberately the WORST case, not a short one: a long
 * session title, a long engine-prose reason containing unbreakable path- and
 * host-shaped tokens, and three entries so the popover is crowded.
 */
test.describe('Failed-session notifications on a phone (#3203)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const LONG_TITLE =
    'Investigate the intermittent deploy verification failure in the staging release pipeline';
  const LONG_REASON =
    'Engine exited with code 1: ECONNREFUSED api.example.internal:8443 while resolving ' +
    '/Users/operator/dev/github/example-org/example-repo/packages/runtime/src/adapters/session-adapter.ts:1284 ' +
    'after 3 retries; the credential in ~/.config/example/credentials.json was rejected as expired.';

  function failure(overrides: Record<string, unknown>) {
    return {
      kind: 'session-failed',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  test('a long title and a long reason wrap and clamp instead of overflowing 390px', async ({
    page,
  }) => {
    const attention = [
      failure({
        id: 'session-failed:thread-a',
        title: LONG_TITLE,
        body: LONG_REASON,
        sessionId: 'thread-a',
        openHref: '/?surface=activity&session=thread-a',
        source: { threadId: 'thread-a' },
        engine: 'claude',
        agent: 'staging-release-reviewer',
      }),
      failure({
        id: 'session-failed:thread-b',
        title: 'Migrate the invoice table',
        body: 'Engine exited with code 1',
        sessionId: 'thread-b',
        openHref: '/?surface=activity&session=thread-b',
        source: { threadId: 'thread-b' },
        engine: 'codex',
      }),
      failure({
        id: 'session-failed:thread-c',
        title: 'Draft the release notes',
        sessionId: 'thread-c',
        openHref: '/?surface=activity&session=thread-c',
        source: { threadId: 'thread-c' },
        engine: 'claude',
      }),
    ];

    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(systemStatus()),
      }),
    );
    await page.route('**/api/attention', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { items: attention, pendingCount: attention.length },
        }),
      }),
    );
    await page.route('**/notifications', (route) =>
      route.request().resourceType() === 'document'
        ? route.fallback()
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: [] }),
          }),
    );

    await page.goto('/notifications');
    await expect(page.getByText('Needs attention (3)')).toBeVisible();

    // Every row says WHAT failed, WHY, and WHICH engine/agent — the three
    // things the reported tray said none of.
    await expect(page.getByText(LONG_TITLE)).toBeVisible();
    await expect(
      page.getByText(/ECONNREFUSED api\.example\.internal/),
    ).toBeVisible();
    await expect(
      page.getByText('Claude Code · staging-release-reviewer'),
    ).toBeVisible();
    // The absent-cause row states the absence rather than rendering nothing.
    await expect(
      page.getByText('No failure detail was recorded for this session.'),
    ).toBeVisible();

    const documentOverflow = await page.evaluate(() => ({
      overflows:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(documentOverflow.overflows).toBe(false);

    const cards = page.getByTestId('attention-item');
    await expect(cards).toHaveCount(3);
    for (const card of await cards.all()) {
      const geometry = await card.evaluate((element) => ({
        overflows: element.scrollWidth > element.clientWidth,
        right: element.getBoundingClientRect().right,
        viewportWidth: document.documentElement.clientWidth,
      }));
      expect(geometry.overflows).toBe(false);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    }

    // The length policy: the reason is clamped to four lines on the card, and
    // the untruncated text stays reachable through this row's own action.
    const cause = page.getByTestId('attention-cause').first();
    const clamp = await cause.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      clamped: element.scrollHeight > element.clientHeight,
    }));
    expect(clamp.clamped).toBe(true);
    expect(clamp.height).toBeLessThanOrEqual(clamp.lineHeight * 4 + 2);

    for (const link of await page
      .getByRole('link', { name: 'Open session' })
      .all()) {
      const box = await link.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
    for (const button of await page
      .getByRole('button', { name: 'Dismiss' })
      .all()) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box?.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }

    // Now the tray popover, which carries the same rows in a narrower column.
    await page
      .getByRole('button', { name: 'Notifications (3 need attention)' })
      .click();
    const tray = page.locator('.notification-history');
    await expect(tray).toBeVisible();
    // archive#3222: the count pair lives in this heading, so the 390px
    // containment assertions below cover it too.
    await expect(
      tray.getByRole('heading', {
        name: 'Needs attention (3)',
        level: 2,
        exact: true,
      }),
    ).toBeVisible();
    await expect(tray.getByText(LONG_TITLE)).toBeVisible();
    await expect(
      tray.getByText(/ECONNREFUSED api\.example\.internal/),
    ).toBeVisible();

    const trayGeometry = await tray.evaluate((element) => ({
      overflows: element.scrollWidth > element.clientWidth,
      right: element.getBoundingClientRect().right,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(trayGeometry.overflows).toBe(false);
    expect(trayGeometry.right).toBeLessThanOrEqual(
      trayGeometry.viewportWidth + 1,
    );
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);

    const trayCause = tray.getByTestId('attention-cause').first();
    const trayClamp = await trayCause.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      clamped: element.scrollHeight > element.clientHeight,
    }));
    expect(trayClamp.clamped).toBe(true);
    expect(trayClamp.height).toBeLessThanOrEqual(trayClamp.lineHeight * 3 + 2);

    const trayActions = tray.locator('.notification-history__action');
    expect(await trayActions.count()).toBeGreaterThan(0);
    for (const action of await trayActions.all()) {
      const box = await action.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box?.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
  });
});
