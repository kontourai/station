import { expect, test } from '@playwright/test';
import { monitorBrowserHealth } from './helpers/browser-health';
import {
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

const answerBasisProjection = {
  version: 'surface.basis-projection/v1',
  answer: {
    owner: { authority: '@kontourai/thread' },
    state: 'available',
    observedAt: '2026-04-05T11:59:59.000Z',
    value: {
      ref: {
        authority: '@kontourai/thread',
        schemaVersion: '1.2.0',
        kind: 'assistant-message',
        standing: 'observed',
        threadId: 'session-1',
        messageId: 'message-turn-0',
      },
      fact: 'answer-observed',
      observedAt: '2026-04-05T11:59:59.000Z',
    },
  },
  standing: 'execution-only',
  unresolvedReason: null,
  assessment: {
    owner: { authority: '@kontourai/surface' },
    state: 'not-captured',
    observedAt: '2026-04-05T11:59:59.000Z',
  },
  regions: {
    inputs: [],
    execution: [],
    process: [],
    outcomes: [],
    support: [],
    sources: [],
    live: [],
  },
  relationships: [],
  gaps: [],
};

test.describe('Orchestration Chat Flow', () => {
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
        orchestrationSessionStarted: false,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    // `ChatDockBody.tsx:751-770` mounts the transcript list — and with it the
    // streaming shell and every tool row — only once the projected transcript
    // already HAS a message, rendering a "No messages yet" filler otherwise
    // (archive#2467 gated the heavy list on content). A live `turn.started` does not
    // append one: `hooks/orchestration/turnHandlers.ts:51-100` opens the turn
    // and ignores `event.prompt`. So the durable window has to carry one
    // settled prior turn, or every locator below has nothing to resolve
    // against. Registered after `seedOrchestrationRoutes`, so it wins.
    await installMockOrchestrationEventWindow(page, 'codex', {
      'session-1': [
        {
          method: 'turn.started',
          provider: 'codex',
          threadId: 'session-1',
          turnId: 'turn-0',
          createdAt: '2026-04-05T11:59:58.000Z',
          prompt: 'Set up the repo',
        },
        {
          method: 'turn.completed',
          provider: 'codex',
          threadId: 'session-1',
          turnId: 'turn-0',
          createdAt: '2026-04-05T11:59:59.000Z',
          outputText: 'Ready.',
        },
      ],
    });
    // Without this the dock reports "Session record missing." — the fixture
    // claims a started session that the live read-model has never heard of —
    // and that alert quotes the last known turn verbatim, which makes
    // transcript text assertions ambiguous.
    await page.route('**/api/orchestration/sessions/read-model', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              threadId: 'session-1',
              provider: 'codex',
              status: 'running',
              lifecycleState: 'running',
              hasActiveTurn: true,
              controlMode: 'station-owned',
              answerability: { answerable: true },
              isLoaded: true,
              isPersisted: true,
              eventCount: 2,
              createdAt: '2026-04-05T11:59:58.000Z',
              updatedAt: '2026-04-05T12:00:00.000Z',
            },
          ],
        }),
      }),
    );
  });

  test('restores direct-answer Basis with the canonical Project id, never its route slug', async ({
    page,
  }) => {
    await page.route(
      '**/api/orchestration/sessions/session-1/turns/turn-0/basis',
      (route) =>
        route.fulfill({
          json: { success: true, data: answerBasisProjection },
        }),
    );
    await page.goto('/projects/dev/layouts/code');
    await dismissSetupLauncher(page);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(window.localStorage).find((key) =>
            key.includes('workspace-pane-host:v2:project:p1:l1'),
          ),
        ),
      )
      .not.toBeUndefined();
    const persistedKey = await page.evaluate(() =>
      Object.keys(window.localStorage).find((key) =>
        key.includes('workspace-pane-host:v2:project:p1:l1'),
      ),
    );
    expect(persistedKey).toBeTruthy();
    await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) throw new Error('missing Project pane host document');
      const document = JSON.parse(raw);
      const instanceId = 'basis:direct:2:p1|9:session-1|6:turn-0';
      const instance = {
        version: '1.0',
        descriptorId: 'pane:builtin:basis',
        instanceId,
        stateKey: instanceId,
        boundContext: {
          projectId: 'p1',
          sessionId: 'session-1',
          turnId: 'turn-0',
          sourceId: 'builtin:workspace-basis:direct',
        },
      };
      document.instances.push(instance);
      document.activeInstanceId = instanceId;
      const addToFirstTabs = (node: any): boolean => {
        if (node.type === 'tabs') {
          node.instanceIds.push(instanceId);
          node.selectedInstanceId = instanceId;
          return true;
        }
        return addToFirstTabs(node.first) || addToFirstTabs(node.second);
      };
      if (!addToFirstTabs(document.root))
        throw new Error('missing Project pane tab group');
      window.localStorage.setItem(key, JSON.stringify(document));
    }, persistedKey!);
    await page.reload();
    await expect(page.locator('.station-basis-pane')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Basis' })).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.values(window.localStorage).find((value) =>
            value.includes('pane:builtin:basis'),
          ),
        ),
      )
      .toContain('"projectId":"p1"');
    expect(
      await page.evaluate(() =>
        Object.values(window.localStorage).some(
          (value) =>
            value.includes('pane:builtin:basis') &&
            value.includes('"projectId":"dev"'),
        ),
      ),
    ).toBe(false);
  });

  test('renders transcript, tool activity, and approval UI from canonical events', async ({
    page,
  }) => {
    const browserHealth = await monitorBrowserHealth(page);
    const commandBodies: any[] = [];
    await page.route('**/api/system/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configured: [
              {
                id: 'codex-runtime',
                type: 'codex',
                enabled: true,
                capabilities: ['llm'],
              },
            ],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: {
            chat: {
              ready: true,
              source: 'codex-runtime',
            },
          },
        }),
      });
    });
    await page.route('**/api/orchestration/commands', async (route) => {
      const payload = route.request().postDataJSON();
      commandBodies.push(payload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      });
    });

    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await page.evaluate(() => {
      sessionStorage.setItem(
        'activeChats',
        JSON.stringify([
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
            orchestrationSessionStarted: false,
            ephemeralMessages: [],
            inputHistory: [],
          },
        ]),
      );
    });
    await page.reload();
    await dismissSetupLauncher(page);
    await page
      .getByRole('button', { name: 'Expand chat dock', exact: true })
      .click();
    await waitForMockOrchestrationSse(page);

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:00.000Z',
        method: 'session.started',
        sessionId: 'session-1',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:01.000Z',
        method: 'session.configured',
        sessionId: 'session-1',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:02.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'Inspect the repo',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:03.000Z',
        method: 'tool.started',
        turnId: 'turn-1',
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'shell_exec',
        arguments: { command: 'ls', cwd: '/tmp/test' },
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:04.000Z',
        method: 'tool.progress',
        turnId: 'turn-1',
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        message: 'listing files',
      },
    });
    // Negative control: if the transcript list still fails to mount, this says
    // so here rather than leaving the tool assertions to report a missing
    // element with no explanation.
    await expect(page.locator('.streaming-message')).toHaveCount(1);
    await expect(page.locator('.tool-call__progress')).toHaveText(
      'listing files',
    );
    await expect(page.locator('.streaming-progress__label')).toHaveText(
      'listing files',
    );
    await expect(page.getByText('shell exec')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:05.000Z',
        method: 'request.opened',
        requestId: 'req-1',
        requestType: 'permission',
        title: 'Approve permissions',
        description: 'Needs network access',
        payload: {
          toolName: 'shell_exec',
        },
      },
    });

    const approvalQueue = page.getByRole('button', {
      name: '1 pending approval',
    });
    await expect(approvalQueue).toBeVisible();
    await expect(page.getByText('Tool Approval Request')).toBeHidden();
    const queueBox = await approvalQueue.boundingBox();
    expect(queueBox).not.toBeNull();
    expect(queueBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(queueBox!.x).toBeGreaterThanOrEqual(0);
    expect(queueBox!.x + queueBox!.width).toBeLessThanOrEqual(390);

    await approvalQueue.click();
    await expect(page.getByText('Tool Approval Request')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Allow Once' }),
    ).toBeVisible();
    const allowBox = await page
      .getByRole('button', { name: 'Allow Once' })
      .boundingBox();
    expect(allowBox).not.toBeNull();
    expect(allowBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Allow Once' }).click();
    await expect(approvalQueue).toBeHidden();

    /**
     * archive#1259, in a real browser. Approving the last pending request is
     * the popover's own primary action, and it unmounts the queue element with
     * the trigger inside it — the surface destroying the control it owes focus
     * back to. Nothing restored on this path before, so focus landed on
     * `<body>`, archive#1126's outcome, on the most ordinary approval there is.
     *
     * This has to be asserted here rather than in vitest: jsdom reports
     * `.focus()` on an element that cannot take focus as successful, so the
     * walk's browser-side verification is invisible to it. The unit suite
     * covers the removal-and-walk half; this covers the half only Chromium can
     * answer.
     */
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.id || document.activeElement?.tagName,
        ),
      )
      .toBe('root');

    await page.setViewportSize({ width: 1280, height: 720 });
    await page
      .getByRole('button', { name: 'Expand chat dock', exact: true })
      .click();

    await expect
      .poll(() =>
        commandBodies.some((body) => body.type === 'respondToRequest'),
      )
      .toBe(true);

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:06.000Z',
        method: 'request.resolved',
        requestId: 'req-1',
        status: 'approved',
      },
    });
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
          output: 'file-a',
          exitCode: 0,
        },
      },
    });
    // Completion clears the live activity label AND the collapsed progress
    // line — a settled row repeating its last progress message would read as
    // ongoing activity (archive#2652 redesign). The final message is
    // retained in the row's expanded detail, asserted after the turn
    // settles below.
    await expect(page.locator('.streaming-progress__label')).toBeHidden();
    await expect(page.locator('.tool-call__progress')).toBeHidden();
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:08.000Z',
        method: 'content.text-delta',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'Repo looks healthy.',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:09.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'stop',
        outputText: 'Repo looks healthy.',
      },
    });

    await expect(
      page
        .getByRole('log', { name: 'Conversation transcript' })
        .getByText('Repo looks healthy.'),
    ).toBeVisible();
    // archive#2652 redesign: the settled activity is a quiet inline row (no
    // "Show N work activities" gate) labelled by its command. Expanding it
    // reveals the exact tool name and the final progress message as the
    // historical record.
    const activityRow = page.getByRole('button', { name: 'Ran ls' });
    await expect(activityRow).toBeVisible();
    await activityRow.click();
    await expect(page.getByText('shell_exec')).toBeVisible();
    await expect(page.locator('.tool-call__last-progress')).toHaveText(
      'listing files',
    );
    await expect(
      page.getByText('Awaiting tool approval (1)'),
    ).not.toBeVisible();
    browserHealth.assertHealthy();
  });
});
