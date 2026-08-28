import { expect, type Page, test } from '@playwright/test';
import {
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationSse,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

// archive#149 big-bang cutover: ACP chats ride the same orchestration chat surface
// as Claude/Codex (AC1), the typed plan.updated event renders and
// live-updates the Plan inspector tab (AC3), and the _kiro.dev OAuth
// extension.notification renders a clickable auth link (AC4). Modeled
// directly on tests/orchestration-chat-flow.spec.ts's mocked fetch-SSE
// harness — no real ACP process is spawned; the orchestration event stream
// uses a streaming mocked fetch response, matching the authenticated product
// conventions (page.route API isolation, addInitScript/evaluate seeding).

const ACP_AGENT_SLUG = 'kiro';
const SESSION_ID = 'session-acp-1';
const CONVERSATION_ID = 'conv-acp-1';

async function seedAcpChatState(page: Page): Promise<void> {
  await seedActiveChats(page, [
    {
      sessionId: SESSION_ID,
      conversationId: CONVERSATION_ID,
      agentSlug: ACP_AGENT_SLUG,
      model: 'kiro-chat',
      provider: 'acp',
      projectSlug: 'dev',
      orchestrationSessionStarted: false,
      ephemeralMessages: [],
      inputHistory: [],
    },
  ]);
  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page, {
    conversations: [
      {
        id: CONVERSATION_ID,
        title: 'Kiro Chat',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-01T00:00:00Z',
        messageCount: 0,
      },
    ],
    conversationLookups: {
      [CONVERSATION_ID]: {
        id: CONVERSATION_ID,
        agentSlug: ACP_AGENT_SLUG,
        projectSlug: 'dev',
        title: 'Kiro Chat',
      },
    },
  });
  // The default seedOrchestrationRoutes agents fixture only knows
  // 'dev-agent'; override with the persisted default Agent for this engine
  // shape getACPManagerVirtualAgents emits (Wave 1, acp-manager-view.ts).
  await page.route('**/api/agents', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          {
            slug: ACP_AGENT_SLUG,
            name: 'Kiro Chat',
            description: 'Chat with Kiro via ACP.',
            source: 'acp',
            engineConnectionType: 'acp',
            connectionName: 'kiro-cli',
            execution: { agentConnectionId: 'kiro' },
          },
        ],
      }),
    }),
  );
}

async function openChatDockAndStream(page: Page): Promise<void> {
  await page.goto(`/projects/dev/layouts/code?chat=${CONVERSATION_ID}`);
  await page.evaluate(
    ([sessionId, conversationId, agentSlug]) => {
      sessionStorage.setItem(
        'activeChats',
        JSON.stringify([
          {
            sessionId,
            conversationId,
            agentSlug,
            model: 'kiro-chat',
            provider: 'acp',
            projectSlug: 'dev',
            orchestrationSessionStarted: false,
            ephemeralMessages: [],
            inputHistory: [],
          },
        ]),
      );
    },
    [SESSION_ID, CONVERSATION_ID, ACP_AGENT_SLUG],
  );
  await page.reload();
  await dismissSetupLauncher(page);
  await page
    .getByRole('button', { name: 'Expand chat dock', exact: true })
    .click();
  await waitForMockOrchestrationSse(page);
}

test.describe('ACP orchestration + plan surface (#149)', () => {
  test.beforeEach(async ({ page }) => {
    await seedAcpChatState(page);
  });

  test('AC1: a full mocked ACP turn renders in the orchestration transcript', async ({
    page,
  }) => {
    await openChatDockAndStream(page);

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'acp',
        threadId: SESSION_ID,
        createdAt: '2026-07-01T12:00:00.000Z',
        method: 'session.started',
        sessionId: SESSION_ID,
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'acp',
        threadId: SESSION_ID,
        createdAt: '2026-07-01T12:00:01.000Z',
        method: 'turn.started',
        turnId: 'turn-acp-1',
        prompt: 'What is the status of the repo?',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'acp',
        threadId: SESSION_ID,
        createdAt: '2026-07-01T12:00:02.000Z',
        method: 'content.text-delta',
        turnId: 'turn-acp-1',
        itemId: 'msg-acp-1',
        delta: 'The ACP agent says hello.',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'acp',
        threadId: SESSION_ID,
        createdAt: '2026-07-01T12:00:03.000Z',
        method: 'turn.completed',
        turnId: 'turn-acp-1',
        finishReason: 'stop',
        outputText: 'The ACP agent says hello.',
      },
    });

    // Scoped to the transcript: the dock ALSO quotes the last known turn
    // verbatim inside its "Session record missing." alert
    // (`components/chat-dock/ChatDockBody.tsx:726-738`), which this fixture
    // legitimately triggers — it emits `session.started` while the live
    // read-model this spec does not mock has no record of the thread. The
    // alert renders outside `role="log"`, so one match remains here.
    await expect(
      page
        .getByRole('log', { name: 'Conversation transcript' })
        .getByText('The ACP agent says hello.'),
    ).toBeVisible();
  });

  test('AC3: plan.updated renders the Plan inspector tab and live-updates it', async ({
    page,
  }, testInfo) => {
    await openChatDockAndStream(page);

    await page.getByRole('tab', { name: /(?:evidence:plan|Plan)/ }).click();

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'acp',
        threadId: SESSION_ID,
        createdAt: '2026-07-01T12:05:00.000Z',
        method: 'plan.updated',
        entries: [
          { content: 'Investigate repo structure', status: 'completed' },
          { content: 'Implement ACP plan rendering', status: 'in_progress' },
          { content: 'Write Playwright coverage', status: 'pending' },
        ],
      },
    });

    const investigateStep = page.locator('.workflow-plan-panel__step', {
      hasText: 'Investigate repo structure',
    });
    const implementStep = page.locator('.workflow-plan-panel__step', {
      hasText: 'Implement ACP plan rendering',
    });
    const writeStep = page.locator('.workflow-plan-panel__step', {
      hasText: 'Write Playwright coverage',
    });

    await expect(investigateStep).toBeVisible();
    await expect(investigateStep).toContainText('Completed');
    await expect(implementStep).toBeVisible();
    await expect(implementStep).toContainText('Active');
    await expect(writeStep).toBeVisible();
    await expect(writeStep).toContainText('Pending');

    // Live-update proof (not just a first render): a second plan.updated
    // event with changed statuses must replace, not append to, the panel.
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'acp',
        threadId: SESSION_ID,
        createdAt: '2026-07-01T12:06:00.000Z',
        method: 'plan.updated',
        entries: [
          { content: 'Investigate repo structure', status: 'completed' },
          { content: 'Implement ACP plan rendering', status: 'completed' },
          { content: 'Write Playwright coverage', status: 'in_progress' },
        ],
      },
    });

    await expect(implementStep).toContainText('Completed');
    await expect(writeStep).toContainText('Active');
    await expect(page.locator('.workflow-plan-panel__step')).toHaveCount(3);

    await page.screenshot({
      path: testInfo.outputPath('acp-orchestration-plan-live-update.png'),
    });
  });

  test('AC4: an MCP OAuth extension.notification renders a clickable auth link', async ({
    page,
  }) => {
    await openChatDockAndStream(page);

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'acp',
        threadId: SESSION_ID,
        createdAt: '2026-07-01T12:10:00.000Z',
        method: 'extension.notification',
        namespace: '_kiro.dev',
        type: 'mcp/oauth_request',
        payload: { url: 'https://kiro.dev/oauth/authorize?client=test' },
      },
    });

    const authLink = page.getByRole('link', {
      name: 'Open authentication page',
    });
    await expect(authLink).toBeVisible();
    await expect(authLink).toHaveAttribute(
      'href',
      'https://kiro.dev/oauth/authorize?client=test',
    );
  });
});
