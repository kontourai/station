import type { Page } from '@playwright/test';

/** Mock chat readiness with an empty optional knowledge registry. */
export async function mockEmptyKnowledgeRegistry(
  page: Page,
  runtimeId: string,
): Promise<void> {
  await page.route('**/config/app', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: {} }),
    }),
  );
  await page.route('**/api/system/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: true,
        acp: { connected: false, connections: [] },
        clis: {},
        prerequisites: [],
        providers: {
          configuredChatReady: true,
          configured: [
            {
              id: runtimeId,
              type: 'codex',
              enabled: true,
              capabilities: ['llm'],
            },
          ],
          detected: { ollama: false, bedrock: false },
        },
        capabilities: { chat: { ready: true, source: runtimeId } },
      }),
    }),
  );
  await page.route('**/api/knowledge/roots', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
  await page.route('**/api/knowledge/adapters', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          { id: 'kit-default-store', displayName: 'Default File Store' },
          { id: 'kit-obsidian-store', displayName: 'Obsidian Vault Store' },
        ],
      }),
    }),
  );
}
