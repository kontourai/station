import type { UsageStats } from '@kontourai/station-contracts/usage-stats';
import { expect, type Page } from '@playwright/test';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const reports = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const usage: UsageStats = {
  snapshot: {
    projection: 'retained-source-v1',
    dayScope: 'recorded-observations-utc',
    rescannedAt: new Date().toISOString(),
    engineUsage: 'available',
    skippedMessages: 0,
    costCoverageChecked: true,
    missingEngineTurnCosts: 30,
  },
  lifetime: {
    totalMessages: 42,
    totalCost: 1.23,
    reportedCostUsd: 1.23,
    totalConversations: 5,
    totalInputTokens: 55_000,
    totalOutputTokens: 15_000,
    uniqueAgents: ['default', 'coder'],
    firstMessageDate: yesterday,
    lastMessageDate: today,
    daysActive: 2,
    streak: 2,
    engineUsageCoverage: {
      sessions: 5,
      sessionsReportingTokens: 2,
      sessionsReportingCost: 2,
    },
  },
  byModel: {
    sonnet: {
      messages: 30,
      cost: 0.9,
      reportedCostUsd: 0.9,
      inputTokens: 40_000,
      outputTokens: 10_000,
      tokenReports: reports,
    },
    haiku: {
      messages: 12,
      cost: 0.33,
      reportedCostUsd: 0.33,
      inputTokens: 15_000,
      outputTokens: 5_000,
      tokenReports: reports,
    },
  },
  byAgent: {
    default: { messages: 35, cost: 1, reportedCostUsd: 1, conversations: 4 },
    coder: { messages: 7, cost: 0.23, reportedCostUsd: 0.23, conversations: 1 },
  },
  byDate: {
    [today]: {
      messages: 35,
      cost: 0.9,
      reportedCostUsd: 0.9,
      inputTokens: 40_000,
      outputTokens: 10_000,
      byAgent: { default: 35 },
    },
    [yesterday]: {
      messages: 7,
      cost: 0.33,
      reportedCostUsd: 0.33,
      inputTokens: 15_000,
      outputTokens: 5_000,
      byAgent: { coder: 7 },
    },
  },
};
const insights = {
  toolUsage: {
    Bash: { calls: 8, errors: 2 },
    apply_patch: { calls: 2, errors: 0 },
  },
  hourlyActivity: Array.from({ length: 24 }, (_, hour) =>
    hour === 9 ? 12 : hour === 14 ? 6 : 0,
  ),
  agentUsage: { default: { chats: 4, tokens: 0 } },
  modelUsage: { sonnet: 4 },
  totalChats: 4,
  totalToolCalls: 10,
  totalErrors: 2,
  days: 14,
};

const sourceStates = new WeakMap<Page, { usage: UsageStats }>();

async function setupRoutes(page: Page) {
  const state = { usage };
  sourceStates.set(page, state);
  await page.route(
    (url) => url.pathname === '/api/analytics/usage',
    async (route) => {
      if (route.request().method() !== 'GET')
        return rejectUnexpectedFixtureRequest(route);
      const url = new URL(route.request().url());
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const byDate = Object.fromEntries(
        Object.entries(state.usage.byDate).filter(
          ([date]) => (!from || date >= from) && (!to || date <= to),
        ),
      );
      const rows = Object.values(byDate);
      await route.fulfill({
        json: {
          success: true,
          data: {
            ...state.usage,
            byDate,
            ...(from && to
              ? {
                  rangeSummary: {
                    totalDays:
                      (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1,
                    activeDays: rows.length,
                    totalMessages: rows.reduce(
                      (sum, row) => sum + row.messages,
                      0,
                    ),
                    totalCost: rows.reduce((sum, row) => sum + row.cost, 0),
                    avgPerDay: rows.length
                      ? rows.reduce((sum, row) => sum + row.messages, 0) /
                        rows.length
                      : 0,
                  },
                }
              : {}),
          },
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/insights',
    async (route) => {
      if (route.request().method() !== 'GET')
        return rejectUnexpectedFixtureRequest(route);
      await route.fulfill({ json: { success: true, data: insights } });
    },
  );
}

async function openDiagnostics(page: Page) {
  await page
    .locator('summary')
    .filter({ hasText: /^Diagnostics/ })
    .click();
  await expect(page.getByText('Tool Calls', { exact: true })).toBeVisible();
}

test.describe('Profile retained usage', () => {
  test.beforeEach(async ({ page }) => {
    await setupRoutes(page);
  });

  test('navigates through the avatar menu', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Profile and settings' }).click();
    await page.getByRole('menuitem', { name: 'Profile', exact: true }).click();
    await expect(page).toHaveURL(/\/profile/);
    await expect(
      page.locator('.usage-stats-panel').getByText('42', { exact: true }),
    ).toBeVisible();
  });

  test('shows Station scope, retained totals and the populated recent chart', async ({
    page,
  }) => {
    await page.goto('/profile');
    await expect(page.locator('.profile-hero-subtitle')).toContainText(
      'connected Station',
    );
    const panel = page.locator('.usage-stats-panel');
    await expect(panel.getByText('42', { exact: true })).toBeVisible();
    await expect(panel.getByText('$1.23', { exact: true })).toBeVisible();
    await expect(panel.getByText('Active days', { exact: true })).toBeVisible();
    await expect(panel.getByText(/Measured on 2 of 5/)).toBeVisible();
    await expect(panel.getByText('Avg/Message')).toHaveCount(0);
    const bar = page.locator(
      '.profile-usage-graph__bar[title*="35 recorded messages"]',
    );
    await expect(bar).toBeVisible();
    expect((await bar.boundingBox())!.height).toBeGreaterThan(2);
  });

  test('period control scopes the summary without relabeling lifetime rankings', async ({
    page,
  }) => {
    await page.goto('/profile');
    await page.getByText('Today', { exact: true }).click();
    const panel = page.locator('.usage-stats-panel');
    await expect(panel.getByText('35', { exact: true })).toBeVisible();
    await expect(panel.getByText('$0.90', { exact: true })).toBeVisible();
    await expect(
      panel.getByText('Model and agent breakdowns · all time'),
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: /sonnet/ })).toContainText(
      '30 msgs',
    );
  });

  test('opens history and model details through real controls', async ({
    page,
  }) => {
    await page.goto('/profile');
    await page
      .locator('summary')
      .filter({ hasText: /^Activity history/ })
      .click();
    await expect(
      page.locator('[data-testid^="chart-col-"]').first(),
    ).toBeVisible();
    await page
      .locator('.usage-stats-panel')
      .getByRole('button', { name: /sonnet/ })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('40,000', { exact: true })).toBeVisible();
    await expect(dialog.getByText('$0.90', { exact: true })).toBeVisible();
    await dialog
      .getByRole('button', { name: 'Close model usage details' })
      .click();
    await expect(dialog).toHaveCount(0);
  });

  test('closed diagnostics do not request insights, and opened diagnostics show real chart geometry', async ({
    page,
  }) => {
    let requests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/insights') requests++;
    });
    const runtimeErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    await page.goto('/profile');
    await expect(page.locator('.usage-stats-panel')).toBeVisible();
    expect(requests).toBe(0);
    await openDiagnostics(page);
    await expect(page.getByText('8 (2 err)', { exact: true })).toBeVisible();
    const bars = page.locator('.insights-hourly-bar.has-data');
    await expect(bars).toHaveCount(2);
    const heights = await bars.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );
    expect(heights[0]).toBeGreaterThan(heights[1]);
    expect(heights[1]).toBeGreaterThan(0);
    expect(runtimeErrors).toEqual([]);
  });

  test('diagnostic period controls preserve their selected state', async ({
    page,
  }) => {
    await page.goto('/profile');
    await openDiagnostics(page);
    await page.locator('.insights-pill', { hasText: '7d' }).click();
    await expect(page.locator('.insights-pill', { hasText: '7d' })).toHaveClass(
      /is-active/,
    );
    await page.locator('.insights-pill', { hasText: '30d' }).click();
    await expect(
      page.locator('.insights-pill', { hasText: '30d' }),
    ).toHaveClass(/is-active/);
  });

  test('diagnostic Usage and Feedback tabs remain usable inside the disclosure', async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname === '/api/feedback/ratings',
      async (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        await route.fulfill({ json: { success: true, data: [] } });
      },
    );
    await page.goto('/profile');
    await openDiagnostics(page);
    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    await expect(page.getByText(/^No ratings yet\./)).toBeVisible();
    await page.getByRole('button', { name: 'Usage', exact: true }).click();
    await expect(page.getByText('8 (2 err)', { exact: true })).toBeVisible();
  });

  test('an empty retained source shows an honest empty chart and unreported cost', async ({
    page,
  }) => {
    const empty: UsageStats = {
      ...usage,
      snapshot: { ...usage.snapshot!, missingEngineTurnCosts: 0 },
      lifetime: {
        ...usage.lifetime,
        streak: 0,
        totalMessages: 0,
        totalConversations: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        reportedCostUsd: undefined,
        daysActive: 0,
        uniqueAgents: [],
        firstMessageDate: undefined,
        lastMessageDate: undefined,
        engineUsageCoverage: {
          sessions: 0,
          sessionsReportingTokens: 0,
          sessionsReportingCost: 0,
        },
      },
      byModel: {},
      byAgent: {},
      byDate: {},
    };
    await page.route(
      (url) => url.pathname === '/api/analytics/usage',
      async (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        await route.fulfill({ json: { success: true, data: empty } });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/insights',
      async (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        await route.fulfill({
          json: {
            success: true,
            data: {
              ...insights,
              toolUsage: {},
              agentUsage: {},
              modelUsage: {},
              hourlyActivity: Array(24).fill(0),
              totalChats: 0,
              totalToolCalls: 0,
              totalErrors: 0,
            },
          },
        });
      },
    );
    await page.goto('/profile');
    await expect(
      page.getByText('Daily activity not recorded in the last 14 days', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page
        .locator('.usage-stats-panel')
        .getByText('Not reported', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('No model data yet', { exact: true }),
    ).toBeVisible();
    await page
      .locator('summary')
      .filter({ hasText: /^Diagnostics/ })
      .click();
    await expect(
      page.getByText('No tool usage yet', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('No agent usage yet', { exact: true }),
    ).toBeVisible();
  });

  test('initial loading does not render fabricated zero totals', async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === '/api/analytics/usage',
      async (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        await gate;
        await route.fulfill({ json: { success: true, data: usage } });
      },
    );
    await page.goto('/profile');
    try {
      await expect(
        page.getByRole('status', { name: 'Loading profile', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.usage-stats-panel')).toHaveCount(0);
    } finally {
      release();
    }
    await expect(
      page.locator('.usage-stats-panel').getByText('42', { exact: true }),
    ).toBeVisible();
  });

  test('rebuild dispatches once and refreshes the visible source snapshot', async ({
    page,
  }) => {
    let rebuilds = 0;
    const state = sourceStates.get(page)!;
    await page.route(
      (url) => url.pathname === '/api/analytics/rescan',
      async (route) => {
        if (route.request().method() !== 'POST')
          return rejectUnexpectedFixtureRequest(route);
        rebuilds++;
        state.usage = {
          ...usage,
          snapshot: { ...usage.snapshot!, missingEngineTurnCosts: 31 },
          lifetime: { ...usage.lifetime, totalMessages: 43 },
          byModel: {
            ...usage.byModel,
            sonnet: { ...usage.byModel.sonnet, messages: 31 },
          },
          byAgent: {
            ...usage.byAgent,
            default: { ...usage.byAgent.default, messages: 36 },
          },
          byDate: {
            ...usage.byDate,
            [today]: {
              ...usage.byDate[today],
              messages: 36,
              byAgent: { default: 36 },
            },
          },
        };
        await route.fulfill({ json: { success: true, data: state.usage } });
      },
    );
    await page.goto('/profile');
    const panel = page.locator('.usage-stats-panel');
    await expect(panel.getByText('42', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Rebuild usage' }).click();
    await expect.poll(() => rebuilds).toBe(1);
    await expect(
      page.getByRole('button', { name: 'Rebuild usage' }),
    ).toBeEnabled();
    await expect(panel.getByText('43', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /sonnet/ })).toContainText(
      '31 msgs',
    );
  });

  for (const width of [320, 390, 620]) {
    for (const theme of ['light', 'dark']) {
      test(`populated Profile fits ${width}px in ${theme} theme, including unclipped date endpoints`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto('/profile');
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        await expect(
          page.locator('.usage-stats-panel').getByText('42', { exact: true }),
        ).toBeVisible();
        const targetHeights = await page
          .locator('.usage-period-btn')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getBoundingClientRect().height),
          );
        expect(Math.min(...targetHeights)).toBeGreaterThanOrEqual(44);
        const graph = page.getByLabel('Usage activity overview');
        for (const date of [
          new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10),
          today,
        ]) {
          const dateLabel = new Date(`${date}T12:00:00Z`).toLocaleDateString(
            'en-US',
            { month: 'short', day: 'numeric', timeZone: 'UTC' },
          );
          const label = graph.getByText(dateLabel, { exact: true });
          await expect(label).toBeVisible();
          const geometry = await label.evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const text = range.getBoundingClientRect();
            const graph = node
              .closest('.profile-usage-graph')!
              .getBoundingClientRect();
            const card = node.closest('.profile-card')!.getBoundingClientRect();
            return {
              textLeft: text.left,
              textRight: text.right,
              graphLeft: graph.left,
              graphRight: graph.right,
              cardLeft: card.left,
              cardRight: card.right,
              viewport: window.innerWidth,
            };
          });
          expect(geometry.textLeft).toBeGreaterThanOrEqual(
            Math.max(0, geometry.graphLeft, geometry.cardLeft) - 1,
          );
          expect(geometry.textRight).toBeLessThanOrEqual(
            Math.min(
              geometry.viewport,
              geometry.graphRight,
              geometry.cardRight,
            ) + 1,
          );
        }
        const bounds = await page.locator('.profile-page').evaluate((node) => {
          const r = node.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            viewport: window.innerWidth,
            scroll: node.scrollWidth,
            width: node.clientWidth,
          };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(-1);
        expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
        expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
      });
    }
  }
});
