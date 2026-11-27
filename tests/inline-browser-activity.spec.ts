import { createServer, type Server } from 'node:http';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import {
  encodeLiveSurfaceRecord,
  LIVE_SURFACE_FRAMES_CONTENT_TYPE,
} from '@kontourai/station-contracts/live-surface';
import { expect, type Page, type TestInfo } from '@playwright/test';
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

// Controlled browser transport: real PNG decoding and drawing, not the host's
// Chromium producer. Keep that distinction in captures and qualification.
let frameServer: Server | undefined;
test.afterEach(async () => {
  if (!frameServer) return;
  const server = frameServer;
  frameServer = undefined;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function installFrameFixture(page: Page, testInfo: TestInfo) {
  const source = await page.context().newPage();
  await source.setViewportSize({ width: 1280, height: 720 });
  await source.setContent(`<!doctype html><html lang="en"><style>
    body { margin: 0; background: #f5f7fb; color: #17243a; font: 20px system-ui; }
    header { padding: 24px 40px; background: #17243a; color: white; }
    main { padding: 36px 40px; } h1 { margin: 0 0 12px; font-size: 36px; }
    section { display: flex; gap: 24px; margin: 28px 0; }
    article { background: white; border: 1px solid #cad2df; border-radius: 12px; padding: 24px; flex: 1; }
    strong { display: block; font-size: 32px; margin-top: 12px; }
    table { width: 100%; border-collapse: collapse; background: white; }
    td, th { padding: 18px; text-align: left; border-bottom: 1px solid #cad2df; }
  </style><header>Example workspace</header><main><h1>Release dashboard</h1>
  <p>Current deployment status</p><section><article>Services<strong>12 healthy</strong></article>
  <article>Checks<strong>37 passed</strong></article><article>Region<strong>us-east-1</strong></article></section>
  <table><tr><th>Service</th><th>Status</th><th>Updated</th></tr><tr><td>Web application</td><td>Healthy</td><td>Just now</td></tr>
  <tr><td>API</td><td>Healthy</td><td>2 minutes ago</td></tr></table></main></html>`);
  const png = await source.screenshot({
    path: testInfo.outputPath('controlled-browser-source.png'),
  });
  await source.close();
  let seq = 0;
  frameServer = createServer((request, response) => {
    if (
      request.method !== 'GET' ||
      !request.url?.startsWith('/api/live-surfaces/surface-1/frames')
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': LIVE_SURFACE_FRAMES_CONTENT_TYPE,
      'Access-Control-Allow-Origin': request.headers.origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
      'Cache-Control': 'no-store',
    });
    const publish = () => {
      response.write(
        encodeLiveSurfaceRecord({
          kind: 'state',
          state: {
            surfaceId: 'surface-1',
            lease: {
              surfaceId: 'surface-1',
              epoch: 1,
              holder: {
                kind: 'agent',
                principal: 'agent:dev-agent',
                sessionId: 'session-1',
              },
              expiresAt: Date.now() + 60_000,
            },
            viewer: {
              principal: 'human:local:operator',
              device: 'fixture-device',
            },
            effectiveParams: {
              maxFps: 2,
              quality: 70,
              maxWidth: 1280,
              maxHeight: 720,
            },
          },
        }),
      );
      response.write(
        encodeLiveSurfaceRecord({
          kind: 'frame',
          header: {
            surfaceId: 'surface-1',
            seq: ++seq,
            epoch: 1,
            codec: 'png',
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
            capturedAt: Date.now(),
          },
          body: png,
        }),
      );
    };
    publish();
    const timer = setInterval(publish, 500);
    response.once('close', () => clearInterval(timer));
  });
  const server = frameServer;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No frame fixture port');
  await page.route('**/api/live-surfaces/surface-1/frames**', (route) => {
    const url = new URL(route.request().url());
    return route.continue({
      url: `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
    });
  });
}

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
  if (enabled) await installFrameFixture(page, test.info());
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

async function continueBrowserWork(page: Page) {
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'tool.completed',
      itemId: 'browser-call',
      toolCallId: 'browser-call',
      toolName: 'mcp__station-browser__browser_navigate',
      output: 'Opened the dashboard.',
      status: 'success',
    },
  });
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'content.text-delta',
      delta:
        'The dashboard is open. Checking the release files before reading the page.',
    },
  });
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'tool.started',
      itemId: 'release-files',
      toolCallId: 'release-files',
      toolName: 'shell_exec',
      arguments: { command: 'ls', cwd: '/tmp/release-fixture' },
    },
  });
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'tool.completed',
      itemId: 'release-files',
      toolCallId: 'release-files',
      toolName: 'shell_exec',
      output: 'release.json',
      status: 'success',
    },
  });
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'tool.started',
      itemId: 'read-page',
      toolCallId: 'read-page',
      toolName: 'mcp__station-browser__browser_snapshot',
      arguments: { browserSessionId: 'browser-1' },
    },
  });
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'tool.completed',
      itemId: 'read-page',
      toolCallId: 'read-page',
      toolName: 'mcp__station-browser__browser_snapshot',
      output: '12 services healthy.',
      status: 'success',
    },
  });
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'content.text-delta',
      delta: 'The services are healthy. Opening the current deployment.',
    },
  });
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      ...base,
      method: 'tool.started',
      itemId: 'open-deployment',
      toolCallId: 'open-deployment',
      toolName: 'mcp__station-browser__browser_click',
      arguments: { browserSessionId: 'browser-1', x: 240, y: 180 },
    },
  });
}

async function expectPaintedPage(page: Page) {
  const activity = page.locator('.inline-browser-activity');
  await expect(activity.locator('.live-surface')).toHaveAttribute(
    'data-codec',
    'png',
  );
  await expect
    .poll(() =>
      activity.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
        const pixel = canvas.getContext('2d')?.getImageData(5, 5, 1, 1).data;
        return pixel ? Array.from(pixel) : [];
      }),
    )
    .toEqual([23, 36, 58, 255]);
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

test('phone chat opens its live browser with the inline preview off', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installFrameFixture(page, testInfo);
  await setup(page, false);

  const open = page.getByRole('button', { name: 'Open browser', exact: true });
  await open.click();
  const viewer = page.getByRole('dialog', { name: 'Browser', exact: true });
  await expect(viewer.locator('.live-surface')).toHaveAttribute(
    'data-codec',
    'png',
  );
  await expect
    .poll(async () => {
      const bounds = await viewer.boundingBox();
      return bounds && [Math.round(bounds.width), Math.round(bounds.height)];
    })
    .toEqual([390, 844]);
  await viewer.getByRole('button', { name: 'Close browser' }).click();
  await expect(viewer).toHaveCount(0);
  await expect(open).toBeFocused();
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
      await expect(activity).toHaveAttribute('data-active', 'true');
      await expectPaintedPage(page);
      const originalCanvas = await activity.locator('canvas').elementHandle();
      await activity
        .getByRole('button', { name: 'Full screen', exact: true })
        .click();
      await expect(activity.locator('.live-surface')).toHaveAttribute(
        'data-immersive',
        '',
      );
      await continueBrowserWork(page);
      await expect(activity).toHaveCount(1);
      await expect(activity.locator('.live-surface')).toHaveAttribute(
        'data-immersive',
        '',
      );
      expect(
        await activity
          .locator('canvas')
          .evaluate(
            (current, original) => current === original,
            originalCanvas,
          ),
      ).toBe(true);
      await page.keyboard.press('Escape');
      await expect(activity.locator('.live-surface')).not.toHaveAttribute(
        'data-immersive',
        '',
      );
      await expect(
        activity.locator('.inline-browser-activity__chip'),
      ).toHaveCount(3);
      await expectPaintedPage(page);
      const toolbar = activity.getByRole('toolbar', {
        name: 'Browser activity controls',
      });
      await expect(toolbar).toBeVisible();
      const controls = await toolbar.getByRole('button').all();
      expect(controls.length).toBeGreaterThan(0);
      for (const button of controls) {
        if (!(await button.isVisible())) continue;
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
      const activeStep = activity.locator('[aria-current="step"]');
      await expect(activeStep).toContainText('Clicking on the page');
      const stepBox = await activeStep.boundingBox();
      const cardBox = await activity.boundingBox();
      expect(stepBox).not.toBeNull();
      expect(cardBox).not.toBeNull();
      expect(stepBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
      expect(stepBox!.x + stepBox!.width).toBeLessThanOrEqual(
        cardBox!.x + cardBox!.width,
      );
      if (width === 390)
        await activity
          .getByRole('button', { name: 'More controls', exact: true })
          .click();
      await expect(
        activity.getByRole('button', { name: 'Float', exact: true }),
      ).toBeVisible();
      if (width === 390)
        await activity
          .getByRole('button', { name: 'More controls', exact: true })
          .click();
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
      if (width === 390)
        await activity
          .getByRole('button', { name: 'More controls', exact: true })
          .click();
      await activity
        .getByRole('button', { name: 'Float', exact: true })
        .click();
      await expect(activity).toContainText('Browser is floating.');
      await activity
        .getByRole('button', { name: 'Bring back', exact: true })
        .click();
      await expectPaintedPage(page);
      if (width === 390)
        await activity
          .getByRole('button', { name: 'More controls', exact: true })
          .click();
      await expect(
        activity.getByRole('button', { name: 'Float', exact: true }),
      ).toBeVisible();
      if (width === 390)
        await activity
          .getByRole('button', { name: 'More controls', exact: true })
          .click();
      await emitMockOrchestrationEvent(page, 'orchestration:event', {
        event: {
          ...base,
          method: 'tool.completed',
          itemId: 'open-deployment',
          toolCallId: 'open-deployment',
          toolName: 'mcp__station-browser__browser_click',
          output: 'Done',
          status: 'success',
        },
      });
      await emitMockOrchestrationEvent(page, 'orchestration:event', {
        event: { ...base, method: 'turn.completed', outputText: 'Done.' },
      });
      await expect(activity).toHaveCount(1);
      await expect(activity).toContainText('Browsed');
      await expect(activity).toContainText('3 actions');
      const disclosure = await activity.locator('summary').boundingBox();
      expect(disclosure).not.toBeNull();
      // DOMRects can report 43.999969 for a 44px layout box.
      expect(Number(disclosure!.height.toFixed(3))).toBeGreaterThanOrEqual(44);
      await expect(activity.locator('canvas')).toHaveCount(0);
      await expect(
        activity.getByRole('button', {
          name: 'Open current session',
          exact: true,
        }),
      ).not.toBeVisible();
      await expect(
        activity.locator('.inline-browser-activity__heading'),
      ).toBeVisible();
      const settled = testInfo.outputPath(
        `inline-browser-settled-${width}-${colorScheme}.png`,
      );
      await page.screenshot({
        path: testInfo.outputPath(
          `inline-browser-settled-${width}-${colorScheme}.png`,
        ),
        animations: 'disabled',
      });
      await testInfo.attach(`inline-browser-settled-${width}-${colorScheme}`, {
        path: settled,
        contentType: 'image/png',
      });
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
  await expect(page.locator('.inline-browser-activity')).toHaveAttribute(
    'data-active',
    'true',
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
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
});
