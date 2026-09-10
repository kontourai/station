import { expect, test } from '@playwright/test';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import {
  dismissSetupLauncher,
  openChatRegion,
  seedActiveChats,
  seedOrchestrationRoutes,
} from './helpers/orchestration';
import { mockRuntimeConversation } from './helpers/runtime-conversation-fixture';

test.describe('Orchestration Execution Settings', () => {
  test.beforeEach(async ({ page }) => {
    await seedActiveChats(page, [
      {
        sessionId: 'session-1',
        conversationId: 'conv-1',
        agentSlug: 'dev-agent',
        model: 'claude-sonnet',
        provider: 'bedrock',
        providerOptions: {},
        orchestrationSessionStarted: false,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await seedOrchestrationRoutes(page);
    await page.route('**/api/orchestration/commands', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      }),
    );
  });

  test('shows the active execution summary without triggering onboarding', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await dismissSetupLauncher(page);

    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);

    await page.getByRole('button', { name: 'More dock actions' }).click();
    await page
      .getByRole('menuitem', { name: 'Chat settings', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Chat Settings' }),
    ).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Show reasoning' }),
    ).toBeVisible();
  });

  test('round-trips persisted provider options through foreground execution', async ({
    page,
  }) => {
    const executionRequests: Array<Record<string, unknown>> = [];
    const model = 'gpt-5.3-codex';
    const providerOptions = { reasoningEffort: 'xhigh', fastMode: true };
    await seedActiveChats(page, [
      {
        sessionId: 'session-1',
        conversationId: 'conv-1',
        agentSlug: 'dev-agent',
        model,
        requestedModel: model,
        requestedProviderOptions: providerOptions,
        agentConnectionId: 'codex',
        executionMode: 'external',
        provider: 'codex',
        projectSlug: 'dev',
        providerOptions: {
          reasoningEffort: 'xhigh',
          fastMode: true,
        },
        orchestrationSessionStarted: false,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await mockRuntimeConversation(page, {
      id: 'conv-1',
      agentSlug: 'dev-agent',
      title: 'Dev Agent Chat',
      projectSlug: 'dev',
      provider: 'codex',
      model,
      canContinue: true,
      turns: () => [],
    });
    const agent = {
      slug: 'dev-agent',
      name: 'Dev Agent',
      execution: { agentConnectionId: 'codex' },
    };
    await page.route('**/api/agents', (route) =>
      route.fulfill({ json: { success: true, data: [agent] } }),
    );
    await page.route('**/api/agents/dev-agent', (route) =>
      route.fulfill({ json: { success: true, data: agent } }),
    );
    await page.route('**/api/connections/agents', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            agentConnectionFixture({
              id: 'codex',
              name: 'Codex',
              type: 'codex',
              kind: 'agent',
              enabled: true,
              status: 'ready',
              config: { engineId: 'codex' },
              runtimeCatalog: {
                source: 'live',
                models: [
                  {
                    id: model,
                    name: model,
                    originalId: model,
                    capabilities: {
                      supportsEffort: true,
                      supportedEffortLevels: ['xhigh'],
                      supportsFastMode: true,
                    },
                  },
                ],
                builtInModels: [],
              },
            }),
          ],
        },
      }),
    );
    await page.route('**/api/orchestration/chat', async (route) => {
      const request = route.request().postDataJSON() as Record<string, unknown>;
      executionRequests.push(request);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          foregroundMessageReceiptEnvelope({
            conversationId: String(request.conversationId ?? 'conv-1'),
            agent: 'dev-agent',
          }),
        ),
      });
    });

    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await dismissSetupLauncher(page);
    await openChatRegion(page);

    await page.getByPlaceholder('Type a message...').fill('Inspect the repo');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect.poll(() => executionRequests.length).toBe(1);
    expect(executionRequests[0]).toMatchObject({
      conversationId: 'conv-1',
      message: 'Inspect the repo',
      target: {
        agent: 'dev-agent',
        // `environment` is deliberately absent here. `foregroundMessageDispatch.ts:38-59`
        // makes it EXCLUSIVE with `workspace`: a turn bound to a project sends
        // `workspace: { kind: 'project', ... }` and no environment, and only an
        // unbound turn carries `environment: { kind: 'current' }`. This fixture
        // seeds `projectSlug: 'dev'`, so asserting both was asserting a payload
        // the client cannot produce.
        //
        // The exclusivity itself is not re-asserted here — it is owned a layer
        // down, by `src-ui/src/__tests__/useActiveChatSessionMessaging.test.ts`
        // (project case: `expect(input.target).not.toHaveProperty('environment')`)
        // and `src-ui/src/hooks/orchestration/__tests__/queueDrain.test.ts`
        // (unbound case: it still carries it). What needs a browser, and stays
        // here, is that the persisted selection reaches the dispatch at all.
        workspace: { kind: 'project', projectSlug: 'dev' },
        model: {
          override: model,
          options: {
            effort: 'xhigh',
            fastMode: true,
          },
        },
      },
    });
  });
});
