import { expect, type Page, test } from '@playwright/test';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { dismissSetupLauncher } from './helpers/orchestration';

/**
 * #304 regression: the chat dock's project-context row truncates long working
 * directories from the start via a `direction: rtl` parent span. Without bidi
 * isolation, leading neutral characters (`~`, `/`) are visually reordered to
 * the end of the span — `~/dev/github/kontourai` rendered as
 * `/dev/github/~kontourai`, a literal tilde spliced mid-path.
 *
 * jsdom cannot see bidi reordering (the DOM text is unchanged), so the
 * assertion lives at the browser seam: per-character Range rects must be
 * monotonically left-to-right. Verified to FAIL against a pre-fix build.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const PROJECTS = [
  {
    id: 'home-proj',
    slug: 'home-proj',
    name: 'Home Project',
    workingDirectory: '~/dev/github/kontourai',
    hasWorkingDirectory: true,
    layoutCount: 0,
  },
  {
    id: 'abs-proj',
    slug: 'abs-proj',
    name: 'Abs Project',
    workingDirectory: '/opt/tools/depot',
    hasWorkingDirectory: true,
    layoutCount: 0,
  },
];

async function mockShell(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('station-connect-connections-active', 'ctx');
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([{ id: 'ctx', name: 'Ctx', url: location.origin }]),
    );
  });
  await page.route('**/.well-known/station/v1', (route) =>
    route.fulfill(
      json({
        schemaVersion: 1,
        environmentId: '11111111-1111-4111-8111-111111111111',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
      }),
    ),
  );
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/orchestration/sessions/read-model')
      return route.fulfill(json({ success: true, data: [] }));
    if (path === '/api/agents')
      return route.fulfill(
        json({
          success: true,
          data: [
            {
              slug: 'claude',
              name: 'Claude Runtime',
              description: 'Connected Claude test runtime',
              source: 'local',
              model: 'model-selected',
              execution: {
                agentConnectionId: 'claude-runtime',
                modelId: 'model-selected',
              },
            },
          ],
        }),
      );
    if (path === '/api/connections/agents')
      return route.fulfill(
        json({
          success: true,
          data: [
            agentConnectionFixture({
              id: 'claude-runtime',
              kind: 'agent',
              type: 'claude-runtime',
              name: 'Claude Runtime',
              enabled: true,
              capabilities: ['agent-runtime'],
              config: {
                executionClass: 'external',
                defaultModel: 'model-selected',
              },
              status: 'ready',
              runtimeCatalog: {
                source: 'live',
                models: [
                  {
                    id: 'model-selected',
                    name: 'Selected Test Model',
                    originalId: 'model-selected',
                  },
                ],
                builtInModels: [],
              },
              prerequisites: [],
            }),
          ],
        }),
      );
    if (path === '/api/projects')
      return route.fulfill(json({ success: true, data: PROJECTS }));
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch) {
      const project = PROJECTS.find((p) => p.slug === projectMatch[1]);
      if (project) return route.fulfill(json({ success: true, data: project }));
    }
    if (path === '/api/system/status')
      return route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          providers: {
            configuredChatReady: true,
            configured: [],
            detected: {},
          },
          capabilities: {
            chat: { ready: true },
            runtime: { ready: false },
            knowledge: { ready: false },
            acp: { ready: false },
          },
          prerequisites: [],
          clis: {},
        }),
      );
    if (path === '/api/system/identity')
      return route.fulfill(
        json({
          environmentId: '11111111-1111-4111-8111-111111111111',
          bootId: 'ctx-boot',
        }),
      );
    if (path === '/api/system/capabilities')
      return route.fulfill(
        json({ voice: { stt: [], tts: [] }, context: { providers: [] } }),
      );
    if (path === '/api/attention')
      return route.fulfill(
        json({ success: true, data: { items: [], pendingCount: 0 } }),
      );
    return route.fulfill(json({ success: true, data: [] }));
  });
  await page.route('**/config/app', (route) =>
    route.fulfill(
      json({ success: true, data: { defaultModel: 'test-model' } }),
    ),
  );
  await page.route('**/events', (route) => route.abort());
}

interface GlyphProbe {
  text: string;
  lefts: number[];
}

async function probeParentGlyphs(page: Page): Promise<GlyphProbe> {
  return page.evaluate(() => {
    const parent = document.querySelector<HTMLElement>(
      '.chat-dock__project-dir-parent',
    )!;
    const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode() as Text;
    const text = node.textContent ?? '';
    const lefts: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      lefts.push(range.getBoundingClientRect().left);
    }
    return { text, lefts };
  });
}

function expectMonotonicLeftToRight({ text, lefts }: GlyphProbe) {
  for (let i = 1; i < lefts.length; i++) {
    expect(
      lefts[i],
      `glyph "${text[i]}" (index ${i}) of "${text}" must render right of "${text[i - 1]}"`,
    ).toBeGreaterThan(lefts[i - 1]);
  }
}

for (const scenario of [
  {
    label: 'home-relative (~) path keeps its tilde at the start',
    project: 'home-proj',
    expected: '~/dev/github/kontourai',
    parent: '~/dev/github/',
  },
  {
    label: 'absolute path outside $HOME stays absolute and ordered',
    project: 'abs-proj',
    expected: '/opt/tools/depot',
    parent: '/opt/tools/',
  },
]) {
  test(`project context: ${scenario.label}`, async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockShell(page);
    await page.goto('/?dock=open');
    await dismissSetupLauncher(page);

    // Bind a chat to the scenario's project so the dock renders its
    // project-context row.
    await page.evaluate(() =>
      window.dispatchEvent(new Event('station:open-new-chat')),
    );
    const modal = page.getByRole('dialog', { name: 'New Chat' });
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await page.locator('.new-chat-modal__context-button').click();
    await page.locator(`[data-context-value="${scenario.project}"]`).click();
    await modal.locator('[data-agent-slug="claude"]').first().click();
    await expect(modal).toBeHidden();

    const dir = page.locator('.chat-dock__project-dir');
    await expect(dir).toBeVisible({ timeout: 15_000 });
    // DOM order (jsdom-equivalent): the full path is intact as text.
    await expect(dir).toHaveText(scenario.expected);

    // Visual order (the actual #304 failure mode): every parent-path glyph
    // renders strictly left-to-right despite the rtl truncation container.
    const probe = await probeParentGlyphs(page);
    expect(probe.text).toBe(scenario.parent);
    expectMonotonicLeftToRight(probe);
  });
}

test('project-context clicks do not toggle the dock (#1064)', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockShell(page);
  await page.goto('/?dock=open');
  await dismissSetupLauncher(page);

  await page.evaluate(() =>
    window.dispatchEvent(new Event('station:open-new-chat')),
  );
  const modal = page.getByRole('dialog', { name: 'New Chat' });
  await expect(modal).toBeVisible({ timeout: 15_000 });
  await page.locator('.new-chat-modal__context-button').click();
  await page.locator('[data-context-value="home-proj"]').click();
  await modal.locator('[data-agent-slug="claude"]').first().click();

  const dir = page.locator('.chat-dock__project-dir');
  await expect(dir).toBeVisible({ timeout: 15_000 });
  const dock = page.locator('.chat-dock');
  const before = (await dock.boundingBox())?.height ?? 0;
  expect(before).toBeGreaterThan(100);

  // #1064 folded this row into the dock header, whose own onClick toggles the
  // dock. Without stopPropagation on the context's handlers, every attempt to
  // open the coding layout or switch project also collapsed/expanded the dock.
  await dir.click();
  await page.waitForTimeout(500);
  expect((await dock.boundingBox())?.height ?? 0).toBe(before);
});
