import { expect, type Page, test } from '@playwright/test';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { dismissSetupLauncher } from './helpers/orchestration';

/**
 * archive#304 regression, re-homed by #1536 F.
 *
 * The dock's project-context row USED to render the working directory as a
 * visible segment truncated from the start via a `direction: rtl` parent span,
 * and without bidi isolation its leading neutral characters (`~`, `/`) were
 * visually reordered to the end — `~/dev/github/kontourai` rendered as
 * `/dev/github/~kontourai`, a literal tilde spliced mid-path. This spec's
 * per-glyph Range probe was the only place that could see it, since the DOM
 * text is unchanged by bidi reordering.
 *
 * That segment is gone: on a 110-character worktree path it left the
 * conversation title beside it about one character wide, so the row is the
 * project's NAME and its branch, and the path is the badge's `title` (plus
 * "Copy project path" in the dock header's More menu). A tooltip has no rtl
 * truncation and no bidi container, so #304's failure mode is not merely
 * untested here — it is unreachable. What still needs proving is that the path
 * ARRIVES, whole and in order, in the channel that now carries it: the
 * resolution behind it (station#1146's session-cwd, the `~` form vs an absolute
 * one) is exactly as before, and a tooltip that dropped or mangled it would be
 * invisible to every jsdom test.
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
                agentConnectionId: 'claude',
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
              id: 'claude',
              kind: 'agent',
              type: 'claude',
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

async function bindChatToProject(page: Page, project: string): Promise<void> {
  await page.evaluate(() =>
    window.dispatchEvent(new Event('station:open-new-chat')),
  );
  const modal = page.getByRole('dialog', { name: 'New Chat' });
  await expect(modal).toBeVisible({ timeout: 15_000 });
  await page.locator('.new-chat-modal__context-button').click();
  await page.locator(`[data-context-value="${project}"]`).click();
  await modal.locator('[data-agent-slug="claude"]').first().click();
}

for (const scenario of [
  {
    label: 'home-relative (~) path keeps its tilde at the start',
    project: 'home-proj',
    name: 'Home Project',
    expected: '~/dev/github/kontourai',
  },
  {
    label: 'absolute path outside $HOME stays absolute',
    project: 'abs-proj',
    name: 'Abs Project',
    expected: '/opt/tools/depot',
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
    await bindChatToProject(page, scenario.project);
    await expect(page.getByRole('dialog', { name: 'New Chat' })).toBeHidden();

    const badge = page.locator('.chat-dock__project-badge');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    // The row names the project, and only the project.
    await expect(badge).toHaveText(scenario.name);
    await expect(page.locator('.chat-dock__project-context')).toHaveText(
      scenario.name,
    );
    // The path arrives whole in the channel that carries it now — same string,
    // same `~` or absolute form, no truncation and no reordering possible.
    await expect(badge).toHaveAttribute(
      'title',
      `${scenario.name} — ${scenario.expected}`,
    );
    // And the retired segment is really gone rather than merely hidden: a
    // `display: none` span would still satisfy the assertions above.
    await expect(page.locator('.chat-dock__project-dir')).toHaveCount(0);
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

  await bindChatToProject(page, 'home-proj');

  // #1536 F: the row's interactive element is the project badge — the path
  // segment that used to carry the coding-layout link is retired, and the badge
  // is what opens the project switcher.
  const badge = page.locator('.chat-dock__project-badge');
  await expect(badge).toBeVisible({ timeout: 15_000 });
  const dock = page.locator('.chat-dock');
  const before = (await dock.boundingBox())?.height ?? 0;
  expect(before).toBeGreaterThan(100);

  // archive#1064 folded this row into the dock header, whose own onClick toggles the
  // dock. Without stopPropagation on the context's handlers, every attempt to
  // switch project also collapsed/expanded the dock.
  await badge.click();
  await page.waitForTimeout(500);
  expect((await dock.boundingBox())?.height ?? 0).toBe(before);
  // The click did what it is for, so this is not passing on an inert element.
  await expect(
    page.getByRole('dialog', { name: 'Switch project' }),
  ).toBeVisible({ timeout: 10_000 });
});
