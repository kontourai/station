import { expect, test } from '@playwright/test';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import {
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationSse,
  seedActiveChats,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

test.describe('Orchestration Recovery', () => {
  test.beforeEach(async ({ page }) => {
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
  });

  test('keeps a restored conversation binding after snapshot reconciliation', async ({
    page,
  }) => {
    const executionRequests: Array<Record<string, unknown>> = [];
    await seedActiveChats(page, [
      {
        sessionId: 'session-restore',
        conversationId: 'conv-restore',
        agentSlug: 'dev-agent',
        model: 'gpt-5-codex',
        provider: 'codex',
        projectSlug: 'dev',
        providerOptions: { reasoningEffort: 'medium' },
        orchestrationSessionStarted: false,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await seedOrchestrationRoutes(page, {
      conversations: [
        {
          id: 'conv-restore',
          title: 'Restored Chat',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      conversationLookups: {
        'conv-restore': {
          id: 'conv-restore',
          agentSlug: 'dev-agent',
          projectSlug: 'dev',
          title: 'Restored Chat',
        },
      },
    });
    await page.route('**/api/orchestration/chat', async (route) => {
      const request = route.request().postDataJSON() as Record<string, unknown>;
      executionRequests.push(request);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          foregroundMessageReceiptEnvelope({
            conversationId: String(request.conversationId ?? ''),
            agent: 'dev-agent',
          }),
        ),
      });
    });

    await page.goto('/projects/dev/layouts/code?chat=conv-restore');
    await dismissSetupLauncher(page);
    await page
      .getByRole('button', { name: 'Expand chat dock', exact: true })
      .click();
    await emitMockOrchestrationEvent(page, 'orchestration:snapshot', {
      sessions: [
        {
          provider: 'codex',
          threadId: 'session-restore',
          status: 'ready',
          model: 'gpt-5-codex',
        },
      ],
    });

    await page.getByPlaceholder('Type a message...').fill('Resume work');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => executionRequests.length).toBe(1);
    expect(executionRequests[0]).toMatchObject({
      conversationId: 'conv-restore',
      message: 'Resume work',
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
          override: 'gpt-5-codex',
          options: { reasoningEffort: 'medium' },
        },
      },
    });
  });

  test('uses the persisted conversation binding when the snapshot lacks a session', async ({
    page,
  }) => {
    const executionRequests: Array<Record<string, unknown>> = [];
    await seedActiveChats(page, [
      {
        sessionId: 'session-closed',
        conversationId: 'conv-closed',
        agentSlug: 'dev-agent',
        model: 'gpt-5-codex',
        provider: 'codex',
        projectSlug: 'dev',
        providerOptions: { reasoningEffort: 'high' },
        orchestrationSessionStarted: true,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await seedOrchestrationRoutes(page, {
      conversations: [
        {
          id: 'conv-closed',
          title: 'Closed Chat',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      conversationLookups: {
        'conv-closed': {
          id: 'conv-closed',
          agentSlug: 'dev-agent',
          projectSlug: 'dev',
          title: 'Closed Chat',
        },
      },
    });
    await page.route('**/api/orchestration/chat', async (route) => {
      const request = route.request().postDataJSON() as Record<string, unknown>;
      executionRequests.push(request);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          foregroundMessageReceiptEnvelope({
            conversationId: String(request.conversationId ?? ''),
            agent: 'dev-agent',
          }),
        ),
      });
    });

    await page.goto('/projects/dev/layouts/code?chat=conv-closed');
    await dismissSetupLauncher(page);
    await page
      .getByRole('button', { name: 'Expand chat dock', exact: true })
      .click();
    await emitMockOrchestrationEvent(page, 'orchestration:snapshot', {
      sessions: [],
    });

    await page.getByPlaceholder('Type a message...').fill('Restart session');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => executionRequests.length).toBe(1);
    expect(executionRequests[0]).toMatchObject({
      conversationId: 'conv-closed',
      message: 'Restart session',
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
          override: 'gpt-5-codex',
          options: { reasoningEffort: 'high' },
        },
      },
    });
  });
});
