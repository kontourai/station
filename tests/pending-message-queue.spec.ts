import { expect, test } from '@playwright/test';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import {
  emitMockOrchestrationEvent,
  installMockOrchestrationSse,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

// Mirrors builtin-runtime-workflow.spec.ts's mock-SSE harness (orchestration
// commands + events) rather than sharing its local helpers directly, since
// this scenario only needs a single runtime agent and a route set scoped to
// the pending-queue flow (archive#613).

const PROJECT = {
  id: 'p-default',
  slug: 'station',
  name: 'Default',
  description: 'Default project',
  hasWorkingDirectory: false,
  layoutCount: 0,
  hasKnowledge: false,
};

const AGENTS = [
  {
    slug: 'claude',
    name: 'Claude Runtime',
    description:
      'Direct chat using Claude Runtime with project working directory context when available.',
    source: 'local',
    execution: {
      agentConnectionId: 'claude',
      modelId: 'claude-sonnet-4-20250514',
    },
  },
];

function json(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function seedRuntimeRoutes(
  page: import('@playwright/test').Page,
  executionRequests: Array<Record<string, unknown>>,
) {
  await Promise.all([
    page.route('**/api/system/status', (route) =>
      route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          providers: {
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: {
            chat: { ready: true, source: 'claude' },
            runtime: { ready: true, source: 'claude' },
            knowledge: { ready: false, source: null },
            acp: { ready: false, source: null },
          },
          recommendation: null,
          prerequisites: [],
          clis: { codex: false, claude: true, 'kiro-cli': false },
        }),
      ),
    ),
    page.route('**/api/system/capabilities', (route) =>
      route.fulfill(
        json({
          voice: { stt: [], tts: [] },
          context: { providers: [] },
        }),
      ),
    ),
    page.route('**/api/models/capabilities', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    ),
    page.route('**/api/projects', (route) =>
      route.fulfill(json({ success: true, data: [PROJECT] })),
    ),
    page.route('**/api/projects/default', (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            ...PROJECT,
            createdAt: '2026-04-12T00:00:00Z',
            updatedAt: '2026-04-12T00:00:00Z',
          },
        }),
      ),
    ),
    page.route('**/api/agents', (route) =>
      route.fulfill(json({ success: true, data: AGENTS })),
    ),
    page.route('**/api/connections/agents', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            agentConnectionFixture({
              id: 'claude',
              kind: 'agent',
              type: 'claude',
              name: 'Claude Runtime',
              enabled: true,
              capabilities: ['agent-runtime'],
              config: { defaultModel: 'claude-sonnet-4-20250514' },
              status: 'ready',
              prerequisites: [],
            }),
          ],
        }),
      ),
    ),
    page.route('**/api/connections/models', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    ),
    page.route('**/config/app', (route) =>
      route.fulfill(
        json({
          success: true,
          data: { defaultModel: 'claude-sonnet-4-20250514' },
        }),
      ),
    ),
    page.route('**/api/orchestration/providers', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [{ provider: 'claude', activeSessions: 0, prerequisites: [] }],
        }),
      ),
    ),
    page.route('**/api/orchestration/chat', async (route) => {
      const request = route.request().postDataJSON() as Record<string, unknown>;
      executionRequests.push(request);
      await route.fulfill(
        json(
          foregroundMessageReceiptEnvelope({
            conversationId: String(request.conversationId ?? ''),
            providerTurnId: `provider-turn-${executionRequests.length}`,
            agent: 'claude',
          }),
        ),
      );
    }),
    page.route('**/agents/*/conversations', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    ),
    page.route('**/agents/*/conversations/*/messages', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    ),
    page.route('**/api/conversations**', (route) =>
      route.fulfill(json({ conversations: [] })),
    ),
    page.route('**/events', (route) => route.abort()),
  ]);
}

async function dismissSetupLauncher(page: import('@playwright/test').Page) {
  const continueBtn = page.getByRole('button', {
    name: 'Continue Without Setup',
  });
  if (await continueBtn.isVisible().catch(() => false)) {
    await continueBtn.click({ force: true });
    await expect(continueBtn).not.toBeVisible({ timeout: 5_000 });
  }
}

async function openRuntimeSession(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('lastProject', 'default');
    localStorage.removeItem('recentAgents');
  });
  await page.goto('/?dock=open');
  await dismissSetupLauncher(page);
  const add = page.locator('.chat-dock__tab-actions .chat-dock__new').last();
  await expect(add).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() =>
    window.dispatchEvent(new Event('station:open-new-chat')),
  );
  const modal = page.getByRole('dialog', { name: 'New Chat' });
  await expect(modal).toBeVisible({ timeout: 10_000 });
  const runtimeRow = modal.locator('[data-agent-slug="claude"]').first();
  await expect(runtimeRow).toBeVisible({ timeout: 10_000 });
  await runtimeRow.click();
  await expect(modal).toBeHidden();
  await page.getByRole('button', { name: 'Earlier' }).click();
  await expect(
    page
      .getByRole('complementary', { name: 'Inbox chats' })
      .getByRole('button', { name: 'New chat, No project' })
      .and(page.locator('[aria-current="true"]')),
  ).toBeVisible();
}

test.describe('Pending message queue (#613)', () => {
  test('reorders a mid-turn queue, edits a queued message, and drains in the reordered order', async ({
    page,
  }) => {
    const executionRequests: Array<Record<string, unknown>> = [];

    await installMockOrchestrationSse(page);
    await seedRuntimeRoutes(page, executionRequests);
    await openRuntimeSession(page);
    await waitForMockOrchestrationSse(page);

    // Placeholder-independent: the composer's placeholder becomes "Queue a
    // follow-up…" the moment a turn is in flight (`ChatInputArea.tsx:261-267`),
    // which is the state every enqueue step below runs in. Its fieldset carries
    // the stable accessible name (`:430-432`).
    const textarea = page
      .getByRole('group', { name: 'Message composer', exact: true })
      .getByRole('textbox');
    // Send exists only while the composer is idle: mid-turn
    // `ChatInputArea.tsx:597-625` swaps it for "Stop the current turn", and a
    // follow-up is committed with Enter (`:637-651`). So the opening turn goes
    // through the button and every enqueue below goes through the key — which
    // is also what a person does.
    const sendButton = page.getByRole('button', { name: 'Send', exact: true });

    // Start a turn — the mock server acks foreground execution immediately,
    // but never emits turn.completed until we tell it to, so the session
    // stays mid-turn ("streaming") for the enqueue steps below.
    await textarea.fill('start the task');
    await sendButton.click();
    await expect.poll(() => executionRequests.length).toBe(1);
    const threadId = executionRequests[0].conversationId as string;

    // Enqueue two follow-ups mid-stream. Each only adds to the pending
    // queue — neither should fire another foreground execution request.
    await textarea.fill('queued alpha');
    await textarea.press('Enter');
    await expect(page.locator('.queued-messages')).toContainText(
      '1 message queued',
    );

    await textarea.fill('queued beta');
    await textarea.press('Enter');
    await expect(page.locator('.queued-messages')).toContainText(
      '2 messages queued',
    );

    expect(executionRequests).toHaveLength(1);

    const alphaRow = page.locator('.queued-message', {
      hasText: 'queued alpha',
    });
    const betaRow = page.locator('.queued-message', {
      hasText: 'queued beta',
    });

    // Initial queue order: alpha queued first (order 1, next to send),
    // beta second (order 2).
    await expect(alphaRow.locator('.queued-message__order')).toHaveText('1');
    await expect(betaRow.locator('.queued-message__order')).toHaveText('2');

    // Reorder during the active turn. The list renders newest-on-top with
    // the next-to-send row at the BOTTOM, so "Move message down" moves a
    // row toward sending sooner. Move beta down: it becomes next to send
    // (order 1), alpha rises to order 2 — and beta's rendered position
    // must actually move toward the bottom (archive#613's direction rule).
    await betaRow.getByRole('button', { name: 'Move message down' }).click();
    await expect(betaRow.locator('.queued-message__order')).toHaveText('1');
    await expect(alphaRow.locator('.queued-message__order')).toHaveText('2');
    await expect(page.locator('.queued-message').last()).toContainText(
      'queued beta',
    );

    // Inline edit still works after a reorder.
    await alphaRow.getByRole('button', { name: 'Edit message' }).click();
    const editInput = page.locator('.queued-message input[type="text"]');
    await editInput.fill('queued alpha edited');
    await editInput.press('Enter');
    await expect(
      page.locator('.queued-message', { hasText: 'queued alpha edited' }),
    ).toBeVisible();

    // Complete the first turn — the queue must drain the REORDERED head
    // ('queued beta') automatically, dispatching a new foreground execution.
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:01.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
        outputText: 'Working on it.',
      },
    });

    await expect.poll(() => executionRequests.length).toBe(2);
    expect(executionRequests[1].message).toBe('queued beta');
    expect(executionRequests[1].conversationId).toBe(threadId);

    await expect(page.locator('.queued-messages')).toContainText(
      '1 message queued',
    );
    await expect(
      page.locator('.queued-message', { hasText: 'queued alpha edited' }),
    ).toBeVisible();

    // Complete the drained ('queued beta') turn — the queue must drain the
    // last (edited) message next.
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:02.000Z',
        method: 'turn.completed',
        turnId: 'turn-2',
        outputText: 'Done with beta.',
      },
    });

    await expect.poll(() => executionRequests.length).toBe(3);
    expect(executionRequests[2].message).toBe('queued alpha edited');
    expect(executionRequests[2].conversationId).toBe(threadId);

    // The queue is empty once the last drained message has been dispatched.
    await expect(page.locator('.queued-messages')).toHaveCount(0);
  });
});
