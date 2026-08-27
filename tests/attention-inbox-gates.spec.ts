import { expect, test } from '@playwright/test';
import { seedOrchestrationRoutes } from './helpers/orchestration';

const NOW = new Date().toISOString();

function routeAttention(
  page: import('@playwright/test').Page,
  items: unknown[],
) {
  return page.route('**/api/attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { items, pendingCount: items.length },
      }),
    }),
  );
}

function routeEmptyOrdinaryNotifications(
  page: import('@playwright/test').Page,
) {
  return page.route('**/notifications', (route) => {
    if (route.request().resourceType() === 'document') {
      return route.fallback();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });
}

test.describe('Attention inbox — gate items (station#612)', () => {
  test('renders all three gate kinds with verdict-vocabulary copy and never the word "approval"', async ({
    page,
  }) => {
    await seedOrchestrationRoutes(page);
    await routeEmptyOrdinaryNotifications(page);

    const items = [
      {
        id: 'gate-route-back:run-1:build-gate',
        kind: 'gate-route-back',
        title: 'Route back: build',
        createdAt: NOW,
        updatedAt: NOW,
        sessionId: 'thread-route-back',
        openHref: '/projects/dev/flow-console?run=run-1',
        source: {
          threadId: 'thread-route-back',
          runId: 'run-1',
          gateId: 'build-gate',
          projectSlug: 'dev',
        },
        routeBackTo: 'implement',
        attempt: 2,
        maxAttempts: 3,
      },
      {
        id: 'gate-blocked:run-2:test-gate',
        kind: 'gate-blocked',
        title: 'Blocked: test',
        createdAt: NOW,
        updatedAt: NOW,
        sessionId: 'thread-blocked',
        openHref: '/projects/dev/flow-console?run=run-2',
        source: {
          threadId: 'thread-blocked',
          runId: 'run-2',
          gateId: 'test-gate',
          projectSlug: 'dev',
        },
      },
      {
        id: 'gate-exception:run-3:verify-gate',
        kind: 'gate-exception',
        title: 'Exception pending: verify',
        createdAt: NOW,
        updatedAt: NOW,
        sessionId: 'thread-exception',
        openHref: '/projects/dev/flow-console?run=run-3',
        source: {
          threadId: 'thread-exception',
          runId: 'run-3',
          gateId: 'verify-gate',
          projectSlug: 'dev',
        },
        limitExceeded: true,
      },
    ];
    await routeAttention(page, items);

    await page.goto('/notifications');

    await expect(page.getByText('Route back: build')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText('Blocked: test')).toBeVisible();
    await expect(page.getByText('Exception pending: verify')).toBeVisible();

    // Copy separation: the three gate kinds render distinct badge copy, and
    // none of it uses "approval" — a gate verdict evaluates evidence, it
    // does not allow an action (root CONTEXT.md ~624).
    await expect(page.getByText('Route back', { exact: true })).toBeVisible();
    await expect(page.getByText('Gate blocked', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Exception pending', { exact: true }),
    ).toBeVisible();
    const bodyText = await page
      .locator('.notifications-page__list')
      .innerText();
    expect(bodyText.toLowerCase()).not.toContain('approval');

    // Route-back and blocked share the same re-evaluate affordance.
    const reEvaluateButtons = page.getByRole('button', {
      name: 'Re-evaluate',
    });
    await expect(reEvaluateButtons).toHaveCount(2);

    // Only the exception item offers the exception dialog.
    await expect(
      page.getByRole('button', { name: 'Accept exception…' }),
    ).toHaveCount(1);
  });

  test('re-evaluate posts to the run evaluate endpoint for the gate', async ({
    page,
  }) => {
    await seedOrchestrationRoutes(page);
    await routeEmptyOrdinaryNotifications(page);

    const items = [
      {
        id: 'gate-blocked:run-2:test-gate',
        kind: 'gate-blocked',
        title: 'Blocked: test',
        createdAt: NOW,
        updatedAt: NOW,
        sessionId: 'thread-blocked',
        openHref: '/projects/dev/flow-console?run=run-2',
        source: {
          threadId: 'thread-blocked',
          runId: 'run-2',
          gateId: 'test-gate',
          projectSlug: 'dev',
        },
      },
    ];
    await routeAttention(page, items);

    let evaluateBody: unknown = null;
    await page.route(
      '**/api/projects/dev/flow/runs/run-2/evaluate',
      async (route) => {
        evaluateBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: {} }),
        });
      },
    );

    await page.goto('/notifications');

    await expect(page.getByText('Blocked: test')).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole('button', { name: 'Re-evaluate' }).click();
    await expect.poll(() => evaluateBody).toEqual({ gate: 'test-gate' });
  });

  test('accepting an exception from the inbox posts to the exception endpoint and closes the dialog', async ({
    page,
  }) => {
    await seedOrchestrationRoutes(page);
    await routeEmptyOrdinaryNotifications(page);

    const items = [
      {
        id: 'gate-exception:run-3:verify-gate',
        kind: 'gate-exception',
        title: 'Exception pending: verify',
        createdAt: NOW,
        updatedAt: NOW,
        sessionId: 'thread-exception',
        openHref: '/projects/dev/flow-console?run=run-3',
        source: {
          threadId: 'thread-exception',
          runId: 'run-3',
          gateId: 'verify-gate',
          projectSlug: 'dev',
        },
        limitExceeded: true,
      },
    ];
    await routeAttention(page, items);

    let exceptionBody: unknown = null;
    await page.route(
      '**/api/projects/dev/flow/runs/run-3/exception',
      async (route) => {
        exceptionBody = route.request().postDataJSON();
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { id: 'ex-1' } }),
        });
      },
    );

    await page.goto('/notifications');

    await expect(page.getByText('Exception pending: verify')).toBeVisible({
      timeout: 10000,
    });

    await page.getByRole('button', { name: 'Accept exception…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Accept exception' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Reason').fill('Ship blocked on a flaky check');
    await dialog.getByLabel('Authority').fill('release-manager@station');
    await dialog.getByRole('button', { name: 'Accept exception' }).click();

    await expect
      .poll(() => exceptionBody)
      .toEqual({
        gate: 'verify-gate',
        reason: 'Ship blocked on a flaky check',
        authority: 'release-manager@station',
      });
    await expect(dialog).not.toBeVisible();
  });

  test('a gate item deep-links into the Flow run console with the run preselected', async ({
    page,
  }) => {
    await seedOrchestrationRoutes(page);
    await routeEmptyOrdinaryNotifications(page);

    const items = [
      {
        id: 'gate-blocked:run-2:test-gate',
        kind: 'gate-blocked',
        title: 'Blocked: test',
        createdAt: NOW,
        updatedAt: NOW,
        sessionId: 'thread-blocked',
        openHref: '/projects/dev/flow-console?run=run-2',
        source: {
          threadId: 'thread-blocked',
          runId: 'run-2',
          gateId: 'test-gate',
          projectSlug: 'dev',
        },
      },
    ];
    await routeAttention(page, items);
    await page.route('**/api/projects/dev/flow/runs', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              run_id: 'run-2',
              definition_id: 'station-delivery',
              subject: 'dev',
              status: 'running',
              current_step: 'test',
              updated_at: NOW,
            },
          ],
        }),
      }),
    );
    await page.route('**/api/projects/dev/flow/runs/run-2/console', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            run: {
              run_id: 'run-2',
              definition_id: 'station-delivery',
              definition_version: '1',
              subject: 'dev',
              status: 'running',
              current_step: 'test',
              updated_at: NOW,
            },
            steps: [],
            current_step: 'test',
            open_gates: ['test-gate'],
            gates: [
              {
                id: 'test-gate',
                step_id: 'test',
                status: 'block',
                summary: 'Missing evidence',
                is_open: true,
                expectations: [],
                evidence: [],
                missing: [],
              },
            ],
            evidence: [],
            exceptions: [],
            route_backs: [],
            next_action: null,
            report: null,
          },
        }),
      }),
    );

    await page.goto('/notifications');

    await expect(page.getByText('Blocked: test')).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole('link', { name: 'Open flow console' }).click();

    await page.waitForURL(
      (url) => url.pathname === '/projects/dev/flow-console',
    );
    expect(new URL(page.url()).searchParams.get('run')).toBe('run-2');

    // The console preselects the run from ?run= rather than defaulting to
    // whatever run happens to sort first.
    await expect(page.getByText('run-2').first()).toBeVisible({
      timeout: 10000,
    });
  });
});
