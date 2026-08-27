import { expect, type Page, test } from '@playwright/test';
import {
  dismissSetupLauncher,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

// The coding-layout inspector is now tabbed + collapsible. Seed Flow as
// not-configured, then open the Trust tab (expanding from the slim strip first
// when the rail is collapsed — which it is when nothing is configured).
async function seedFlowNotConfigured(page: Page) {
  await page.route('**/api/projects/*/flow/definitions**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { initialized: false, definitions: [] },
      }),
    }),
  );
}

async function openTrustTab(page: Page) {
  const strip = page.locator('.coding-inspector-strip');
  if (await strip.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: /Open Trust/ }).click();
  } else {
    await page.getByRole('tab', { name: 'Trust' }).click();
  }
}

const BUNDLES = [
  {
    id: 'survey-demo-review',
    fileName: 'survey-demo-review.json',
    path: '/tmp/test/.station/trust-bundles/survey-demo-review.json',
    source: 'workspace',
    modifiedAt: '2026-06-12T01:00:00.000Z',
    valid: true,
    bundleSource: 'survey-review-workbench',
    claimCount: 2,
    claimsByStatus: { verified: 1, proposed: 1 },
    transparencyGapCount: 1,
  },
  {
    id: 'older-bundle',
    fileName: 'older-bundle.json',
    path: '/home/projects/dev/plugin-data/a-plugin/trust-bundles/older-bundle.json',
    source: 'station-home',
    plugin: 'a-plugin',
    modifiedAt: '2026-06-11T01:00:00.000Z',
    valid: true,
    claimCount: 1,
    claimsByStatus: { proposed: 1 },
    transparencyGapCount: 0,
  },
];

const REPORT_RESULT = {
  id: 'survey-demo-review',
  path: '/tmp/test/.station/trust-bundles/survey-demo-review.json',
  source: 'workspace',
  modifiedAt: '2026-06-12T01:00:00.000Z',
  valid: true,
  report: {
    id: 'report-1',
    generatedAt: '2026-06-12T01:00:00.000Z',
    claims: [
      {
        id: 'claim-1',
        status: 'verified',
        claimType: 'survey.review-outcome',
        fieldOrBehavior: 'candidate-12',
        subjectId: 'directory:entry-12',
      },
      {
        id: 'claim-2',
        status: 'proposed',
        claimType: 'survey.review-outcome',
        fieldOrBehavior: 'candidate-13',
        subjectId: 'directory:entry-13',
      },
    ],
    evidence: [
      {
        id: 'ev-1',
        claimId: 'claim-1',
        excerptOrSummary: 'Reviewer accepted the proposed value',
        sourceRef: 'review-session:demo',
        method: 'attestation',
        passing: true,
      },
    ],
    transparencyGaps: [
      {
        id: 'gap-1',
        claimId: 'claim-2',
        type: 'corroboration_absent',
        severity: 'medium',
        message: 'No corroborating evidence for the proposed value.',
      },
    ],
    summary: { totalClaims: 2, byStatus: { verified: 1, proposed: 1 } },
  },
};

const NOT_CONFIGURED_READINESS = {
  configured: false,
  reason: 'no-veritas-dir',
};

test.describe('Surface trust panel in the coding layout', () => {
  test.beforeEach(async ({ page }) => {
    await seedOrchestrationRoutes(page);
    await seedFlowNotConfigured(page);
    await page.route('**/api/projects/dev/readiness*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: NOT_CONFIGURED_READINESS,
        }),
      }),
    );
  });

  test('renders the trust report with claim summary, evidence drill-down, and gaps', async ({
    page,
  }) => {
    await page.route('**/api/projects/dev/trust-bundles', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: BUNDLES }),
      }),
    );
    await page.route('**/api/projects/dev/trust-bundles/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: REPORT_RESULT }),
      }),
    );

    await page.goto('/projects/dev/layouts/code');
    await dismissSetupLauncher(page);
    await openTrustTab(page);

    const panel = page.getByRole('region', { name: 'Trust bundles' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Trust bundles (2)')).toBeVisible();

    // Collapsed by default; expand.
    await panel.getByRole('button', { name: 'Show' }).click();

    // Bundle selector defaults to the most recent bundle.
    const selector = panel.getByRole('combobox', { name: 'Trust bundle' });
    await expect(selector).toBeVisible();
    await expect(selector).toHaveValue('survey-demo-review');

    // Claim summary by status.
    await expect(
      panel.locator('.trust-panel__chip', { hasText: 'Verified' }),
    ).toContainText('1');
    await expect(
      panel.locator('.trust-panel__chip', { hasText: 'Proposed' }),
    ).toContainText('1');

    // Claims list with evidence drill-down.
    await expect(panel.getByText('survey.review-outcome')).toHaveCount(2);
    await panel.getByRole('button', { name: 'Evidence' }).first().click();
    await expect(
      panel.getByText('Reviewer accepted the proposed value'),
    ).toBeVisible();

    // Transparency gaps called out.
    await expect(panel.getByText('Transparency gaps (1)')).toBeVisible();
    await expect(
      panel.getByText('No corroborating evidence for the proposed value.'),
    ).toBeVisible();
  });

  test('shows the empty state when the project has no trust bundles', async ({
    page,
  }) => {
    await page.route('**/api/projects/dev/trust-bundles', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );

    await page.goto('/projects/dev/layouts/code');
    await dismissSetupLauncher(page);
    await openTrustTab(page);

    const panel = page.getByRole('region', { name: 'Trust bundles' });
    await panel.getByRole('button', { name: 'Show' }).click();
    await expect(panel.getByText('No trust bundles yet')).toBeVisible();
  });

  test('surfaces invalid bundles with their validation error', async ({
    page,
  }) => {
    await page.route('**/api/projects/dev/trust-bundles', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [{ ...BUNDLES[0], valid: false }],
        }),
      }),
    );
    await page.route('**/api/projects/dev/trust-bundles/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            ...REPORT_RESULT,
            valid: false,
            error: 'Trust bundle is missing required schemaVersion',
            report: null,
          },
        }),
      }),
    );

    await page.goto('/projects/dev/layouts/code');
    await dismissSetupLauncher(page);
    await openTrustTab(page);

    const panel = page.getByRole('region', { name: 'Trust bundles' });
    await panel.getByRole('button', { name: 'Show' }).click();
    await expect(
      panel.getByText(/missing required schemaVersion/),
    ).toBeVisible();
  });
});
