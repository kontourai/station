import { expect, test } from '@playwright/test';

const MOCK_USAGE = {
  lifetime: {
    totalMessages: 42,
    totalCost: 1.23,
    totalConversations: 5,
    firstMessageDate: '2026-01-15T10:00:00Z',
    streak: 3,
  },
  byModel: {
    'anthropic.claude-3-sonnet': { messages: 30, cost: 0.9, tokens: 50000 },
    'anthropic.claude-3-haiku': { messages: 12, cost: 0.33, tokens: 20000 },
  },
  byAgent: {
    default: { messages: 35, cost: 1.0, conversations: 4 },
    coder: { messages: 7, cost: 0.23, conversations: 1 },
  },
  byDate: {
    '2026-04-01': { messages: 2, cost: 0.08, byAgent: { default: 2 } },
    '2026-04-02': {
      messages: 4,
      cost: 0.12,
      byAgent: { default: 3, coder: 1 },
    },
    '2026-04-03': { messages: 1, cost: 0.04, byAgent: { coder: 1 } },
    '2026-04-04': { messages: 6, cost: 0.2, byAgent: { default: 6 } },
  },
};

const MOCK_ACHIEVEMENTS = [
  {
    id: 'first-message',
    name: 'First Message',
    description: 'Send your first message',
    unlocked: true,
    progress: 100,
  },
  {
    id: 'power-user',
    name: 'Power User',
    description: 'Send 100 messages',
    unlocked: false,
    progress: 42,
  },
];

const MOCK_INSIGHTS = {
  toolUsage: {
    Bash: { calls: 8, errors: 2 },
    apply_patch: { calls: 2, errors: 0 },
  },
  hourlyActivity: Array.from({ length: 24 }, (_, hour) =>
    hour === 9 ? 12 : hour === 14 ? 6 : 0,
  ),
  agentUsage: { default: { chats: 4, tokens: 0 } },
  modelUsage: { 'claude-3': 4 },
  totalChats: 4,
  totalToolCalls: 10,
  totalErrors: 2,
  days: 14,
};

const STATUS_READY = {
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [
      {
        id: 'profile-test-runtime',
        type: 'codex',
        enabled: true,
        capabilities: ['llm'],
      },
    ],
    detected: { ollama: false, bedrock: false },
  },
  capabilities: {
    chat: {
      ready: true,
      source: 'profile-test-runtime',
    },
  },
};

function setupRoutes(page: import('@playwright/test').Page) {
  return Promise.all([
    page.route('**/api/analytics/usage*', (route) => {
      if (route.request().method() === 'DELETE') {
        return route.fulfill({ json: { success: true } });
      }
      return route.fulfill({ json: { data: MOCK_USAGE } });
    }),
    page.route('**/api/analytics/achievements', (route) =>
      route.fulfill({ json: { data: MOCK_ACHIEVEMENTS } }),
    ),
    page.route('**/api/insights*', (route) =>
      route.fulfill({ json: { data: MOCK_INSIGHTS } }),
    ),
    page.route('**/api/feedback/ratings', (route) =>
      route.fulfill({ json: { data: [] } }),
    ),
    page.route('**/api/feedback/guidelines', (route) =>
      route.fulfill({ json: { data: null } }),
    ),
    page.route('**/api/feedback/status', (route) =>
      route.fulfill({
        json: { data: { isAnalyzing: false, analyzeCallbackAvailable: true } },
      }),
    ),
    page.route('**/api/agents', (route) =>
      route.fulfill({ json: { success: true, data: [] } }),
    ),
    page.route('**/config/app', (route) =>
      route.fulfill({
        json: { success: true, data: { defaultModel: 'test' } },
      }),
    ),
    page.route('**/api/system/status', (route) =>
      route.fulfill({
        json: STATUS_READY,
      }),
    ),
    page.route('**/api/system/capabilities', (route) =>
      route.fulfill({
        json: {
          runtime: 'voltagent',
          voice: { stt: [], tts: [] },
          context: { providers: [] },
          scheduler: true,
        },
      }),
    ),
    page.route('**/api/models/**', (route) =>
      route.fulfill({ json: { success: true, data: [] } }),
    ),
    page.route('**/api/branding', (route) =>
      route.fulfill({ json: { success: true, data: {} } }),
    ),
    page.route('**/api/analytics/rescan', (route) =>
      route.fulfill({ json: { data: MOCK_USAGE } }),
    ),
    page.route('**/events', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"event":"connected"}\n\n',
      }),
    ),
  ]);
}

test.describe('Profile Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'station-connect-connections',
        JSON.stringify([
          {
            id: 'profile-server',
            name: 'Profile Test Server',
            url: window.location.origin,
            lastConnected: Date.now(),
          },
        ]),
      );
      localStorage.setItem(
        'station-connect-connections-active',
        'profile-server',
      );
    });
    await setupRoutes(page);
  });

  test('navigates to profile via the header avatar menu', async ({ page }) => {
    await page.goto('/');
    // #1552 D1: the avatar opens a menu (Profile / Ask Station for help / Open
    // settings) rather than navigating straight to the profile. Profile leads
    // it, so the destination is one press further and is now named.
    await page.getByRole('button', { name: 'Profile and settings' }).click();
    await page.getByRole('menuitem', { name: 'Profile', exact: true }).click();
    await expect(page).toHaveURL(/\/profile/);
    await expect(page.locator('.profile-page')).toBeVisible();
  });

  test('displays hero card with usage stats', async ({ page }) => {
    await page.goto('/profile');
    await expect(page.locator('.profile-hero-title')).toBeVisible();
    await expect(page.locator('.profile-hero-subtitle')).toContainText(
      '42 messages',
    );
    await expect(page.getByLabel('Usage activity overview')).toBeVisible();
  });

  test('renders chart columns inside the first hero card when activity data exists', async ({
    page,
  }) => {
    await page.goto('/profile');

    const heroCard = page.locator('.profile-container > .profile-card').first();
    await expect(
      heroCard.locator('[aria-label="Usage activity overview"]'),
    ).toBeVisible();
    await expect(
      heroCard.locator('.profile-usage-graph__bar').first(),
    ).toBeVisible();
  });

  test('renders activity timeline columns when activity data exists', async ({
    page,
  }) => {
    await page.goto('/profile');

    await expect(
      page.locator('.profile-timeline [data-testid^="chart-col-"]').first(),
    ).toBeVisible();
  });

  test('renders usage stats panel with stat cards', async ({ page }) => {
    await page.goto('/profile');
    const panel = page.locator('.usage-stats-panel');
    await expect(panel.getByText('Messages')).toBeVisible();
    await expect(panel.getByText('Conversations')).toBeVisible();
    await expect(panel.getByText('Total Cost')).toBeVisible();
    await expect(panel.getByText('Avg/Message')).toBeVisible();
    await expect(panel.getByText('42')).toBeVisible();
  });

  test('switches between Usage and Feedback tabs', async ({ page }) => {
    await page.goto('/profile');
    // Usage tab active by default
    const usageTab = page.getByRole('button', { name: 'Usage' });
    const feedbackTab = page.getByRole('button', { name: 'Feedback' });
    await expect(usageTab).toHaveClass(/is-active/);

    // Switch to Feedback
    await feedbackTab.click();
    await expect(feedbackTab).toHaveClass(/is-active/);
    await expect(page.getByText('No ratings yet')).toBeVisible();

    // Switch back to Usage
    await usageTab.click();
    await expect(usageTab).toHaveClass(/is-active/);
  });

  test('renders populated insights values and visible hourly activity bars', async ({
    page,
  }) => {
    await page.goto('/profile');
    await expect(page.getByText('Tool Calls')).toBeVisible();
    await expect(page.getByText('10', { exact: true })).toBeVisible();
    await expect(
      page.locator('.insights-stat-value').filter({ hasText: /^2$/ }),
    ).toBeVisible();
    await expect(page.getByText('Bash')).toBeVisible();
    await expect(page.getByText('8 (2 err)')).toBeVisible();
    await expect(page.locator('.insights-bar-fill.has-errors')).toHaveCount(1);
    const bars = page.locator('.insights-hourly-bar.has-data');
    await expect(bars).toHaveCount(2);
    const [maxBarHeight, halfValueBarHeight] = await bars.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );
    expect(maxBarHeight).toBeGreaterThan(0);
    expect(maxBarHeight).toBeGreaterThan(halfValueBarHeight);
  });

  test('time period filters change active state', async ({ page }) => {
    await page.goto('/profile');
    // Click Feedback tab first (it has the time pills visible without data)
    // Actually Usage tab (InsightsDashboard) has the pills
    const pill7d = page.locator('.insights-pill', { hasText: '7d' });
    const pill14d = page.locator('.insights-pill', { hasText: '14d' });
    const pill30d = page.locator('.insights-pill', { hasText: '30d' });

    await expect(pill14d).toHaveClass(/is-active/);
    await pill7d.click();
    await expect(pill7d).toHaveClass(/is-active/);
    await pill30d.click();
    await expect(pill30d).toHaveClass(/is-active/);
  });

  test('reset confirmation dialog works', async ({ page }) => {
    await page.goto('/profile');
    const resetBtn = page.getByRole('button', { name: 'Reset' });
    await resetBtn.click();

    // Confirm dialog appears
    await expect(page.getByText('Reset Usage Statistics')).toBeVisible();
    await expect(page.getByText('This will permanently clear')).toBeVisible();

    // Cancel dismisses
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Reset Usage Statistics')).not.toBeVisible();

    // Open again and confirm
    await resetBtn.click();
    await page.getByRole('button', { name: 'Reset All' }).click();
    await expect(page.getByText('Reset Usage Statistics')).not.toBeVisible();
  });

  test('shows empty states with no data', async ({ page }) => {
    // The shared beforeEach mock is populated; this journey needs its own
    // empty insights payload or the tool/agent panels render data rows.
    await page.route('**/api/insights*', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: {
            toolUsage: {},
            hourlyActivity: Array(24).fill(0),
            agentUsage: {},
            modelUsage: {},
            totalChats: 0,
            totalToolCalls: 0,
            totalErrors: 0,
            days: 14,
          },
        },
      }),
    );
    await page.route('**/api/analytics/usage*', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: {
            data: {
              lifetime: {
                totalMessages: 0,
                totalCost: 0,
                totalConversations: 0,
              },
              byModel: {},
              byAgent: {},
              byDate: {},
              rangeSummary: {
                totalMessages: 0,
                totalDays: 0,
                activeDays: 0,
                avgPerDay: 0,
                totalCost: 0,
              },
            },
          },
        });
      }
      return route.fulfill({ json: { success: true } });
    });
    await page.goto('/profile');
    await expect(
      page.getByText('Start your journey with your first message'),
    ).toBeVisible();
    await expect(page.getByText('No tool usage yet')).toBeVisible();
    await expect(page.getByText('No agent usage yet')).toBeVisible();
    await expect(page.getByText('No model data yet')).toBeVisible();
    await expect(page.getByText('No agent data yet')).toBeVisible();
    await expect(
      page.locator('.profile-container > .profile-card').first(),
    ).toContainText(/No (usage|activity)/i);
  });

  test('mobile layout stacks vertically', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    // Stats grid should be single column at mobile
    const grid = page.locator('.profile-stats-grid');
    const box = await grid.boundingBox();
    if (box) {
      // In single-column mode, width should be close to viewport width
      expect(box.width).toBeLessThan(400);
    }
  });

  test('no console errors on profile page', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/profile');
    await expect(page.locator('.profile-page')).toBeVisible();
    await expect(page.locator('.usage-stats-panel')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('loading state appears before data loads', async ({ page }) => {
    // Delay the usage response
    await page.route('**/api/analytics/usage*', async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({ json: { data: MOCK_USAGE } });
    });
    await page.goto('/profile');
    await expect(page.getByText('Loading profile...')).toBeVisible();
  });
});
