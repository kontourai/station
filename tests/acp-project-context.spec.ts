/**
 * E2E: ACP connections + project context in chat sessions
 *
 * Verifies:
 * 1. ACP connections render from the current Agents surface
 * 2. The persisted engine-default Agent exposes its connection details
 * 3. New chat inherits the active project context
 */
import { expect, test } from '@playwright/test';

const STATUS_ACP_CONNECTED = {
  ready: true,
  acp: {
    connected: true,
    connections: [{ id: 'kiro', status: 'available' }],
  },
  clis: { 'kiro-cli': true },
  prerequisites: [],
};

const ACP_CONNECTIONS = [
  {
    id: 'kiro',
    name: 'kiro-cli',
    command: 'kiro-cli',
    args: ['acp'],
    icon: '/kiro-icon.png',
    enabled: true,
    status: 'available',
    modes: [{ id: 'chat', name: 'Chat' }],
    sessionId: 'sess-123',
    mcpServers: [],
    currentModel: 'claude-sonnet-4-20250514',
  },
];

const TEST_PROJECTS = [
  {
    id: 'p1',
    slug: 'my-project',
    name: 'My Project',
    icon: '🚀',
    description: 'Test project',
    hasWorkingDirectory: true,
    layoutCount: 1,
    hasKnowledge: false,
  },
];

const AGENTS = [
  {
    slug: 'station',
    name: 'Station',
    description: 'System default Agent',
    source: 'local',
    engineId: 'station',
    engineDisplayName: 'Station',
    engineDefault: true,
    available: true,
  },
  {
    slug: 'kiro',
    name: 'Kiro',
    description: 'Kiro engine-default Agent',
    source: 'acp',
    engineId: 'kiro',
    engineDisplayName: 'kiro-cli',
    engineConnectionType: 'acp',
    engineDefault: true,
    available: true,
    execution: { agentConnectionId: 'kiro' },
  },
];

function seedRoutes(page: import('@playwright/test').Page) {
  return Promise.all([
    page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STATUS_ACP_CONNECTED),
      }),
    ),
    page.route('**/acp/connections', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: ACP_CONNECTIONS }),
      }),
    ),
    page.route('**/api/projects', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: TEST_PROJECTS }),
      }),
    ),
    page.route('**/api/projects/my-project', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            ...TEST_PROJECTS[0],
            agents: ['station', 'kiro'],
            workingDirectory: '/tmp/my-project',
          },
        }),
      }),
    ),
    page.route('**/api/projects/my-project/layouts', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/agents', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: AGENTS }),
      }),
    ),
    page.route('**/api/agents/kiro', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: AGENTS[1] }),
      }),
    ),
    page.route('**/api/bedrock/models', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ models: [] }),
      }),
    ),
    page.route('**/api/config', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      }),
    ),
    page.route('**/config/app', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { apiBase: '', defaultModel: 'gpt-5.5' },
        }),
      }),
    ),
    page.route('**/events', (r) => r.abort()),
    page.route('**/api/system/capabilities', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          voice: { stt: [], tts: [] },
          context: { providers: [] },
        }),
      }),
    ),
    page.route('**/api/conversations**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: [] }),
      }),
    ),
    page.route('**/api/providers/connections', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      }),
    ),
    page.route('**/api/connections/agents', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/connections/models', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
  ]);
}

test.describe('ACP + Project Context', () => {
  test('ACP-backed default Agent renders with a clean Engine chip', async ({
    page,
  }) => {
    await seedRoutes(page);
    await page.goto('/agents');
    const kiroRow = page.getByRole('button', { name: /Kiro/ });
    await expect(kiroRow).toBeVisible({ timeout: 5000 });
    // LOW-2: assert the engine chip itself (not just that the row's
    // accessible name happens to contain the connection's own name) —
    // never the literal "ACP".
    await expect(kiroRow.locator('.engine-chip__pill')).toHaveText('Kiro');
    await expect(kiroRow).not.toContainText('ACP');
  });

  test('ACP-backed default Agent shows its engine-owned connection', async ({
    page,
  }) => {
    await seedRoutes(page);
    await page.goto('/agents');
    await page.getByRole('button', { name: /Kiro/ }).click();
    await expect(
      page.getByText(/managed by its engine connection/i),
    ).toBeVisible();
    const connectionTab = page.getByRole('button', {
      name: 'Connection',
      exact: true,
    });
    await expect(connectionTab).toBeVisible();
    await connectionTab.click();
    await expect(connectionTab).toHaveClass(/page__tab--active/);
  });

  test('new chat can select project context from active project data', async ({
    page,
  }) => {
    await seedRoutes(page);
    // Seed localStorage with a last-selected project before navigating
    await page.addInitScript(() => {
      localStorage.setItem('lastProject', 'my-project');
    });
    await page.goto('/projects/my-project?dock=open');

    // Click New -- opens modal since there are 2 persisted Agents.
    const newChatBtn = page.getByRole('button', { name: /New/ }).last();
    await expect(newChatBtn).toBeVisible({ timeout: 5000 });
    await newChatBtn.click();

    // Modal should expose the project context before starting a chat.
    const modal = page.getByText('New Chat');
    await expect(modal).toBeVisible({ timeout: 3000 });
    await page.locator('.new-chat-modal__context-button').click();
    await page
      .locator('.new-chat-modal__dropdown')
      .getByRole('button', { name: /My Project|my-project/ })
      .click();
    await expect(page.locator('.new-chat-modal__context-button')).toContainText(
      /My Project|my-project/,
    );
  });

  test('ACP connection item hidden when no connections', async ({ page }) => {
    // Override with no ACP connections
    await page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...STATUS_ACP_CONNECTED,
          acp: { connected: false, connections: [] },
        }),
      }),
    );
    await page.route('**/acp/connections', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    await page.route('**/api/projects', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: TEST_PROJECTS }),
      }),
    );
    await page.route('**/api/agents', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: AGENTS.filter((a) => a.source !== 'acp'),
        }),
      }),
    );
    await page.route('**/api/bedrock/models', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ models: [] }),
      }),
    );
    await page.route('**/api/config', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      }),
    );
    await page.route('**/events', (r) => r.abort());
    await page.route('**/api/system/capabilities', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          voice: { stt: [], tts: [] },
          context: { providers: [] },
        }),
      }),
    );
    await page.route('**/api/conversations**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: [] }),
      }),
    );
    await page.route('**/api/providers/connections', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      }),
    );

    await page.goto('/agents');
    await expect(
      page.getByRole('button', { name: /kiro-cli/ }),
    ).not.toBeVisible({
      timeout: 3000,
    });
  });
});
