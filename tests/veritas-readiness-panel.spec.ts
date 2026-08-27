import { expect, type Page, test } from '@playwright/test';
import {
  dismissSetupLauncher,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

// The coding-layout inspector is now tabbed + collapsible. Seed the sibling
// config-detection endpoints (Flow + Trust) as not-configured so the rail's
// default-collapsed-when-nothing-configured logic is deterministic, then open
// the Readiness tab (expanding from the slim strip first if collapsed).
async function seedSiblingConfig(page: Page) {
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
  await page.route('**/api/projects/*/trust-bundles**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
}

async function openReadinessTab(page: Page) {
  const strip = page.locator('.coding-inspector-strip');
  if (await strip.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: /Open Readiness/ }).click();
  } else {
    await page.getByRole('tab', { name: 'Readiness' }).click();
  }
}

const READINESS_SNAPSHOT = {
  configured: true,
  generatedAt: '2026-06-12T00:00:00.000Z',
  overall: 'not-ready',
  cli: {
    runId: 'veritas-123',
    message: 'Evidence Check, report, and standards feedback draft completed.',
    reportArtifactPath: '.kontourai/veritas/evidence/veritas-123.json',
    sourceKind: 'working-tree',
    evidenceCheckLabels: ['npm test'],
    evidenceCheckFailure: null,
  },
  requirements: [
    {
      id: 'evidence-check:required-evidence-check',
      kind: 'evidence-check',
      label: 'npm test',
      status: 'satisfied',
      summary: 'Evidence checks passed',
      claimIds: ['fx.evidence-check.npm-test'],
    },
    {
      id: 'policy:policy-changes-require-attestation',
      kind: 'policy',
      label: 'policy-changes-require-attestation',
      status: 'advisory',
      summary: 'No active attestation found; readiness is advisory.',
      claimIds: [],
    },
    {
      id: 'governance:attestation',
      kind: 'governance',
      label: 'Governance attestation',
      status: 'missing',
      summary: 'Attestation state: missing',
      claimIds: [],
    },
  ],
  counts: {
    satisfied: 1,
    missing: 1,
    stale: 0,
    failing: 0,
    advisory: 1,
    recheckable: 0,
    accepted: 0,
  },
  trustReport: {
    claims: [
      {
        id: 'fx.evidence-check.npm-test',
        status: 'verified',
        claimType: 'software-evidence-check',
        fieldOrBehavior: 'npm test',
        subjectId: 'fx:working-tree',
      },
    ],
    evidence: [
      {
        id: 'fx.evidence-check.npm-test.evidence',
        claimId: 'fx.evidence-check.npm-test',
        excerptOrSummary: 'npm test exited 0',
        sourceRef: 'command:npm test',
        method: 'validation',
        passing: true,
      },
    ],
    transparencyGaps: [
      {
        id: 'fx.gap.1',
        claimId: 'fx.evidence-check.npm-test',
        type: 'provenance_gap',
        severity: 'medium',
        message: 'Missing required evidence: policy_rule.',
      },
    ],
  },
};

test.describe('Veritas readiness panel in the coding layout', () => {
  test.beforeEach(async ({ page }) => {
    await seedOrchestrationRoutes(page);
    await seedSiblingConfig(page);
  });

  test('renders merge readiness with status chips and the why-detail', async ({
    page,
  }) => {
    await page.route('**/api/projects/dev/readiness*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: READINESS_SNAPSHOT }),
      }),
    );

    await page.goto('/projects/dev/layouts/code');
    await dismissSetupLauncher(page);
    await openReadinessTab(page);

    const panel = page.getByRole('region', { name: 'Merge readiness' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Not ready')).toBeVisible();
    await expect(
      panel.getByText(
        'Evidence Check, report, and standards feedback draft completed.',
      ),
    ).toBeVisible();

    // Status chips with counts.
    await expect(panel.locator('.readiness-panel__chip')).toHaveCount(3);
    await expect(
      panel.locator('.readiness-panel__chip', { hasText: 'Satisfied' }),
    ).toContainText('1');

    // Requirements with statuses.
    await expect(panel.getByText('npm test', { exact: true })).toBeVisible();
    await expect(
      panel.getByText('policy-changes-require-attestation'),
    ).toBeVisible();
    await expect(panel.getByText('Governance attestation')).toBeVisible();

    // The "why" detail opens with claim, evidence, and transparency gaps.
    await panel
      .getByRole('button', { name: 'Why is this allowed to merge?' })
      .first()
      .click();
    await expect(panel.getByText('software-evidence-check')).toBeVisible();
    await expect(panel.getByText('npm test exited 0')).toBeVisible();
    await expect(panel.getByText('Transparency gaps')).toBeVisible();
    await expect(
      panel.getByText('Missing required evidence: policy_rule.'),
    ).toBeVisible();
  });

  test('refresh button forces a fresh readiness run', async ({ page }) => {
    const refreshRequests: string[] = [];
    await page.route('**/api/projects/dev/readiness*', (route) => {
      const url = route.request().url();
      if (url.includes('refresh=true')) refreshRequests.push(url);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: READINESS_SNAPSHOT }),
      });
    });

    await page.goto('/projects/dev/layouts/code');
    await dismissSetupLauncher(page);
    await openReadinessTab(page);

    const panel = page.getByRole('region', { name: 'Merge readiness' });
    await panel.getByRole('button', { name: 'Refresh' }).click();
    await expect
      .poll(() => refreshRequests.length, { timeout: 5000 })
      .toBeGreaterThan(0);
  });

  test('long requirement token wraps across the rail, not one char per line', async ({
    page,
  }) => {
    // Regression for the side-panel width-collapse: a long `required-...` token
    // in the 320px inspector rail used to collapse the flex `flex: 1` label to
    // ~1ch (the long "Why is this allowed to merge?" button stole all the row
    // width), so `overflow-wrap: anywhere` wrapped the token vertically. The
    // label now carries a width floor so it keeps a readable share of the rail.
    const longLabel =
      'required-evidence-check-with-a-very-long-token-identifier-required-xyz';
    await page.route('**/api/projects/dev/readiness*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            ...READINESS_SNAPSHOT,
            requirements: [
              {
                id: `evidence-check:${longLabel}`,
                kind: 'evidence-check',
                label: longLabel,
                status: 'missing',
                summary: 'A requirement with a long token label',
                claimIds: [],
              },
            ],
          },
        }),
      }),
    );

    await page.goto('/projects/dev/layouts/code');
    await dismissSetupLauncher(page);
    await openReadinessTab(page);

    const panel = page.getByRole('region', { name: 'Merge readiness' });
    await expect(panel).toBeVisible();

    const label = panel.locator('.readiness-panel__requirement-label').first();
    await expect(label).toBeVisible();
    // The collapsed bug rendered the label at ~3px (one char per line). With the
    // width floor it keeps a readable share of the 320px rail.
    const width = await label.evaluate((el) => (el as HTMLElement).clientWidth);
    expect(width).toBeGreaterThan(100);
  });

  test('shows the not-configured empty state', async ({ page }) => {
    await page.route('**/api/projects/dev/readiness*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { configured: false, reason: 'no-veritas-dir' },
        }),
      }),
    );

    await page.goto('/projects/dev/layouts/code');
    await dismissSetupLauncher(page);
    await openReadinessTab(page);

    const panel = page.getByRole('region', { name: 'Merge readiness' });
    await expect(panel.getByText('Veritas not configured')).toBeVisible();
    await expect(panel.getByText('Not ready')).toHaveCount(0);
  });
});
