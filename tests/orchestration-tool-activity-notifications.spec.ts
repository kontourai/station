import { expect, test } from '@playwright/test';
import {
  emitMockOrchestrationEvent,
  installMockOrchestrationSse,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

test.describe('Orchestration Tool Activity Notifications', () => {
  test.beforeEach(async ({ page }) => {
    await seedActiveChats(page, [
      {
        sessionId: 'session-1',
        conversationId: 'conv-1',
        agentSlug: 'dev-agent',
        model: 'claude-sonnet',
        provider: 'codex',
        providerOptions: {
          reasoningEffort: 'high',
          fastMode: false,
        },
        orchestrationSessionStarted: true,
        ephemeralMessages: [],
        inputHistory: [],
      },
      {
        sessionId: 'session-2',
        conversationId: 'conv-2',
        agentSlug: 'dev-agent',
        model: 'claude-sonnet',
        provider: 'codex',
        providerOptions: {
          reasoningEffort: 'medium',
          fastMode: false,
        },
        orchestrationSessionStarted: true,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page, {
      conversations: [
        {
          id: 'conv-1',
          title: 'Foreground Chat',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          messageCount: 0,
        },
        {
          id: 'conv-2',
          title: 'Background Chat',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          messageCount: 0,
        },
      ],
      conversationLookups: {
        'conv-1': {
          id: 'conv-1',
          agentSlug: 'dev-agent',
          projectSlug: 'dev',
          title: 'Foreground Chat',
        },
        'conv-2': {
          id: 'conv-2',
          agentSlug: 'dev-agent',
          projectSlug: 'dev',
          title: 'Background Chat',
        },
      },
    });
  });

  test('suppresses foreground success toasts and shows background success toasts', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await page
      .getByRole('button', { name: 'Expand chat dock', exact: true })
      .click();
    await waitForMockOrchestrationSse(page);

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:07.000Z',
        method: 'tool.completed',
        turnId: 'turn-1',
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'shell_exec',
        status: 'success',
        output: {
          output: 'foreground',
          exitCode: 0,
        },
      },
    });

    await expect(page.getByText('Tool Activity')).toHaveCount(0);

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-2',
        createdAt: '2026-04-05T12:00:08.000Z',
        method: 'tool.completed',
        turnId: 'turn-2',
        itemId: 'tool-2',
        toolCallId: 'tool-2',
        toolName: 'shell_exec',
        status: 'success',
        output: {
          output: 'background',
          exitCode: 0,
        },
      },
    });

    await expect(page.getByText('Tool Activity')).toBeVisible();
    await expect(page.getByText('dev-agent finished shell exec')).toBeVisible();
    await expect(page.getByText('background')).toBeVisible();
  });
});
