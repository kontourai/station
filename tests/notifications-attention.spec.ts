import {
  type AttentionItem,
  isStandingAttentionKind,
} from '@kontourai/station-contracts/attention';
import type { Page } from '@playwright/test';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * D9 (`reports/board-notifications-lane/DESIGN.md`): Notifications is an
 * attention queue plus an activity log — "things that need you, and what
 * happened" — and the two are held apart by the SERVER's projection, not by
 * anything this page decides.
 *
 * Everything below is seeded through the real `POST /notifications` on the
 * live instance: an `approval-request` category is what
 * `AttentionProjectionService`'s `isApprovalNotification` promotes into the
 * attention queue, and an `info` category is ordinary activity. So the split
 * the page renders is an OBSERVATION of that projection. If someone ever
 * re-derives "needs attention" in the client, the two rows stop landing in
 * the regions asserted here.
 *
 * The load-bearing assertion is 6-OPS-29's: the bulk action empties the
 * attention queue and leaves the activity log at exactly the count it had.
 * The affordance it replaced ("Clear notifications") did the opposite —
 * emptied the attention queue while claiming to clear history.
 */

const API = resolveE2EApiBase();

const APPROVAL_TITLE = 'D9 approval request';
const ACTIVITY_TITLE = 'D9 activity item';
const SEED_SOURCE = 'playwright-d9-attention';

interface AttentionSnapshot {
  items: AttentionItem[];
  pendingCount: number;
}

async function readAttention(
  request: AuthenticatedE2ERequest,
): Promise<AttentionSnapshot> {
  const response = await request.get(`${API}/api/attention`);
  expect(response.status(), 'GET /api/attention').toBe(200);
  return (await response.json()).data as AttentionSnapshot;
}

/**
 * Clear prior per-event attention through its real dismissal routes. Standing
 * setup notices remain true until configuration changes and are deliberately
 * not acknowledgeable. Later assertions compare the seeded delta with that
 * server-owned baseline and verify that bulk dismissal preserves it.
 */
async function resetInbox(request: AuthenticatedE2ERequest): Promise<void> {
  const cleared = await request.delete(`${API}/notifications`);
  expect(cleared.status(), 'DELETE /notifications').toBe(200);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await readAttention(request);
    if (
      snapshot.items.every(
        (item) => item.acknowledgedAt || isStandingAttentionKind(item.kind),
      )
    )
      return;
    for (const item of snapshot.items) {
      if (item.acknowledgedAt || isStandingAttentionKind(item.kind)) continue;
      const acknowledgement = await request.post(
        `${API}/api/attention/${encodeURIComponent(item.id)}/ack`,
      );
      expect(acknowledgement.status(), `acknowledging ${item.kind}`).toBe(200);
    }
  }
  expect(
    (await readAttention(request)).items.filter(
      (item) => !item.acknowledgedAt && !isStandingAttentionKind(item.kind),
    ),
    'the inbox still contains dismissible attention from an earlier test',
  ).toEqual([]);
}

/** One item the projection must promote, one it must not. */
async function seedOneOfEach(request: AuthenticatedE2ERequest): Promise<void> {
  const before = await readAttention(request);
  const approval = await request.post(`${API}/notifications`, {
    data: {
      source: SEED_SOURCE,
      category: 'approval-request',
      title: APPROVAL_TITLE,
      priority: 'high',
      actions: [{ id: 'allow', label: 'Allow', variant: 'primary' }],
    },
  });
  expect(approval.status(), 'seeding the approval').toBe(201);
  const activity = await request.post(`${API}/notifications`, {
    data: {
      source: SEED_SOURCE,
      category: 'info',
      title: ACTIVITY_TITLE,
      priority: 'normal',
    },
  });
  expect(activity.status(), 'seeding the activity item').toBe(201);
  // The bell renders `pendingCount` straight off this projection
  // (`useAttentionInbox`), so pinning it here is what makes the DOM
  // assertions below observations of the server rather than of themselves.
  expect(
    (await readAttention(request)).pendingCount,
    'exactly one of the two seeded notifications is an attention item',
  ).toBe(before.pendingCount + 1);
}

function attentionRegion(page: Page) {
  return page.locator('section', { has: page.locator('#attention-heading') });
}

function activityRegion(page: Page) {
  return page.locator('section', {
    has: page.locator('#notification-history-heading'),
  });
}

function bulkDismiss(page: Page) {
  return page.getByRole('button', { name: 'Dismiss all attention items' });
}

/**
 * The toolbar bell. Located by its `title` because the sidebar's own
 * Notifications nav entry shares the unbadged accessible name — the badge is
 * what this spec is reading, so it must read it off the one control that
 * renders it.
 */
function bell(page: Page) {
  return page.locator('button[title="Notifications"]');
}

test.describe('Notifications: attention queue and activity log', () => {
  test.beforeEach(async ({ authenticatedRequest }) => {
    await resetInbox(authenticatedRequest);
    await seedOneOfEach(authenticatedRequest);
  });

  test.afterEach(async ({ authenticatedRequest }) => {
    await resetInbox(authenticatedRequest);
  });

  test('the bell counts only attention, and the bulk dismissal leaves the activity log at its own count', async ({
    page,
    authenticatedRequest,
  }) => {
    const initial = await readAttention(authenticatedRequest);
    const standingCount = initial.items.filter(
      (item) => !item.acknowledgedAt && isStandingAttentionKind(item.kind),
    ).length;
    await page.goto('/notifications');

    // Two regions, one item each, each in the region the SERVER put it in.
    await expect(
      page.getByRole('heading', {
        name: `Needs attention (${initial.pendingCount})`,
      }),
    ).toBeVisible();
    await expect(attentionRegion(page).getByText(APPROVAL_TITLE)).toBeVisible();
    await expect(activityRegion(page).getByText(ACTIVITY_TITLE)).toBeVisible();
    // The approval is NOT also an activity row: `useAttentionInbox` removes
    // the notification the projection already promoted, so one notification
    // never appears twice under two names.
    await expect(activityRegion(page).getByText(APPROVAL_TITLE)).toHaveCount(0);

    // One label map (`utils/notificationLabels.ts`) — 6-OPS-29's
    // "Approval" / "Approval Request" flip came from two label sources.
    await expect(
      attentionRegion(page)
        .locator('.attention-item')
        .filter({ hasText: APPROVAL_TITLE })
        .locator('.attention-item__type'),
    ).toHaveText('Approval request');

    // The bell badge is this count and only this count.
    await expect(bell(page)).toHaveAttribute(
      'aria-label',
      `Notifications (${initial.pendingCount} need attention)`,
    );

    // The page's own activity receipt, read BEFORE the bulk action so the
    // "unchanged" claim afterwards is a comparison and not a guess.
    const activityReceipt = page.locator('.notifications-page__result-summary');
    await expect(activityReceipt).toHaveText('Showing 1 of 1 activity items');

    await bulkDismiss(page).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      'Dismiss 1 item needing attention? Activity stays.',
    );
    await dialog
      .getByRole('button', { name: 'Dismiss all attention items' })
      .click();
    // The confirm is answered. It used to stay open and re-render itself
    // against the emptied queue as "Dismiss 0 items needing attention?".
    await expect(dialog).toHaveCount(0);

    // ORDER MATTERS, and it is the emptied attention region that has to come
    // first: an "activity is unchanged" assertion evaluated straight after the
    // click passes on the DOM the mutation has not reached yet — a bulk
    // action that also cleared activity would slip
    // past exactly that assertion and be caught one assertion later. Waiting
    // for region 1 to empty is what proves the mutation landed; only then does
    // "activity is still there" mean anything.

    await expect(attentionRegion(page).getByText(APPROVAL_TITLE)).toHaveCount(
      0,
    );
    await expect(bell(page)).toHaveAttribute(
      'aria-label',
      standingCount === 0
        ? 'Notifications'
        : `Notifications (${standingCount} need attention)`,
    );
    for (const item of initial.items.filter((entry) =>
      isStandingAttentionKind(entry.kind),
    )) {
      await expect(
        attentionRegion(page).getByText(item.title, { exact: true }),
      ).toBeVisible();
    }
    // 6-OPS-29, the whole point: activity is untouched, in the DOM and in
    // the store the page is rendering.
    await expect(activityRegion(page).getByText(ACTIVITY_TITLE)).toBeVisible();
    await expect(activityReceipt).toHaveText('Showing 1 of 1 activity items');
    expect(
      (await readAttention(authenticatedRequest)).pendingCount,
      'the server retains exactly the standing notices after dismissal',
    ).toBe(standingCount);
    const remaining = (
      await (await authenticatedRequest.get(`${API}/notifications`)).json()
    ).data as Array<{ title: string }>;
    expect(
      remaining.map((notification) => notification.title),
      'a dismissal of attention deleted no activity',
    ).toContain(ACTIVITY_TITLE);
  });

  /**
   * archive#3779, corrected against the server.
   *
   * The issue reported that a row's own Dismiss DELETES the notification while
   * the bulk action merely acknowledges. It does not: `DELETE
   * /notifications/:id` reaches `NotificationService.dismiss`, which sets
   * `status: 'dismissed'` and KEEPS the record. This test is the observation —
   * the request answers 200, and the row is still on the page and still in
   * `GET /notifications` afterwards, with its action gone.
   *
   * Kept as coverage rather than deleted because the premise it disproves is
   * the kind that gets re-derived from an HTTP verb: the next reader who sees
   * `DELETE` and renames the button "Delete" turns this red.
   */
  test('the row action dismisses the notification and keeps the record', async ({
    page,
    authenticatedRequest,
  }) => {
    await page.goto('/notifications');

    const activity = activityRegion(page);
    await expect(activity.getByText(ACTIVITY_TITLE)).toBeVisible();

    // Scoped to the ROW that carries the seeded title: a live instance posts
    // its own activity (an available-update notice, for one), so the first
    // action in this region is not necessarily this test's.
    const row = activity
      .locator('.notification-card')
      .filter({ hasText: ACTIVITY_TITLE });
    const dismiss = row.getByRole('button', { name: 'Dismiss' });
    await expect(dismiss).toBeVisible();

    const dismissed = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        /\/notifications\/[^/]+$/.test(new URL(response.url()).pathname),
    );
    await dismiss.click();
    expect((await dismissed).status(), 'the dismissal was refused').toBe(200);

    // The record survives — in the store, and on the page.
    const stored = (
      (await (
        await authenticatedRequest.get(`${API}/notifications`)
      ).json()) as {
        data: Array<{ title: string; status: string }>;
      }
    ).data.find((notification) => notification.title === ACTIVITY_TITLE);
    expect(stored, 'the dismissal removed the record').toBeTruthy();
    expect(stored?.status).toBe('dismissed');
    await expect(activity.getByText(ACTIVITY_TITLE)).toBeVisible();
    // What a dismissal takes away is the ACTION, not the row.
    await expect(row.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
  });

  test('the bulk action is disabled when no dismissible attention remains', async ({
    page,
    authenticatedRequest,
  }) => {
    await resetInbox(authenticatedRequest);
    await page.goto('/notifications');

    expect(
      (await readAttention(authenticatedRequest)).items.filter(
        (item) => !item.acknowledgedAt && !isStandingAttentionKind(item.kind),
      ),
    ).toEqual([]);
    await expect(bulkDismiss(page)).toBeDisabled();
  });
});

test.describe('Notifications at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ authenticatedRequest }) => {
    await resetInbox(authenticatedRequest);
    await seedOneOfEach(authenticatedRequest);
  });

  test.afterEach(async ({ authenticatedRequest }) => {
    await resetInbox(authenticatedRequest);
  });

  test('the regions stack and both the row action and the bulk action stay 44px targets', async ({
    page,
    authenticatedRequest,
  }) => {
    const initial = await readAttention(authenticatedRequest);
    await page.goto('/notifications');

    await expect(
      page.getByRole('heading', {
        name: `Needs attention (${initial.pendingCount})`,
      }),
    ).toBeVisible();
    await expect(activityRegion(page).getByText(ACTIVITY_TITLE)).toBeVisible();

    // D9 mobile: the attention row's PRIMARY action, not merely some button
    // on the page. The row's own Allow is what a person reaches for.
    const primary = attentionRegion(page).getByRole('button', {
      name: 'Allow',
    });
    await expect(primary).toBeVisible();
    const primaryBox = await primary.boundingBox();
    expect(
      primaryBox,
      'the approval action has no layout box at 390',
    ).toBeTruthy();
    expect(primaryBox?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    const bulk = bulkDismiss(page);
    await expect(bulk).toBeVisible();
    await expect(bulk).toBeEnabled();
    const bulkBox = await bulk.boundingBox();
    expect(bulkBox, 'the bulk action has no layout box at 390').toBeTruthy();
    expect(bulkBox?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    // archive#3779: the row's own dismissal is a tap target of its own,
    // distinct from the bulk one above.
    const rowAction = activityRegion(page)
      .locator('.notification-card')
      .filter({ hasText: ACTIVITY_TITLE })
      .getByRole('button', { name: 'Dismiss' });
    await expect(rowAction).toBeVisible();
    const rowBox = await rowAction.boundingBox();
    expect(rowBox, 'the row action has no layout box at 390').toBeTruthy();
    expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    // The regions stack: attention sits above activity in the document, and
    // nothing pushes the page sideways.
    const attentionTop = (await attentionRegion(page).boundingBox())?.y ?? -1;
    const activityTop = (await activityRegion(page).boundingBox())?.y ?? -1;
    expect(attentionTop).toBeGreaterThanOrEqual(0);
    expect(activityTop).toBeGreaterThan(attentionTop);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});

// Controlled provider + real Hono/OrchestrationService/EventStore behind the
// managed app. These cases exercise the browser command and stale-event guard
// together, without an external account or a second runtime authority.
for (const viewport of [
  { label: 'desktop', width: 1280, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
]) {
  test(`exact request inspector records one decision on ${viewport.label}`, async ({
    page,
  }, testInfo) => {
    const { exactRequestBackend } = await import(
      './helpers/exact-request-backend'
    );
    const backend = await exactRequestBackend(
      page,
      testInfo.outputPath('exact-request.sqlite'),
    );
    try {
      await page.setViewportSize(viewport);
      await expect.poll(() => backend.current().state).toBe('found');
      await page.goto('/notifications');
      await page
        .getByRole('button', { name: 'Inspect request', exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Inspect request',
        exact: true,
      });
      const approve = dialog.getByRole('button', {
        name: 'Approve once',
        exact: true,
      });
      await expect(approve).toBeEnabled();
      await expect(dialog).toHaveCSS('opacity', '1');
      await page.screenshot({
        path: testInfo.outputPath(`request-inspector-${viewport.label}.png`),
        animations: 'disabled',
      });
      await approve.click();
      await expect.poll(() => backend.effects.length).toBe(1);
      await expect
        .poll(
          () =>
            backend
              .receipts()
              .filter(
                (receipt) =>
                  receipt.commandType === 'respondToRequest' &&
                  receipt.status === 'accepted',
              ).length,
        )
        .toBe(1);
    } finally {
      await backend.close();
    }
  });
}

test('exact request inspector refuses a same-ID request reopened after inspection', async ({
  page,
}, testInfo) => {
  const { exactRequestBackend } = await import(
    './helpers/exact-request-backend'
  );
  const backend = await exactRequestBackend(
    page,
    testInfo.outputPath('exact-request.sqlite'),
  );
  try {
    await expect.poll(() => backend.current().state).toBe('found');
    await page.goto('/notifications');
    await page
      .getByRole('button', { name: 'Inspect request', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Inspect request',
      exact: true,
    });
    await expect(
      dialog.getByRole('button', { name: 'Approve once' }),
    ).toBeEnabled();
    backend.reopen();
    await expect
      .poll(() => {
        const value = backend.current();
        return value.state === 'found' ? value.event.id : null;
      })
      .toBe('browser-opened-b');
    await dialog.getByRole('button', { name: 'Approve once' }).click();
    await expect(
      dialog.getByText("Couldn't confirm the decision"),
    ).toBeVisible();
    expect(backend.effects).toHaveLength(0);
    expect(
      backend
        .receipts()
        .some(
          (receipt) =>
            receipt.commandType === 'respondToRequest' &&
            receipt.status === 'rejected',
        ),
    ).toBe(true);
    await dialog.getByRole('button', { name: 'Check request again' }).click();
    await expect(
      dialog.getByText(/changed after the attention item/),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Approve once' }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('request-inspector-stale.png'),
      animations: 'disabled',
    });
  } finally {
    await backend.close();
  }
});
