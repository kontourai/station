import { expect, type Page, test } from '@playwright/test';

const BASE_EVENTS = [
  {
    timestamp: '2026-04-26T16:00:00.100Z',
    'timestamp.ms': 100,
    'trace.id': 'trace-agent-start-0001',
    'gen_ai.operation.name': 'invoke_agent',
    'span.kind': 'start',
    'station.agent.slug': 'planner-agent',
    'gen_ai.conversation.id': 'conversation:alpha-123456',
    'station.input.chars': 420,
  },
  {
    timestamp: '2026-04-26T16:00:01.200Z',
    'timestamp.ms': 200,
    'trace.id': 'trace-tool-call-0002',
    'gen_ai.operation.name': 'execute_tool',
    'span.kind': 'start',
    'station.agent.slug': 'planner-agent',
    'gen_ai.conversation.id': 'conversation:alpha-123456',
    'gen_ai.tool.name': 'read_file',
    'gen_ai.tool.call.id': 'tool-call-alpha-000001',
    'gen_ai.tool.call.arguments': {
      path: 'docs/strategy/roadmap.md',
      config: { apiKey: '[REDACTED]' },
    },
  },
  {
    timestamp: '2026-04-26T16:00:02.300Z',
    'timestamp.ms': 300,
    'trace.id': 'trace-tool-result-0003',
    'gen_ai.operation.name': 'execute_tool',
    'span.kind': 'end',
    'station.agent.slug': 'planner-agent',
    'gen_ai.conversation.id': 'conversation:alpha-123456',
    'gen_ai.tool.name': 'read_file',
    'gen_ai.tool.call.id': 'tool-call-alpha-000001',
    'gen_ai.tool.call.result': {
      ok: true,
      lines: 42,
      connection: 'postgres://[REDACTED]@db.example.test/app',
    },
  },
  {
    timestamp: '2026-04-26T16:00:03.400Z',
    'timestamp.ms': 400,
    'trace.id': 'trace-health-0004',
    'gen_ai.operation.name': 'invoke_agent',
    'span.kind': 'log',
    'station.agent.slug': 'review-agent',
    'station.health.healthy': false,
    'station.health.checks': { runtime: true, model: false },
    'station.health.integrations': [
      {
        id: 'codex-acp',
        type: 'acp',
        connected: false,
        metadata: { transport: 'stdio', toolCount: 8 },
      },
    ],
  },
  {
    timestamp: '2026-04-26T16:00:04.500Z',
    'timestamp.ms': 500,
    'trace.id': 'trace-reasoning-0005',
    'gen_ai.operation.name': 'chat',
    'span.kind': 'event',
    'station.agent.slug': 'historical-agent',
    'station.reasoning.text':
      'Need to verify the monitoring lane before closing coverage. Bearer [REDACTED]',
  },
];

async function seedMonitoringRoutes(page: Page) {
  const historyRequests: string[] = [];

  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      url: string;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        super();
        this.url = url;
        setTimeout(() => {
          const event = new Event('open');
          this.dispatchEvent(event);
          this.onopen?.(event);
        }, 0);
      }

      close() {
        this.readyState = 2;
      }
    }

    window.EventSource = MockEventSource as unknown as typeof EventSource;
  });

  await page.route('**/monitoring/stats', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          agents: [
            {
              slug: 'planner-agent',
              name: 'Planner Agent',
              status: 'running',
              model: 'gpt-5.5',
              conversationCount: 1,
              messageCount: 12,
              cost: 0.031,
              healthy: true,
            },
            {
              slug: 'review-agent',
              name: 'Review Agent',
              status: 'active',
              model: 'gpt-5.4-mini',
              conversationCount: 1,
              messageCount: 7,
              cost: 0.014,
              healthy: false,
            },
          ],
          summary: {
            totalAgents: 2,
            activeAgents: 2,
            runningAgents: 1,
            totalMessages: 19,
            totalCost: 0.045,
          },
        },
      }),
    });
  });

  await page.route('**/monitoring/metrics?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          metrics: [
            {
              agentSlug: 'planner-agent',
              messageCount: 12,
              conversationCount: 1,
              totalCost: 0.031,
            },
            {
              agentSlug: 'review-agent',
              messageCount: 7,
              conversationCount: 1,
              totalCost: 0.014,
            },
          ],
        },
      }),
    });
  });

  await page.route('**/monitoring/events?*', async (route) => {
    const requestUrl = route.request().url();
    historyRequests.push(requestUrl);
    const url = new URL(requestUrl);
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    const isClearAllRange =
      start &&
      end &&
      Math.abs(new Date(end).getTime() - new Date(start).getTime()) < 60_000;

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: isClearAllRange ? [] : BASE_EVENTS,
      }),
    });
  });

  return { historyRequests };
}

test.describe('Monitoring', () => {
  test('monitoring covers history, filters, search, sidebar, metrics, and time ranges', async ({
    page,
  }) => {
    const { historyRequests } = await seedMonitoringRoutes(page);

    await page.goto('/developer/telemetry');

    // Monitoring is a Developer tab now, not a page-layout root of its own:
    // `MonitoringView.tsx:274` renders `pane-host monitoring-page`, and the
    // `page__title` above it belongs to the Developer page frame, which prints
    // the ACTIVE TAB's label ("Telemetry") under the "Developer" eyebrow
    // (`DeveloperView.tsx:40-42`, `page-frame-registry.ts:85`). The old
    // `.page.page--full` classes moved off this view with that change, so the
    // three-class selector matched nothing.
    //
    // Kept as a class assertion rather than dropped: it is what proves the
    // route mounted the Monitoring view itself instead of an empty Developer
    // shell, and the heading assertion below cannot — `MonitoringHeader`'s
    // "Monitoring" title renders inside the view either way.
    await expect(page.locator('.pane-host.monitoring-page')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole('heading', { name: 'Monitoring' }),
    ).toBeVisible();
    await expect(
      page.getByLabel(/Monitoring connection connected/i),
    ).toBeVisible();
    await expect(page.getByText('Planner Agent')).toBeVisible();
    await expect(page.getByText('Review Agent')).toBeVisible();
    await expect(page.getByText('2 Active • 1 Historical')).toBeVisible();
    // exact:true — the bare form strict-mode-collides with the time-range
    // sublabel whenever the wall-clock minute matches the metric (e.g.
    // "02:19 PM" vs totalMessages 19). Found at S2 close; inherited flake.
    await expect(page.getByText('19', { exact: true })).toBeVisible();
    await expect(page.getByText('Messages', { exact: true })).toBeVisible();

    const logEntries = page.locator('.log-entry');
    await expect(logEntries).toHaveCount(5);
    await expect(logEntries.filter({ hasText: 'AGENT-START' })).toHaveCount(1);
    await expect(logEntries.filter({ hasText: 'TOOL-CALL' })).toHaveCount(1);
    await expect(logEntries.filter({ hasText: 'REASONING' })).toHaveCount(1);
    // Redacted payload fields may be omitted from the collapsed log summary;
    // the security contract is that their original values never reach the UI.
    await expect(page.locator('body')).not.toContainText('api-key-secret');
    await expect(page.locator('body')).not.toContainText('tool-result-secret');

    await page.getByRole('button', { name: 'TOOL' }).click();
    await expect(logEntries).toHaveCount(3);
    await expect(logEntries.filter({ hasText: 'read_file' })).toHaveCount(0);

    await page.getByRole('button', { name: 'TOOL' }).click();
    await page
      .getByPlaceholder(/Search logs/i)
      .fill('Need to verify the monitoring lane');
    await expect(logEntries).toHaveCount(1);
    await expect(logEntries.filter({ hasText: 'REASONING' })).toHaveCount(1);

    await page.getByTitle('Clear search').click();
    await expect(logEntries).toHaveCount(5);

    await page.getByText('Planner Agent').click();
    await expect(page.getByText('agent:planner-agent')).toBeVisible();
    await expect(logEntries).toHaveCount(3);

    await page
      .locator('.filter-badge-inline')
      .filter({ hasText: 'agent:planner-agent' })
      .getByRole('button')
      .click();
    await expect(logEntries).toHaveCount(5);

    await logEntries
      .filter({ hasText: 'AGENT-START' })
      .getByTitle('Filter by conversation')
      .click();
    await expect(page.getByText(/conversation:alpha-/)).toBeVisible();
    await expect(logEntries).toHaveCount(3);

    await page.reload();
    await expect(logEntries).toHaveCount(5);

    await logEntries
      .filter({ hasText: 'TOOL-CALL' })
      .getByTitle('Filter by tool call ID')
      .click();
    await expect(page.getByText('tool:tool-call-alpha-000001')).toBeVisible();
    await expect(logEntries).toHaveCount(2);

    await page.reload();
    await expect(logEntries).toHaveCount(5);

    await logEntries
      .filter({ hasText: 'HEALTH' })
      .getByTitle(/trace-health-0004/)
      .click();
    await expect(page.getByText('trace:...lth-0004')).toBeVisible();
    await expect(logEntries).toHaveCount(1);

    await page
      .locator('.filter-badge-inline')
      .filter({ hasText: 'trace:...lth-0004' })
      .getByRole('button')
      .click();

    const initialHistoryCount = historyRequests.length;
    await page.getByRole('button', { name: /Last 5 min/i }).click();
    await page.getByRole('button', { name: 'Relative' }).click();
    await page.getByRole('button', { name: /Last 15 minutes/i }).click();
    await expect
      .poll(() => historyRequests.length)
      .toBeGreaterThan(initialHistoryCount);

    const latestHistoryUrl = new URL(
      historyRequests[historyRequests.length - 1],
    );
    expect(latestHistoryUrl.searchParams.get('start')).toBeTruthy();
    expect(latestHistoryUrl.searchParams.get('end')).toBeTruthy();

    await page.getByRole('button', { name: 'CLEAR ALL' }).click();
    await expect(logEntries).toHaveCount(0);
    await expect(page.getByText('No events yet')).toBeVisible();
    await expect(page.getByText('Waiting for agent activity...')).toBeVisible();
  });
});
