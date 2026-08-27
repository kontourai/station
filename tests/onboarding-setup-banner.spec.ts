import { expect, test } from '@playwright/test';

const SEED_STORAGE = `
  if (!window.sessionStorage.getItem('station:e2e-onboarding-test-initialized')) {
    window.localStorage.removeItem('station:onboarding-setup-dismissed');
    window.sessionStorage.setItem('station:e2e-onboarding-test-initialized', '1');
  }
  window.localStorage.setItem('station-connect-connections', JSON.stringify([
    { id: 'c1', name: 'Dev Server', url: 'http://localhost:3242', lastConnected: ${Date.now()} }
  ]));
  window.localStorage.setItem('station-connect-connections-active', 'c1');
`;

test.describe('Onboarding Setup Launcher', () => {
  test('shows generic setup guidance when only vectordb providers are configured', async ({
    page,
  }) => {
    await page.addInitScript(SEED_STORAGE);

    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: false,
          prerequisites: [],
          acp: { connected: false, connections: [] },
          providers: {
            configuredChatReady: false,
            configured: [
              {
                id: 'lancedb-builtin',
                type: 'lancedb',
                enabled: true,
                capabilities: ['vectordb'],
              },
            ],
            detected: {
              ollama: false,
              bedrock: false,
            },
          },
          recommendation: {
            code: 'unconfigured',
            type: 'connections',
            actionLabel: 'Open Connections',
            title: 'No usable AI path is configured yet',
            detail:
              'Start Ollama locally or add a provider/runtime connection to make Station ready for first-run chat.',
          },
          clis: {},
        }),
      }),
    );

    await page.goto('/');

    await expect(page.getByTestId('setup-launcher')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText('Choose what powers Station')).toBeVisible();
  });

  test('shows detection-led guidance when Ollama is reachable but not configured', async ({
    page,
  }) => {
    await page.addInitScript(SEED_STORAGE);

    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: true,
          prerequisites: [],
          acp: { connected: false, connections: [] },
          providers: {
            configuredChatReady: false,
            configured: [],
            detected: {
              ollama: true,
              bedrock: false,
            },
          },
          recommendation: {
            code: 'detected-provider',
            type: 'providers',
            actionLabel: 'Add Ollama connection',
            title: 'Ollama is available',
            detail:
              'Create a model connection for the detected local Ollama server to make first-run chat explicit.',
            detectedProviderType: 'ollama',
            detectedProviderLabel: 'Ollama',
          },
          clis: {},
        }),
      }),
    );

    await page.goto('/');

    await expect(page.getByTestId('setup-launcher')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText('Ollama is available')).toBeVisible();
    await expect(page.getByText('Detected: Ollama')).toBeVisible();
    await expect(
      page.getByText(
        'Create a model connection for the detected local Ollama server to make first-run chat explicit.',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Review Connections' }),
    ).toBeVisible();
  });

  test('runtime availability keeps the app usable without a setup overlay', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(SEED_STORAGE);

    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: false,
          prerequisites: [],
          acp: { connected: false, connections: [] },
          providers: {
            configuredChatReady: false,
            configured: [],
            detected: {
              ollama: false,
              bedrock: false,
            },
          },
          recommendation: {
            code: 'runtime-only',
            type: 'runtimes',
            actionLabel: 'Review runtimes',
            title: 'A runtime is available before chat is configured',
            detail:
              'Connected runtimes are detectable, but there is still no explicit chat-capable model connection configured.',
          },
          clis: { codex: true },
        }),
      }),
    );
    await page.route('**/api/connections/agents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );

    await page.goto('/');
    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Toggle menu' })).toBeVisible(
      { timeout: 10000 },
    );
  });

  test('quick-start proof reaches a chat-capable first-run path', async ({
    page,
  }) => {
    await page.addInitScript(SEED_STORAGE);

    let chatReady = false;
    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          chatReady
            ? {
                ready: true,
                prerequisites: [],
                acp: { connected: false, connections: [] },
                providers: {
                  configuredChatReady: true,
                  configured: [
                    {
                      id: 'ollama-local',
                      type: 'ollama',
                      enabled: true,
                      capabilities: ['llm'],
                    },
                  ],
                  detected: {
                    ollama: true,
                    bedrock: false,
                  },
                },
                capabilities: {
                  chat: { ready: true, source: 'ollama' },
                  runtime: { ready: false, source: null },
                  knowledge: { ready: false, source: null },
                  acp: { ready: false, source: null },
                },
                recommendation: {
                  code: 'configured-chat-ready',
                  type: 'providers',
                  actionLabel: 'Review model connections',
                  title:
                    'A chat-capable model connection is already configured',
                  detail:
                    'Station can already route chat through ollama. Review connections if you want to change the default.',
                },
                clis: {},
              }
            : {
                ready: true,
                prerequisites: [],
                acp: { connected: false, connections: [] },
                providers: {
                  configuredChatReady: false,
                  configured: [],
                  detected: {
                    ollama: true,
                    bedrock: false,
                  },
                },
                capabilities: {
                  chat: { ready: false, source: null },
                  runtime: { ready: false, source: null },
                  knowledge: { ready: false, source: null },
                  acp: { ready: false, source: null },
                },
                recommendation: {
                  code: 'detected-provider',
                  type: 'providers',
                  actionLabel: 'Add Ollama connection',
                  title: 'Ollama is available',
                  detail:
                    'Create a model connection for the detected local Ollama server to make first-run chat explicit.',
                  detectedProviderType: 'ollama',
                  detectedProviderLabel: 'Ollama',
                },
                clis: {},
              },
        ),
      }),
    );
    await page.route('**/api/connections/models', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: chatReady
            ? [
                {
                  id: 'ollama-local',
                  kind: 'model',
                  type: 'ollama',
                  name: 'Local Ollama',
                  enabled: true,
                  capabilities: ['llm'],
                  status: 'ready',
                  prerequisites: [],
                  config: { baseUrl: 'http://127.0.0.1:11434' },
                },
              ]
            : [],
        }),
      }),
    );
    await page.route('**/api/connections/agents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    await page.route('**/api/system/capabilities', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          voice: { stt: [], tts: [] },
          context: { providers: [] },
        }),
      }),
    );
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    await page.route('**/api/agents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    await page.route('**/api/conversations**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: [] }),
      }),
    );
    await page.route('**/config/app', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      }),
    );
    await page.route('**/events', (route) => route.abort());

    await page.goto('/');
    await expect(page.getByTestId('setup-launcher')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText('Ollama is available')).toBeVisible();

    await page.getByRole('button', { name: 'Review Connections' }).click();
    await expect(page).toHaveURL(/\/connections\/models/);
    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);

    chatReady = true;
    await page.goto('/?dock=open');

    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);
    await expect(page.getByTitle(/New Chat/)).toBeVisible({ timeout: 10000 });
  });

  test('hides the setup launcher when Ollama is already configured', async ({
    page,
  }) => {
    await page.addInitScript(SEED_STORAGE);

    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: true,
          prerequisites: [],
          acp: { connected: false, connections: [] },
          providers: {
            configuredChatReady: true,
            configured: [
              {
                id: 'ollama-local',
                type: 'ollama',
                enabled: true,
                capabilities: ['llm', 'embedding'],
              },
            ],
            detected: {
              ollama: true,
              bedrock: false,
            },
          },
          recommendation: {
            code: 'configured-chat-ready',
            type: 'providers',
            actionLabel: 'Review model connections',
            title: 'A chat-capable model connection is already configured',
            detail:
              'Station can already route chat through ollama. Review connections if you want to change the default.',
          },
          clis: {},
        }),
      }),
    );

    await page.goto('/');

    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);
  });

  test('does not render NewProjectModal behind the setup launcher on a zero-project first run', async ({
    page,
  }) => {
    await page.addInitScript(SEED_STORAGE);

    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: false,
          prerequisites: [],
          acp: { connected: false, connections: [] },
          providers: {
            configuredChatReady: false,
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
          recommendation: {
            code: 'unconfigured',
            type: 'connections',
            actionLabel: 'Open Connections',
            title: 'No usable AI path is configured yet',
            detail:
              'Start Ollama locally or add a provider/runtime connection to make Station ready for first-run chat.',
          },
          clis: {},
        }),
      }),
    );
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );

    await page.goto('/');

    await expect(page.getByTestId('setup-launcher')).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toHaveCount(0);
  });

  test('reveals task-first Home and opens New Project on explicit request', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(SEED_STORAGE);

    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: false,
          prerequisites: [],
          acp: { connected: false, connections: [] },
          providers: {
            configuredChatReady: false,
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
          recommendation: {
            code: 'unconfigured',
            type: 'connections',
            actionLabel: 'Open Connections',
            title: 'No usable AI path is configured yet',
            detail:
              'Start Ollama locally or add a provider/runtime connection to make Station ready for first-run chat.',
          },
          clis: {},
        }),
      }),
    );
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );

    await page.goto('/');

    await expect(page.getByTestId('setup-launcher')).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole('button', { name: 'Continue Without Setup' }).click();

    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);
    const openLocalProject = page.getByRole('button', {
      name: /Open local project/,
    });
    await expect(openLocalProject).toBeVisible();
    await openLocalProject.click();
    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toBeVisible({ timeout: 10000 });
  });
});
