import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { expect, type Page } from '@playwright/test';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  openChatRegion,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

const json = (data: unknown) => ({ json: { success: true, data } });
const base = {
  provider: 'codex',
  threadId: 'session-1',
  turnId: 'turn-1',
  createdAt: new Date().toISOString(),
} as const;

async function setup(
  page: Page,
  enabled: boolean,
  decoy: Partial<{
    browserSessionId: string;
    projectId: string;
    projectSlug: string;
    principalKey: string;
    threadId: string;
  }> = {},
) {
  await seedActiveChats(page, [
    {
      sessionId: 'session-1',
      conversationId: 'conv-1',
      agentSlug: 'dev-agent',
      projectSlug: 'dev',
      model: 'gpt-5',
      provider: 'codex',
      agentConnectionId: 'codex',
      orchestrationSessionStarted: true,
      ephemeralMessages: [],
      inputHistory: [],
    },
  ]);
  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page, {
    executionBySession: {
      'session-1': {
        sessionId: 'session-1',
        agentId: agentId('dev-agent'),
        provider: 'codex',
        engineConnectionId: engineConnectionId('codex'),
        model: 'gpt-5',
      },
    },
  });
  await page.route('**/api/connections/agents', (route) => {
    if (route.request().method() !== 'GET')
      return rejectUnexpectedFixtureRequest(route);
    return route.fulfill(
      json([agentConnectionFixture({ id: 'codex', type: 'codex' })]),
    );
  });
  await installMockOrchestrationEventWindow(page, 'codex', {
    'session-1': [
      {
        ...base,
        turnId: 'turn-0',
        method: 'turn.started',
        prompt: 'Inspect the page',
      },
      {
        ...base,
        turnId: 'turn-0',
        method: 'turn.completed',
        outputText: 'Ready.',
      },
    ],
  });
  await installMockOrchestrationConversationEventWindow(page, (id) =>
    id === 'conv-1' ? ['session-1'] : [],
  );
  await page.route('**/api/orchestration/sessions/read-model', (route) => {
    if (route.request().method() !== 'GET')
      return rejectUnexpectedFixtureRequest(route);
    return route.fulfill(
      json([
        {
          threadId: 'session-1',
          provider: 'codex',
          projectSlug: 'dev',
          status: 'running',
          lifecycleState: 'running',
          hasActiveTurn: true,
          controlMode: 'station-owned',
          answerability: { answerable: true },
          isLoaded: true,
          isPersisted: true,
          eventCount: 2,
          createdAt: base.createdAt,
          updatedAt: base.createdAt,
        },
      ]),
    );
  });
  await page.route('**/api/feature-previews', (route) => {
    if (route.request().method() !== 'GET')
      return rejectUnexpectedFixtureRequest(route);
    return route.fulfill(
      json([
        {
          id: 'inline-browser-activity',
          label: 'Inline browser activity',
          description: 'Browser activity in chat',
          enabled,
        },
      ]),
    );
  });
  await page.route('**/api/browser/projects/dev/access', (route) => {
    if (route.request().method() !== 'GET')
      return rejectUnexpectedFixtureRequest(route);
    return route.fulfill(
      json({
        projectId: 'p1',
        principalKey: 'operator',
        role: 'operator',
        operator: true,
        browser: 'ready',
      }),
    );
  });
  await page.route('**/api/browser/sessions?*', (route) => {
    if (
      route.request().method() !== 'GET' ||
      new URL(route.request().url()).searchParams.get('projectSlug') !== 'dev'
    )
      return rejectUnexpectedFixtureRequest(route);
    return route.fulfill(
      json([
        {
          browserSessionId: 'browser-1',
          projectId: 'p1',
          projectSlug: 'dev',
          principalKey: 'operator',
          reach: 'operator',
          threadId: 'session-1',
          url: 'https://example.com/',
          viewport: { width: 1280, height: 720 },
          generation: 1,
          state: 'live',
          surfaceId: 'surface-1',
          createdAt: base.createdAt,
          updatedAt: base.createdAt,
          history: { entries: [], total: 0 },
          activity: { agentDriven: true },
          ...decoy,
        },
      ]),
    );
  });
  // The transport is deliberately unavailable: the test proves the rendered
  // controls and identity binding, not production browser frame delivery.
  await page.route('**/api/live-surfaces/surface-1/frames**', (route) => {
    if (route.request().method() !== 'GET')
      return rejectUnexpectedFixtureRequest(route);
    return route.fulfill({
      status: 503,
      json: { success: false, error: 'fixture stream unavailable' },
    });
  });
  await page.goto('/projects/dev/layouts/code?chat=conv-1');
  await dismissSetupLauncher(page);
  await openChatRegion(page);
  await waitForMockOrchestrationSse(page);
  await expect(page.getByText('Ready.', { exact: true })).toBeVisible();
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: { ...base, method: 'turn.started', prompt: 'Inspect the page' },
  });
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'tool.started',
      itemId: 'browser-call',
      toolCallId: 'browser-call',
      toolName: 'mcp__station-browser__browser_navigate',
      arguments: { browserSessionId: 'browser-1', url: 'https://example.com/' },
    },
  });
}

test('preview off keeps the ordinary transcript', async ({
  page,
}, testInfo) => {
  await setup(page, false);
  await expect(page.locator('.streaming-message .tool-call')).toBeVisible();
  await expect(page.getByText('Browser activity', { exact: true })).toHaveCount(
    0,
  );
  const capture = testInfo.outputPath('inline-browser-preview-off.png');
  await page.screenshot({
    path: testInfo.outputPath('inline-browser-preview-off.png'),
    animations: 'disabled',
  });
  await testInfo.attach('inline-browser-preview-off', {
    path: capture,
    contentType: 'image/png',
  });
});

for (const width of [390, 1440]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`inline browser activity renders at ${width} in ${colorScheme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await setup(page, true);
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        colorScheme,
      );
      const activity = page.locator('.inline-browser-activity');
      await expect(activity).toContainText('In progress');
      await expect(activity).toContainText('1 tool call');
      await expect(
        activity.getByRole('button', { name: 'Float', exact: true }),
      ).toBeVisible();
      expect(
        await activity.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      const capture = testInfo.outputPath(
        `inline-browser-${width}-${colorScheme}.png`,
      );
      await page.screenshot({
        path: testInfo.outputPath(`inline-browser-${width}-${colorScheme}.png`),
        animations: 'disabled',
      });
      await testInfo.attach(`inline-browser-${width}-${colorScheme}`, {
        path: capture,
        contentType: 'image/png',
      });
      await activity
        .getByRole('button', { name: 'Float', exact: true })
        .click();
      await expect(activity).toContainText('Browser is floating.');
      await activity
        .getByRole('button', { name: 'Bring back', exact: true })
        .click();
      await expect(
        activity.getByRole('button', { name: 'Float', exact: true }),
      ).toBeVisible();
      await emitMockOrchestrationEvent(page, 'orchestration:event', {
        event: {
          ...base,
          method: 'tool.completed',
          itemId: 'browser-call',
          toolCallId: 'browser-call',
          toolName: 'mcp__station-browser__browser_navigate',
          output: 'Done',
          status: 'success',
        },
      });
      await emitMockOrchestrationEvent(page, 'orchestration:event', {
        event: { ...base, method: 'turn.completed', outputText: 'Done.' },
      });
      await expect(activity).toContainText('Past activity');
      await expect(
        activity.getByRole('button', { name: 'Float', exact: true }),
      ).toHaveCount(0);
    });
  }
}

for (const [name, decoy] of [
  ['session', { browserSessionId: 'other-browser' }],
  ['project id', { projectId: 'other-project' }],
  ['project slug', { projectSlug: 'other-project' }],
  ['principal', { principalKey: 'other-principal' }],
  ['thread', { threadId: 'other-thread' }],
] as const) {
  test(`refuses a browser session belonging to another ${name}`, async ({
    page,
  }) => {
    await setup(page, true, decoy);
    const activity = page.locator('.inline-browser-activity');
    await expect(activity).toContainText(
      'Browser session is unavailable for this conversation.',
    );
    await expect(
      activity.getByRole('button', { name: 'Float', exact: true }),
    ).toHaveCount(0);
  });
}

test('a mixed tool run and pending permission stay available', async ({
  page,
}) => {
  await setup(page, true);
  await expect(page.locator('.inline-browser-activity')).toContainText(
    'In progress',
  );
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'tool.started',
      itemId: 'shell-call',
      toolCallId: 'shell-call',
      toolName: 'shell_exec',
      arguments: { command: 'ls', cwd: '/tmp/test' },
    },
  });
  await expect(page.getByRole('button', { name: 'Running ls' })).toBeVisible();
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'request.opened',
      requestId: 'req-1',
      requestType: 'permission',
      title: 'Approve permissions',
      description: 'Needs network access',
      payload: { toolName: 'shell_exec' },
    },
  });
  const approval = page.getByRole('button', { name: /^Needs approval/ });
  await expect(approval).toBeVisible();
  await approval.click();
  await expect(
    page.getByText('Approval request', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow Once' })).toBeVisible();
});
