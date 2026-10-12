import type { Server } from 'node:http';
import type { Page } from '@playwright/test';
import { genericIconPng } from './fixtures/generic-icon-png';
import {
  waitForAgentRemoved,
  waitForSeededAgent,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { monitorBrowserHealth } from './helpers/browser-health';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

/**
 * A project icon set AFTER creation, through the live UI and the live server:
 * the settings picker uploads an image, Save persists it through
 * `PUT /api/projects/:slug`, and every surface that names the project draws
 * it — the sidebar row, a Home row for a real session in that project, and
 * the dock's project switcher.
 *
 * The session is real (one turn into a local model fixture) because a Home
 * row is derived from the server's session records; a page-routed session
 * would prove only that the row draws what a fixture told it.
 */

const FIXTURE_CONNECTION_ID = 'e2e-project-icons-fixture';
const FIXTURE_MODEL = 'station-project-icons:latest';
const FIXTURE_REPLY = 'project icon fixture answered.';

interface LlmConnection extends Record<string, unknown> {
  id: string;
  enabled?: boolean;
  capabilities?: string[];
}

async function enabledLlmConnections(
  request: AuthenticatedE2ERequest,
): Promise<LlmConnection[]> {
  const response = await request.get('/api/connections/models');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { data?: LlmConnection[] };
  return (body.data ?? []).filter(
    (connection) =>
      connection.enabled !== false &&
      (connection.capabilities ?? []).includes('llm'),
  );
}

async function setConnectionsEnabled(
  request: AuthenticatedE2ERequest,
  connections: LlmConnection[],
  enabled: boolean,
): Promise<void> {
  for (const connection of connections) {
    const response = await request.put(
      `/api/connections/${encodeURIComponent(connection.id)}`,
      { data: { ...connection, enabled } },
    );
    expect(response.ok()).toBe(true);
  }
}

/**
 * The dock's own inbox row for the session in the project: the rows
 * `ChatDock` renders from its own accent and icon reads, which no
 * panel-level test reaches.
 */
async function dockInboxRow(page: Page, projectSlug: string) {
  const hide = page.getByRole('button', { name: 'Hide inbox', exact: true });
  const show = page.getByRole('button', { name: /^Show inbox/ });
  await expect(hide.or(show)).toBeVisible({ timeout: 20_000 });
  if (await show.isVisible()) await show.click();
  const row = page
    .getByRole('complementary', { name: 'Inbox chats' })
    .locator('[data-testid="inbox-row"]')
    .filter({ hasText: projectSlug })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

test.describe('project icons', () => {
  let fixtureServer: Server | null = null;
  let suspended: LlmConnection[] = [];
  let seededAgentSlug = '';
  let projectSlug = '';

  test.afterEach(async ({ authenticatedRequest }) => {
    try {
      if (projectSlug) {
        await authenticatedRequest.delete(`/api/projects/${projectSlug}`);
      }
      if (seededAgentSlug) {
        const removal = await authenticatedRequest.delete(
          `/agents/${encodeURIComponent(seededAgentSlug)}`,
        );
        expect(removal.ok() || removal.status() === 404).toBe(true);
      }
      const connectionRemoval = await authenticatedRequest.delete(
        `/api/connections/${FIXTURE_CONNECTION_ID}`,
      );
      expect(connectionRemoval.ok() || connectionRemoval.status() === 404).toBe(
        true,
      );
      await setConnectionsEnabled(
        authenticatedRequest,
        suspended.splice(0),
        true,
      );
      if (seededAgentSlug)
        await waitForAgentRemoved(authenticatedRequest, seededAgentSlug);
    } finally {
      seededAgentSlug = '';
      projectSlug = '';
      await closeFixtureServer(fixtureServer);
      fixtureServer = null;
    }
  });

  test('an icon set in settings appears in the sidebar, a Home row and the project switcher', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(150_000);
    // The settings page's People and access section answers a Station without
    // project sharing with a 501, which browser health counts (a gap that
    // predates icons). Script errors there still fail this journey; full
    // browser health is enforced from the first surface after settings.
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const stamp = Date.now();
    const projectName = `Icon Lane ${stamp}`;
    projectSlug = `icon-lane-${stamp}`;

    // --- A project, and one real session in it -------------------------
    const created = await authenticatedRequest.post('/api/projects', {
      data: { name: projectName, slug: projectSlug },
    });
    expect(created.ok()).toBe(true);

    suspended = await enabledLlmConnections(authenticatedRequest);
    await setConnectionsEnabled(authenticatedRequest, suspended, false);
    const chatRequests: unknown[] = [];
    const fixture = await startOllamaFixture(
      FIXTURE_MODEL,
      (body) => chatRequests.push(body),
      FIXTURE_REPLY,
    );
    fixtureServer = fixture.server;
    const connection = await authenticatedRequest.post('/api/connections', {
      data: {
        id: FIXTURE_CONNECTION_ID,
        kind: 'model',
        type: 'ollama',
        name: 'project icons fixture',
        enabled: true,
        capabilities: ['llm'],
        config: { baseUrl: fixture.origin, defaultModel: FIXTURE_MODEL },
        status: 'ready',
        prerequisites: [],
      },
    });
    expect(connection.ok()).toBe(true);
    const agentSlug = `e2e-project-icons-${stamp}`;
    const agent = await authenticatedRequest.post('/agents', {
      data: {
        slug: agentSlug,
        name: `E2E Project Icons ${stamp}`,
        prompt: 'Answer in one short sentence.',
      },
    });
    expect(agent.ok()).toBe(true);
    seededAgentSlug = agentSlug;
    await waitForSeededAgent(authenticatedRequest, agentSlug);

    const sent = await authenticatedRequest.post('/api/orchestration/chat', {
      data: {
        target: {
          agent: agentSlug,
          workspace: { kind: 'project', projectSlug },
        },
        message: 'Say hello for the project icon journey.',
      },
    });
    expect(sent.ok(), await sent.text()).toBe(true);
    await expect
      .poll(
        async () => {
          const response = await authenticatedRequest.get(
            '/api/orchestration/sessions',
          );
          const body = (await response.json()) as {
            data?: Array<{ resumeCursor?: { projectSlug?: string } }>;
          };
          // The session's own record of the project it was started in.
          return (body.data ?? []).some(
            (session) => session.resumeCursor?.projectSlug === projectSlug,
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // --- The dock inbox, before an icon: the project's colour ------------
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/projects/${projectSlug}?dock=open`);
    const swatch = (await dockInboxRow(page, projectSlug)).locator(
      '.inbox-row__project-accent',
    );
    await expect(swatch).toHaveAttribute('data-project-icon', 'dot');
    // Painted with a colour, not merely present.
    await expect
      .poll(() => swatch.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/);

    // --- Set the icon in settings: upload a generic image, Save ----------
    const png = genericIconPng();
    const expectedIcon = `data:image/png;base64,${png.toString('base64')}`;
    await page.goto(`/projects/${projectSlug}/edit`);
    await page.getByRole('button', { name: 'Choose project icon' }).click();
    await page
      .getByTestId('project-settings-icon-upload')
      .setInputFiles({ name: 'mark.png', mimeType: 'image/png', buffer: png });
    await expect(
      page.getByRole('img', { name: 'Current image' }),
    ).toBeVisible();
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/projects/${projectSlug}`) &&
        response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await saved).status()).toBe(200);

    // Persisted by the real server, not just held by the form.
    const stored = await authenticatedRequest.get(
      `/api/projects/${projectSlug}`,
    );
    expect(
      ((await stored.json()) as { data: { icon?: string } }).data.icon,
    ).toBe(expectedIcon);

    expect(pageErrors).toEqual([]);

    // --- Sidebar row ----------------------------------------------------
    const browserHealth = await monitorBrowserHealth(page);
    await page.goto('/');
    const sidebarIcon = page.locator(
      `[title="Open ${projectName} workspace"] .sidebar__project-icon img`,
    );
    await expect(sidebarIcon).toHaveAttribute('src', expectedIcon, {
      timeout: 20_000,
    });
    // Drawn, not merely present: the browser decoded the bytes.
    await expect
      .poll(() =>
        sidebarIcon.evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(32);

    // --- Home row for the session in that project ------------------------
    const homeRow = page
      .locator('[data-testid="inbox-row"]')
      // A session row labels its project as the session recorded it (the
      // slug); the icon is resolved by that same slug.
      .filter({ hasText: projectSlug })
      .first();
    await expect(homeRow).toBeVisible({ timeout: 30_000 });
    await expect(
      homeRow.locator('.inbox-row__project-accent img'),
    ).toHaveAttribute('src', expectedIcon);

    // --- The dock's project switcher --------------------------------------
    await page.goto(`/projects/${projectSlug}?dock=open`);
    await page.locator('.chat-dock__project-badge').first().click();
    const switcher = page.getByRole('dialog', { name: 'Projects' });
    await expect(switcher).toBeVisible();
    const switcherRow = switcher
      .locator('.chat-dock__project-switcher-row')
      .filter({ hasText: projectName });
    await expect(
      switcherRow.locator('.chat-dock__project-switcher-icon img'),
    ).toHaveAttribute('src', expectedIcon);
    await page.keyboard.press('Escape');
    await expect(switcher).toBeHidden();

    // --- The dock's inbox row now draws the icon ---------------------------
    await expect(
      (await dockInboxRow(page, projectSlug)).locator(
        '.inbox-row__project-accent img',
      ),
    ).toHaveAttribute('src', expectedIcon);

    browserHealth.assertHealthy();
  });
});
