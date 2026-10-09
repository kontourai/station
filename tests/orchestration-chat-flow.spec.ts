import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import { expect, type Locator } from '@playwright/test';
import { monitorBrowserHealth } from './helpers/browser-health';
import { openCodingView } from './helpers/coding-stack';
import { backgroundPaint, contrastRatio } from './helpers/color-contrast';
import { test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  openChatRegion,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';
import { openChooserFromToggle } from './helpers/region-placement';
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
        orchestrationSessionStarted: true,
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
    await installMockOrchestrationConversationEventWindow(
      page,
      (conversationId) => (conversationId === 'conv-1' ? ['session-1'] : []),
    );
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
    // The Coding layout lands on its Chat page; the restored pane is a
    // drill-in of it (#928 coding stack).
    await openCodingView(page, /Basis/);
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
                id: 'codex',
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
              source: 'codex',
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
            orchestrationSessionStarted: true,
            ephemeralMessages: [],
            inputHistory: [],
          },
        ]),
      );
    });
    await page.reload();
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);
    await expect(page.getByText('Ready.', { exact: true })).toBeVisible();

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
    // The active tool owns its progress; a second working/progress footer
    // would duplicate it and consume space in the compact transcript.
    await expect(page.locator('.streaming-activity')).toHaveCount(0);
    await expect(page.locator('.tool-call__pulse')).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Running ls' }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    // On a phone the Coding layout's Chat is the dock again (the wide
    // centre's Chat unmounts); the approval arrives once it is on screen.
    await expect(page.locator('#chat-dock')).toBeVisible();
    await expect(page.locator('#chat-workspace-pane')).toHaveCount(0);
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

    // The chat pane presents its own pending approval in its floating status
    // pill, so the app-wide queue does not float a second "1 pending
    // approval" trigger over the pane. This request is bound to no transcript
    // row, so the pill has no card to reveal and opens the queue instead.
    const approvalQueue = page.getByRole('button', {
      name: /^Needs approval/,
    });
    await expect(approvalQueue).toBeVisible();
    await expect(
      page.getByRole('button', { name: '1 pending approval' }),
    ).toHaveCount(0);
    await expect(page.getByText('Tool Approval Request')).toBeHidden();
    // The pill floats in with a scale transform; measure the settled box.
    await approvalQueue.evaluate((pill) =>
      Promise.all(pill.getAnimations().map((animation) => animation.finished)),
    );
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

    // The notification decision opens its conversation. The removed trigger
    // returns focus to its surviving pane; Tab must enter that chat, not Home.
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/' && url.searchParams.get('chat') === 'conv-1',
    );
    await expect
      .poll(() => page.evaluate(() => document.activeElement !== document.body))
      .toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.locator('#chat-dock :focus')).toHaveCount(1);

    await page.setViewportSize({ width: 1280, height: 720 });
    // Notification navigation left the Coding layout for the canonical dock.
    await expect(page.locator('#chat-dock')).toBeVisible();
    await expect(page.locator('#chat-workspace-pane')).toHaveCount(0);
    await openChatRegion(page);

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
    // Completion clears the tool's animation and collapsed progress
    // line — a settled row repeating its last progress message would read as
    // ongoing activity (archive#2652 redesign). The final message is
    // retained in the row's expanded detail, asserted after the turn
    // settles below.
    await expect(page.locator('.tool-call__pulse')).toHaveCount(0);
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

  /**
   * #2917, in a real browser: jsdom has no layout, so only Chromium can say
   * whether the inline approval card keeps its label and glyphs clear of its
   * buttons. The card here is the pending-approvals strip's ToolCallDisplay —
   * an open request no transcript row answers — driven through the real
   * answer path into each state the issue names: pending, refused ("was not
   * delivered"), and "no longer open" (buttons disabled).
   */
  test('keeps the approval card label visible and its glyphs clear of its controls at 360px and 720px (decisions in the #3331 request sheet) and in a narrow desktop dock, with legible buttons in both themes (#2917)', async ({
    page,
  }) => {
    const browserHealth = await monitorBrowserHealth(page);
    let answer: 'refuse' | 'settled' = 'refuse';
    let requestId = 'req-2917';
    let requestEventId = 'evt-req-2917';
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
                id: 'codex',
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
              source: 'codex',
            },
          },
        }),
      });
    });
    await page.route('**/api/orchestration/commands', async (route) => {
      await route.fulfill({
        status: 409,
        headers: { [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE },
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'The engine connection closed before the answer landed.',
        }),
      });
    });
    await page.route(
      /\/api\/orchestration\/sessions\/session-1\/requests\/req-2917(?:-desktop)?(?:\?|$)/,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            answer === 'settled'
              ? {
                  success: true,
                  data: {
                    state: 'resolved',
                    reference: {
                      threadId: 'session-1',
                      requestId,
                      requestEventId,
                    },
                    message: 'Answered elsewhere.',
                  },
                }
              : { success: false },
          ),
        });
      },
    );

    // History, not a live emit: the strip reads the durable event window,
    // which is what a reload with a request still open presents.
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
        {
          method: 'request.opened',
          provider: 'codex',
          threadId: 'session-1',
          createdAt: '2026-04-05T12:00:05.000Z',
          eventId: requestEventId,
          requestId,
          requestType: 'permission',
          title: 'Approve command',
          payload: {
            toolName: 'shell_exec',
            toolInput: {
              command:
                'npm run test:focused -- src-ui/src/components/chat/ToolCallDisplay.tsx --reporter=verbose',
            },
          },
        },
      ],
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
            orchestrationSessionStarted: true,
            ephemeralMessages: [],
            inputHistory: [],
          },
        ]),
      );
    });
    await page.reload();
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);
    await expect(page.getByText('Ready.', { exact: true })).toBeVisible();
    await page.addStyleTag({
      content:
        '*, *::before, *::after { transition: none !important; animation: none !important; }',
    });
    const card = page
      .getByRole('region', { name: 'Approvals waiting on you' })
      .locator('.tool-call');
    const allowOnce = card.getByRole('button', {
      name: 'Allow Once',
      exact: true,
    });
    await expect(allowOnce).toBeVisible();

    // On a phone width (#3331) the row carries one Answer control and the
    // three decisions move into the shared request sheet; the desktop row
    // keeps all three inline.
    const expectClearLayout = async (
      context: string,
      controls = '.tool-call__approve-btn, button[aria-label="More ways to allow this request"]',
      controlCount = 3,
    ) => {
      const label = await card.locator('.tool-call__label').boundingBox();
      expect(label, `${context}: label box`).not.toBeNull();
      // Collapsed to 0px on main at 360px (every state) and at 720px once
      // the refused sentence showed.
      expect(label!.width, `${context}: label width`).toBeGreaterThan(40);
      // The line keeps at least its 10rem (160px) basis, or the whole row
      // when the row is narrower: sharing a row with the actions must never
      // squeeze it below that (squeezed, the label read as one letter).
      const row = await card.locator('.tool-call__row').boundingBox();
      const line = await card.locator('.tool-call__line').boundingBox();
      expect(line!.width, `${context}: line width`).toBeGreaterThanOrEqual(
        Math.min(160, row!.width) - 1,
      );
      const buttons = await card.locator(controls).evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return {
            text: node.textContent,
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
          };
        }),
      );
      expect(buttons, context).toHaveLength(controlCount);
      const glyphs = await card
        .locator('.tool-call__glyph, .tool-call__awaiting, .tool-call__chevron')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const r = node.getBoundingClientRect();
            return {
              name: node.className,
              x: r.x,
              y: r.y,
              w: r.width,
              h: r.height,
            };
          }),
        );
      expect(
        glyphs.length,
        `${context}: glyphs rendered`,
      ).toBeGreaterThanOrEqual(2);
      const overlaps = glyphs.flatMap((glyph) =>
        buttons
          .filter(
            (button) =>
              glyph.x < button.x + button.w &&
              button.x < glyph.x + glyph.w &&
              glyph.y < button.y + button.h &&
              button.y < glyph.y + glyph.h,
          )
          .map((button) => `${glyph.name} over ${button.text}`),
      );
      expect(overlaps, `${context}: glyph/button overlap`).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${context}: no horizontal overflow`,
      ).toBe(true);
    };

    const expectLegibleButtons = async (
      context: string,
      buttons: Locator = card.locator('.tool-call__approve-btn'),
    ) => {
      const measure = async (button: Locator, label: string) => {
        // contrastRatio does not model element opacity, which is how the
        // disabled and hover states used to fade the text under 4.5:1. Pin
        // it separately so the ratio below is the painted one.
        expect(
          await button.evaluate((node) => getComputedStyle(node).opacity),
          `${label}: opacity`,
        ).toBe('1');
        // Inactive controls are exempt from 4.5:1, but the disabled state
        // must stay legible (3:1) and read as inactive: it paints no fill.
        const disabled = await button.isDisabled();
        expect(
          await contrastRatio(button),
          `${label}: contrast`,
        ).toBeGreaterThanOrEqual(disabled ? 3 : 4.5);
        if (disabled)
          expect(
            (await backgroundPaint(button)).alpha,
            `${label}: disabled fill`,
          ).toBe(0);
      };
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        for (const button of await buttons.all()) {
          const label = `${context} ${theme} ${await button.textContent()}`;
          await page.mouse.move(0, 0);
          await measure(button, label);
          if (await button.isEnabled()) {
            await button.hover();
            await measure(button, `${label} (hover)`);
          }
        }
      }
      await page.mouse.move(0, 0);
    };

    await page.setViewportSize({ width: 360, height: 800 });
    // At a phone width the Coding layout's Chat is its dock again (#928
    // coding stack): the centre's Chat unmounts and the Chat page opens the
    // dock maximized. `boundingBox()` does not wait, so the card has to be
    // back on screen in the dock before its geometry is read.
    await expect(page.locator('#chat-workspace-pane')).toHaveCount(0);
    await expect(page.locator('#chat-dock')).toBeVisible();
    const sheet = page.getByRole('dialog', { name: 'Needs approval' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close and answer later' }).click();
    await expect(sheet).toBeHidden();
    const answerControl = card.getByRole('button', {
      name: 'Answer',
      exact: true,
    });
    await expect(answerControl).toBeVisible();
    await expect(allowOnce).toHaveCount(0);
    await expectClearLayout('pending 360', '.request-sheet-trigger', 1);
    await expectLegibleButtons('pending row', answerControl);

    await answerControl.click();
    const sheetActions = sheet.getByRole('button', {
      name: /^(Allow Once|Deny)$/,
    });
    await expect(sheetActions).toHaveCount(2);
    const sheetAllow = sheet.getByRole('button', {
      name: 'Allow Once',
      exact: true,
    });
    await expect(sheetAllow).toBeVisible();
    await expectLegibleButtons('pending sheet', sheetActions);

    await sheetAllow.click();
    await expect(sheet.getByRole('alert')).toContainText(
      'Your decision was not delivered',
    );
    await expectClearLayout('refused 360', '.request-sheet-trigger', 1);
    await expectLegibleButtons('refused sheet', sheetActions);
    await page.setViewportSize({ width: 720, height: 800 });
    // 720px is still a phone-class width (max-width 768px): the sheet stays
    // open over the row, and the row keeps its label beside Answer.
    await expect(sheet).toBeVisible();
    await expectClearLayout('refused 720', '.request-sheet-trigger', 1);

    answer = 'settled';
    await page.setViewportSize({ width: 360, height: 800 });
    await sheetAllow.click();
    await expect(sheet.getByRole('status')).toHaveText(
      'This request is no longer open.',
    );
    await expect(sheetAllow).toBeDisabled();
    await expectClearLayout('no longer open 360', '.request-sheet-trigger', 1);

    // A desktop viewport (above the 768px breakpoint, so the shared mobile
    // `[class*="__actions"]` wrap rule does not apply) with the card in the
    // real narrow right dock. The actions must wrap inside the card rather
    // than overflow it with buttons squeezed into vertical letters.
    await emitMockOrchestrationEvent(
      page,
      'orchestration:event',
      {
        event: {
          method: 'request.resolved',
          provider: 'codex',
          threadId: 'session-1',
          createdAt: '2026-04-05T12:00:05.500Z',
          eventId: 'evt-resolved-2917',
          requestId,
          status: 'approved',
        },
      },
      { sequence: 4 },
    );
    answer = 'refuse';
    requestId = 'req-2917-desktop';
    requestEventId = 'evt-req-2917-desktop';
    await emitMockOrchestrationEvent(
      page,
      'orchestration:event',
      {
        event: {
          method: 'request.opened',
          provider: 'codex',
          threadId: 'session-1',
          createdAt: '2026-04-05T12:00:06.000Z',
          eventId: requestEventId,
          requestId,
          requestType: 'permission',
          title: 'Approve command',
          payload: {
            toolName: 'shell_exec',
            toolInput: {
              command:
                'npm run test:focused -- src-ui/src/components/chat/ToolCallDisplay.tsx --reporter=verbose',
            },
          },
        },
      },
      { sequence: 5 },
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    // Navigate through the app and place Chat through its public region
    // owner. A browser reload can retain the Coding pane instead of landing
    // the ambient shell under the hosted smoke fixture.
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page).toHaveURL(/\/(?:\?.*)?$/);
    const rightChooser = await openChooserFromToggle(page, 'Right');
    await rightChooser.getByRole('menuitem', { name: /^Chat( |$)/ }).click();
    await expect(rightChooser).toBeHidden();
    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--right/);
    await page.addStyleTag({
      content:
        '*, *::before, *::after { transition: none !important; animation: none !important; }',
    });
    await expect(allowOnce).toBeEnabled();
    const dockWidth = (await page.locator('.chat-dock').boundingBox())!.width;
    expect(dockWidth, 'right dock is a narrow column').toBeLessThanOrEqual(480);
    const expectActionsContained = async (context: string) => {
      const cardBox = (await card.boundingBox())!;
      const actionsBox = (await card
        .locator('.tool-call__actions')
        .boundingBox())!;
      expect(
        actionsBox.x + actionsBox.width,
        `${context}: actions inside the card`,
      ).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
      // Deny and Allow Once; the session choices sit in the overflow menu.
      const lineCounts = await card
        .locator('.tool-call__approve-btn')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return new Set(
              [...range.getClientRects()].map((rect) => Math.round(rect.top)),
            ).size;
          }),
        );
      expect(lineCounts, `${context}: button labels on one line`).toEqual([
        1, 1,
      ]);
    };
    await expectClearLayout('desktop right dock pending');
    await expectActionsContained('desktop right dock pending');
    await allowOnce.click();
    await expect(card.getByRole('alert')).toContainText(
      'Your decision was not delivered',
    );
    await expectClearLayout('desktop right dock refused');
    await expectActionsContained('desktop right dock refused');

    // The disabled "no longer open" state of the inline buttons. Only a
    // desktop renders them since #3331 (a phone answers in the request
    // sheet), so this is where their disabled styling is pinned. The 720px
    // label-row check this test once made has no subject any more: 720px is
    // under the 768px phone query, where the row carries only Answer.
    answer = 'settled';
    const desktopEnabledWidths = await card
      .locator('.tool-call__approve-btn')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().width),
      );
    await allowOnce.click();
    await expect(card.getByRole('status')).toHaveText(
      'This request is no longer open.',
    );
    await expect(allowOnce).toBeDisabled();
    // Disabling restyles the buttons without resizing them: a border that
    // appears only when disabled shifted every button by 2px on click.
    const desktopDisabledWidths = await card
      .locator('.tool-call__approve-btn')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().width),
      );
    expect(desktopDisabledWidths).toHaveLength(desktopEnabledWidths.length);
    desktopDisabledWidths.forEach((width, index) => {
      expect(
        Math.abs(width - desktopEnabledWidths[index]),
        `desktop button ${index} width change on disable`,
      ).toBeLessThan(0.5);
    });
    await expectClearLayout('desktop right dock no longer open');
    await expectLegibleButtons('desktop right dock no longer open');
    browserHealth.assertHealthy();
  });

  /**
   * #3382: right-to-left letters in a pending command must not move the
   * text around them. Measured in Chromium's own layout: each character's
   * box, read left to right line by line, must equal the logical text with
   * only the right-to-left run itself reversed. Isolating a whole word moved
   * its Latin part too (`echo שלום;rm` read as "echo rm;…").
   */
  test('a pending command with right-to-left letters keeps its visual order in the label and the details (#3382)', async ({
    page,
  }) => {
    const hebrew = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd);
    const reversed = [...hebrew].reverse().join('');
    const lineOne = `echo ${hebrew};rm -rf /tmp/x`;
    const lineTwo = `cat ${hebrew}/../../etc/passwd`;
    // Two runs separated only by a space: unisolated, they swap places.
    const world = String.fromCodePoint(0x5e2, 0x5d5, 0x5dc, 0x5dd);
    const worldReversed = [...world].reverse().join('');
    const lineThree = `cp ${hebrew} ${world} x != y`;
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
        {
          method: 'request.opened',
          provider: 'codex',
          threadId: 'session-1',
          createdAt: '2026-04-05T12:00:05.000Z',
          eventId: 'evt-req-rtl',
          requestId: 'req-rtl',
          requestType: 'approval',
          title: 'Approve command',
          payload: {
            toolName: 'Bash',
            toolInput: { command: `${lineOne}\n${lineTwo}\n${lineThree}` },
          },
        },
      ],
    });
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
                id: 'codex',
                type: 'codex',
                enabled: true,
                capabilities: ['llm'],
              },
            ],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: { chat: { ready: true, source: 'codex' } },
        }),
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
            providerOptions: { reasoningEffort: 'high', fastMode: false },
            orchestrationSessionStarted: true,
            ephemeralMessages: [],
            inputHistory: [],
          },
        ]),
      );
    });
    await page.reload();
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);
    await expect(page.getByText('Ready.', { exact: true })).toBeVisible();
    const card = page
      .getByRole('region', { name: 'Approvals waiting on you' })
      .locator('.tool-call');
    const block = card.locator('.tool-call__code--command');
    // Multi-line, so the details are open beside Allow and Deny.
    await expect(block).toBeVisible();

    /** The element's characters as laid out: left to right, line by line. */
    const visualText = (locator: Locator) =>
      locator.evaluate((element) => {
        const boxes: Array<{ top: number; left: number; char: string }> = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? '';
          for (let index = 0; index < text.length; index += 1) {
            if (text[index] === '\n') continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const rect = range.getBoundingClientRect();
            boxes.push({
              top: Math.round(rect.top),
              left: rect.left,
              char: text[index]!,
            });
          }
        }
        const lines = new Map<number, typeof boxes>();
        for (const box of boxes) {
          const line = [...lines.keys()].find(
            (top) => Math.abs(top - box.top) <= 3,
          );
          lines.set(line ?? box.top, [
            ...(lines.get(line ?? box.top) ?? []),
            box,
          ]);
        }
        return [...lines.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, line]) =>
            line
              .sort((a, b) => a.left - b.left)
              .map((box) => box.char)
              .join(''),
          );
      });

    expect(await visualText(card.locator('.tool-call__label'))).toEqual([
      `Run echo ${reversed};rm -rf /tmp/x (+2 lines)`,
    ]);
    expect(await visualText(block)).toEqual([
      `echo ${reversed};rm -rf /tmp/x`,
      `cat ${reversed}/../../etc/passwd`,
      `cp ${reversed} ${worldReversed} x != y`,
    ]);
    // Read literally: no ligatures or contextual alternates, which redraw
    // `../` after right-to-left text and turn `!=` into a symbol.
    const typography = await block.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        ligatures: style.fontVariantLigatures,
        features: style.fontFeatureSettings,
      };
    });
    expect(typography.ligatures).toBe('none');
    expect(typography.features).toContain('"calt" 0');
    expect(typography.features).toContain('"liga" 0');
  });
});
