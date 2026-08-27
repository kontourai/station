import { expect, test } from '@playwright/test';
import {
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationSse,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

test.describe('Flow gate verdicts in session UI', () => {
  test.beforeEach(async ({ page }) => {
    await seedActiveChats(page, [
      {
        sessionId: 'session-1',
        conversationId: 'conv-1',
        agentSlug: 'dev-agent',
        model: 'claude-sonnet',
        provider: 'codex',
        orchestrationSessionStarted: false,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
  });

  test('renders run-attached marker, route-back guidance, and pass card with report link', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await dismissSetupLauncher(page);
    await page
      .getByRole('button', { name: 'Expand chat dock', exact: true })
      .click();
    await waitForMockOrchestrationSse(page);

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: 'session-started-1',
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-06-11T12:00:00.000Z',
        method: 'session.started',
        sessionId: 'session-1',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: 'flow-attached-1',
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-06-11T12:00:01.000Z',
        method: 'flow.run-attached',
        runId: 'session-thread-1',
        // Not `station-delivery`: that retired id is redacted to "Legacy delivery
        // checks" by `flowRunDisplayIdentity`
        // (`packages/contracts/src/flow-presentation.ts:1-17`), so the marker could
        // never print a run id. The redaction is covered a layer down by
        // `src-ui/src/__tests__/FlowRunAttachedMarker.test.tsx:27, 139`.
        definitionId: 'delivery-v2',
        cwd: '/tmp/test',
        resumed: false,
        currentStep: 'verify',
        freshness: {
          lastEvaluatedAt: null,
          gateOutcomeCount: 0,
          evidenceCount: 0,
        },
      },
    });

    // Flow-gated marker in the conversation plus session-level indicator.
    await expect(page.getByText(/Flow-gated session/)).toBeVisible();
    await expect(
      page.getByText('delivery-v2 · session-thread-1'),
    ).toBeVisible();
    await expect(page.getByText('Flow-gated', { exact: true })).toBeVisible();

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: 'flow-verdict-route-back-1',
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-06-11T12:00:02.000Z',
        method: 'flow.gate-verdict',
        runId: 'session-thread-1',
        verdict: 'route-back',
        gateId: 'verify',
        summary: 'Verification gate failed.',
        nextAction: 'Fix the failing unit tests, then request completion.',
        routeBackTo: 'implement',
        attempt: 2,
        maxAttempts: 3,
        currentStep: 'implement',
        freshness: {
          lastEvaluatedAt: '2026-06-11T12:00:02.000Z',
          gateOutcomeCount: 1,
          evidenceCount: 0,
        },
      },
    });

    await expect(page.getByText('Flow gate routed work back')).toBeVisible();
    await expect(
      page.getByText('Fix the failing unit tests, then request completion.'),
    ).toBeVisible();
    await expect(page.getByText('attempt 2 of 3')).toBeVisible();
    await expect(page.getByText('implement')).toBeVisible();

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: 'flow-verdict-pass-1',
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-06-11T12:00:03.000Z',
        method: 'flow.gate-verdict',
        runId: 'session-thread-1',
        verdict: 'pass',
        summary: 'All gates satisfied.',
        reportPaths: {
          json: '.kontourai/flow/runs/session-thread-1/report.json',
          markdown: '.kontourai/flow/runs/session-thread-1/report.md',
        },
        currentStep: 'release',
        freshness: {
          lastEvaluatedAt: '2026-06-11T12:00:03.000Z',
          gateOutcomeCount: 1,
          evidenceCount: 1,
        },
      },
    });

    await expect(page.getByText('Flow gates passed')).toBeVisible();
    await expect(page.getByText('All gates satisfied.')).toBeVisible();
    await expect(
      page.getByText('.kontourai/flow/runs/session-thread-1/report.md'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Copy run report (markdown) path' }),
    ).toBeVisible();
  });
});
