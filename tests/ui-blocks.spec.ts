import { expect, test } from '@playwright/test';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import {
  emitMockOrchestrationEvent,
  installMockOrchestrationSse,
  openChatRegion,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

test.describe('Structured UI blocks', () => {
  test('renders card and table blocks from persisted conversation parts', async ({
    page,
  }) => {
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
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await page.route('**/api/orchestration/commands', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      }),
    );

    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
      },
    });

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:01.000Z',
        method: 'tool.started',
        turnId: 'turn-1',
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'render_summary',
        arguments: {},
      },
    });

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:02.000Z',
        method: 'tool.completed',
        turnId: 'turn-1',
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'render_summary',
        status: 'success',
        output: {
          uiBlocks: [
            {
              type: 'card',
              title: 'Build Summary',
              body: 'All checks passed',
              fields: [{ label: 'Coverage', value: '98%' }],
            },
            {
              type: 'table',
              title: 'Artifacts',
              columns: ['Name', 'Status'],
              rows: [['report.md', 'generated']],
            },
            {
              type: 'code',
              title: 'Snippet',
              caption: 'verify.sh',
              language: 'bash',
              code: 'npm run verify:static',
            },
          ],
        },
      },
    });

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:03.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
      },
    });

    await expect(page.getByText('Build Summary')).toBeVisible();
    await expect(page.getByText('All checks passed')).toBeVisible();
    await expect(page.getByText('Coverage')).toBeVisible();
    await expect(page.getByText('98%')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Artifacts' }),
    ).toBeVisible();
    await expect(page.getByText('report.md')).toBeVisible();
    await expect(page.getByText('generated')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Snippet' })).toBeVisible();
    await expect(page.getByText('verify.sh')).toBeVisible();
    await expect(page.getByText('npm run verify:static')).toBeVisible();
  });

  test('submitting a form block re-enters the conversation as a tagged user turn', async ({
    page,
  }) => {
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
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);

    // Capture the form submission's outgoing chat turn.
    let sentBody: string | null = null;
    let releaseResponse!: () => void;
    let markResponseFulfilled!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const responseFulfilled = new Promise<void>((resolve) => {
      markResponseFulfilled = resolve;
    });
    await page.route('**/api/orchestration/chat', async (route) => {
      sentBody = route.request().postData();
      await responseGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          foregroundMessageReceiptEnvelope({
            conversationId: 'conv-1',
            sessionId: 'session-1',
            agent: 'dev-agent',
          }),
        ),
      });
      markResponseFulfilled();
    });

    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:01.000Z',
        method: 'tool.completed',
        turnId: 'turn-1',
        itemId: 'tool-f',
        toolCallId: 'tool-f',
        toolName: 'render_component',
        status: 'success',
        output: {
          uiBlock: {
            type: 'form',
            id: 'gate-approve',
            title: 'Approve gate',
            submitLabel: 'Approve',
            fields: [
              {
                name: 'reviewer',
                label: 'Reviewer',
                type: 'text',
                required: true,
              },
              { name: 'sign_off', label: 'Sign off', type: 'checkbox' },
            ],
          },
        },
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:02.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
      },
    });

    await expect(
      page.getByRole('heading', { name: 'Approve gate' }),
    ).toBeVisible();

    // Required-field guard fires before any send.
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('"Reviewer" is required.')).toBeVisible();
    expect(sentBody).toBeNull();

    // Fill and submit.
    await page.getByLabel('Reviewer').fill('brian');
    await page.getByText('Sign off').click();
    await page.getByRole('button', { name: 'Approve' }).click();

    // Form locks after submit, and the tagged structured turn was sent.
    await expect(page.getByRole('button', { name: 'Submitted' })).toBeVisible();
    await expect.poll(() => sentBody).not.toBeNull();
    const turn = JSON.parse(sentBody as unknown as string).message as string;
    expect(turn).toContain('Submitted form "Approve gate":');
    expect(turn).toContain('- Reviewer: brian');
    expect(turn).toContain('- Sign off: yes');
    expect(turn).toContain('__stationFormSubmission');
    expect(turn).toContain('"reviewer": "brian"');

    releaseResponse();
    await responseFulfilled;
  });

  // archive#1399 — a claiming table block with
  // no `derivedFrom` — exactly the `render_summary` shape used in the first
  // test above, from a tool that is NOT `render_component` — must render
  // the visible "Unattested" badge, never silently as if checked.
  test('a claiming table block with no derivedFrom renders the Unattested badge', async ({
    page,
  }) => {
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
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);

    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:01.000Z',
        method: 'tool.completed',
        turnId: 'turn-1',
        itemId: 'tool-2',
        toolCallId: 'tool-2',
        toolName: 'render_summary',
        status: 'success',
        output: {
          uiBlocks: [
            {
              type: 'table',
              title: 'Artifacts',
              columns: ['Name', 'Status'],
              rows: [['report.md', 'generated']],
              // Deliberately no derivedFrom — the fabricated-claim case.
            },
          ],
        },
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:02.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
      },
    });

    await expect(
      page.getByRole('heading', { name: 'Artifacts' }),
    ).toBeVisible();
    await expect(page.getByText('Unattested')).toBeVisible();
  });
});
