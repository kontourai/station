import { expect, test } from '@playwright/test';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import {
  dismissSetupLauncher,
  seedActiveChats,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

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

    /*
     * ONE click. The retry that used to wrap this clicked the gear again on
     * every attempt, and the gear is a TOGGLE — a retry landing while the
     * panel was mid-open closed it, so the workaround could produce the
     * failure it was covering.
     *
     * station#3770 read this as a swallowed click. It is not: the chunk and
     * every module it pulls finish ~120ms after the click, the `.chat-dock`
     * node is never replaced, and no pushState/popstate/back occurs. The
     * panel nevertheless committed between 0.25s and 9.3s later, because a
     * sustained render storm on this route (station#3781) starved React's
     * Suspense retry lane until it expired. That loop is fixed, and
     * tests/project-layout-render-storm.spec.ts keeps it fixed, so this wait
     * is bounded by the chunk fetch again rather than by the storm's worst
     * observed case.
     */
    await page.getByTitle('Chat settings').click();
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
    await seedActiveChats(page, [
      {
        sessionId: 'session-1',
        conversationId: 'conv-1',
        agentSlug: 'dev-agent',
        model: 'claude-sonnet',
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
    await page
      .getByRole('button', { name: 'Expand chat dock', exact: true })
      .click();

    await page.getByPlaceholder('Type a message...').fill('Inspect the repo');
    await page.getByRole('button', { name: 'Send' }).click();

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
          override: 'claude-sonnet',
          options: {
            reasoningEffort: 'xhigh',
            fastMode: true,
          },
        },
      },
    });
  });
});
