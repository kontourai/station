import { expect, test } from '@playwright/test';
import {
  emitMockOrchestrationEvent,
  installMockOrchestrationSse,
  openChatRegion,
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
          currentSessionId: 'session-1',
          agentSlug: 'dev-agent',
          projectSlug: 'dev',
          title: 'Foreground Chat',
        },
        'conv-2': {
          id: 'conv-2',
          currentSessionId: 'session-2',
          agentSlug: 'dev-agent',
          projectSlug: 'dev',
          title: 'Background Chat',
        },
      },
    });
  });

  // #2505: only a failed tool call toasts; a successful one stays on its
  // tool row. The success is emitted first, so once the failure's toast is
  // on screen the success has been processed too, and a single card proves
  // it raised none.
  test('a failed background tool call toasts and a successful one does not', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);

    for (const [index, outcome] of [
      { status: 'success', output: { output: 'routine', exitCode: 0 } },
      { status: 'error', error: 'Permission denied' },
    ].entries()) {
      await emitMockOrchestrationEvent(page, 'orchestration:event', {
        event: {
          provider: 'codex',
          threadId: 'session-2',
          createdAt: `2026-04-05T12:00:0${7 + index}.000Z`,
          method: 'tool.completed',
          turnId: `turn-${index + 1}`,
          itemId: `tool-${index + 1}`,
          toolCallId: `tool-${index + 1}`,
          toolName: 'shell_exec',
          ...outcome,
        },
      });
    }

    // Every card, including ones a stack collapses behind the newest.
    const toasts = page.locator('[data-testid^="toast-card"]');
    await expect(page.getByTestId('toast-card')).toContainText(
      'dev-agent failed shell exec',
    );
    await expect(toasts).toHaveCount(1);
    await expect(toasts).toContainText('Tool Activity');
    await expect(toasts).toContainText('Permission denied');
  });
});
