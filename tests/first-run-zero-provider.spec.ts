import { expect, test } from '@playwright/test';
import {
  DEFAULT_CONVERSATIONS,
  seedActiveChats,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

const ZERO_PROVIDER_STATUS = JSON.stringify({
  ready: false,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
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
});

test.describe('First-run zero-provider chat rescue (#191 R1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('station:onboarding-setup-dismissed');
    });
    // A pre-existing, message-less chat session for a Station-managed agent —
    // mirrors the state a returning zero-provider user lands on: an open chat
    // dock with nothing sent yet.
    await seedActiveChats(page, [
      {
        // conv-1 matches DEFAULT_CONVERSATIONS/DEFAULT_CONVERSATION_LOOKUPS
        // below — usePruneActiveChats() removes any session whose
        // conversationId isn't in the agent's fetched conversation list, so
        // a fabricated id here would get silently pruned before the empty
        // state ever renders.
        sessionId: 'session-1',
        conversationId: 'conv-1',
        agentSlug: 'dev-agent',
        projectSlug: 'dev',
        projectName: 'Dev',
      },
    ]);
    await seedOrchestrationRoutes(page, {
      conversations: DEFAULT_CONVERSATIONS,
    });

    // Overrides seedOrchestrationRoutes' default chat-ready status fixture —
    // Playwright resolves the most-recently-registered route first.
    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: ZERO_PROVIDER_STATUS,
      }),
    );
    await page.route('**/api/connections/models', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
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
  });

  test('ends at a guided chat empty-state, never a raw error, with a one-click path to Connections -> Models', async ({
    page,
  }) => {
    // archive#3764: `ChatDockBody` mounts `ChatEmptyState` in the empty-
    // transcript filler archive#2467's chunk split left behind, so the guided rescue
    // is reachable without the heavy transcript chunk.
    await page.goto('/projects/dev/layouts/code?dock=open&chat=session-1');

    // An established saved Station does not repeat setup when its model
    // inventory is empty. Recovery belongs to the active chat surface.
    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);

    // The rescued state: a guided empty-state CTA, never a raw `Error:`/HTTP
    // bubble as the terminal state.
    const emptyState = page.getByTestId('chat-empty-state-unconfigured');
    await expect(emptyState).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/^Error:/)).toHaveCount(0);
    await expect(page.getByText(/HTTP 5\d\d/)).toHaveCount(0);

    await emptyState.getByRole('button', { name: 'Open Connections' }).click();
    await expect(page).toHaveURL(/\/connections\/models/);
  });
});
