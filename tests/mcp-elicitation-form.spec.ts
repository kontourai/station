import { expect } from '@playwright/test';
import { monitorBrowserHealth } from './helpers/browser-health';
import { contrastRatio } from './helpers/color-contrast';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  openChatRegion,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * #3284, in a real browser: a tool server's form elicitation renders on the
 * pending-requests strip, keeps visible keyboard focus, legible text and
 * touch-size targets at desktop and 390px in both themes, and sends the
 * typed content through the real `respondToRequest` client call.
 *
 * The form is the payload Station's relay publishes (`inputRequest`, the
 * normalized fixture-server request); the event window is a fixture.
 */
const FORM = {
  message: 'Who should the report be addressed to?',
  fields: [
    {
      name: 'name',
      title: 'Name',
      required: true,
      kind: 'string',
      minLength: 1,
      maxLength: 40,
    },
    {
      name: 'email',
      title: 'Email',
      description: 'Where the report is sent.',
      required: false,
      kind: 'string',
      format: 'email',
    },
    {
      name: 'age',
      title: 'Age',
      required: false,
      kind: 'integer',
      minimum: 0,
      maximum: 150,
    },
    { name: 'subscribe', title: 'Subscribe', required: false, kind: 'boolean' },
    {
      name: 'color',
      title: 'Color',
      required: false,
      kind: 'choice',
      options: [
        { value: 'red', label: 'Red' },
        { value: 'blue', label: 'Blue' },
      ],
    },
  ],
};

test.describe('MCP elicitation form (#3284)', () => {
  test('renders, stays legible and focusable at desktop and 390px, and sends typed content', async ({
    page,
  }, testInfo) => {
    const browserHealth = await monitorBrowserHealth(page);
    await seedActiveChats(page, [
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
    ]);
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await installMockOrchestrationEventWindow(page, 'codex', {
      'session-1': [
        {
          method: 'turn.started',
          provider: 'codex',
          threadId: 'session-1',
          turnId: 'turn-0',
          createdAt: '2026-04-05T11:59:58.000Z',
          prompt: 'Write the report',
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
          eventId: 'evt-elicit-1',
          requestId: 'elicitation-1',
          requestType: 'approval',
          title: 'fixture needs your input',
          description: FORM.message,
          payload: {
            inputRequest: {
              schema: 'station.input-request/v1',
              source: 'mcp:fixture',
              requester: 'fixture',
              message: FORM.message,
              body: { kind: 'form', fields: FORM.fields },
            },
          },
        },
      ],
    });
    await installMockOrchestrationConversationEventWindow(
      page,
      (conversationId) => (conversationId === 'conv-1' ? ['session-1'] : []),
    );
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
              eventCount: 3,
              createdAt: '2026-04-05T11:59:58.000Z',
              updatedAt: '2026-04-05T12:00:05.000Z',
            },
          ],
        }),
      }),
    );
    const posted: unknown[] = [];
    await page.route('**/api/orchestration/commands', async (route) => {
      posted.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { result: null, receipt: { status: 'accepted' } },
        }),
      });
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);
    await page.addStyleTag({
      content:
        '*, *::before, *::after { transition: none !important; animation: none !important; }',
    });
    const form = page.getByRole('form', { name: 'Answer fixture' });
    await expect(form).toBeVisible();
    await expect(form.getByText(FORM.message)).toBeVisible();
    const name = form.getByRole('textbox', { name: /Name/ });
    await expect(name).toBeVisible();

    // On a phone the actions sit in the request sheet's pinned footer, a
    // sibling of the form (#3331); on desktop they are inside it.
    const check = async (context: string, actions: typeof form = form) => {
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        for (const button of await actions.getByRole('button').all()) {
          const label = `${context} ${theme} ${await button.textContent()}`;
          expect(await contrastRatio(button), label).toBeGreaterThanOrEqual(
            4.5,
          );
          const box = await button.boundingBox();
          expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(
            MIN_TOUCH_TARGET_PX,
          );
        }
        for (const text of [
          form.getByText(FORM.message),
          form.getByText('Where the report is sent.'),
        ])
          expect(
            await contrastRatio(text),
            `${context} ${theme} text`,
          ).toBeGreaterThanOrEqual(4.5);
        await page.screenshot({
          path: testInfo.outputPath(`elicitation-${context}-${theme}.png`),
          fullPage: false,
        });
      }
      // Keyboard focus is visible on the first field.
      await name.focus();
      expect(
        await name.evaluate((node) => getComputedStyle(node).outlineStyle),
        `${context} focus outline`,
      ).not.toBe('none');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${context}: no horizontal overflow`,
      ).toBe(true);
    };

    await form.scrollIntoViewIfNeeded();
    await check('desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    // #3331: a phone shows the compact card; Answer opens the form in the
    // shared request sheet.
    await page
      .locator('.request-card')
      .getByRole('button', { name: 'Answer', exact: true })
      .click();
    const sheet = page.getByRole('dialog', {
      name: 'fixture needs your input',
    });
    await expect(name).toBeVisible();
    await check('mobile-390', sheet);

    const send = sheet.getByRole('button', { name: 'Send' });
    await send.click();
    // #3390: the refusal is marked on the field itself.
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByText('Name is required.')).toBeVisible();
    await expect(name).toBeFocused();
    expect(posted).toEqual([]);
    await name.fill('Ada');
    await form.getByRole('spinbutton', { name: /Age/ }).fill('36');
    await form.getByRole('radio', { name: 'Blue' }).check();
    await send.click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('.request-card').getByRole('status')).toHaveText(
      'Answered',
    );
    expect(posted).toEqual([
      {
        type: 'respondToRequest',
        threadId: 'session-1',
        requestId: 'elicitation-1',
        expectedRequestEventId: 'evt-elicit-1',
        decision: 'accept',
        content: { name: 'Ada', age: 36, color: 'blue' },
      },
    ]);
    browserHealth.assertHealthy();
  });
});

/**
 * #3284, in a real browser: an MCP prompt from the agent's tool view is
 * offered in the composer's slash menu as `/<server>:<prompt>` with an MCP
 * badge. The chat runs on Station's engine with an MCP server in its tool
 * view, which is what opens the menu's MCP gate.
 */
test.describe('MCP prompt in the slash menu (#3284)', () => {
  test('typing /fixture lists /fixture:summarize with an MCP badge at desktop and 390px', async ({
    page,
  }, testInfo) => {
    const browserHealth = await monitorBrowserHealth(page);
    await seedActiveChats(page, [
      {
        sessionId: 'session-1',
        conversationId: 'conv-1',
        agentSlug: 'dev-agent',
        agentConnectionId: 'station-runtime',
        orchestrationSessionStarted: true,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await installMockOrchestrationConversationEventWindow(
      page,
      (conversationId) => (conversationId === 'conv-1' ? ['session-1'] : []),
    );
    // Registered after the shared routes, so these answers win.
    await page.route('**/api/agents', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              slug: 'dev-agent',
              name: 'Dev Agent',
              description: 'Test agent',
              updatedAt: '2026-01-01T00:00:00Z',
              execution: { agentConnectionId: 'station-runtime' },
              toolsConfig: { mcpServers: ['fixture'], autoApprove: [] },
            },
          ],
        },
      }),
    );
    await page.route('**/api/connections/agents', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            agentConnectionFixture({
              id: 'station-runtime',
              type: 'station',
              name: 'Station',
              config: { engineId: 'station' },
            }),
          ],
        },
      }),
    );
    const promptListings: string[] = [];
    await page.route('**/agents/dev-agent/mcp-prompts', (route) => {
      if (route.request().method() !== 'GET')
        return rejectUnexpectedFixtureRequest(route);
      promptListings.push(route.request().url());
      return route.fulfill({
        json: {
          success: true,
          data: {
            prompts: [
              {
                command: 'fixture:summarize',
                serverId: 'fixture',
                name: 'summarize',
                description: 'Summarize a topic in a chosen tone.',
                arguments: [
                  { name: 'topic', required: true },
                  { name: 'tone', required: false },
                ],
              },
            ],
            unavailable: [],
          },
        },
      });
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);
    await page.addStyleTag({
      content:
        '*, *::before, *::after { transition: none !important; animation: none !important; }',
    });
    const composer = page.locator('textarea[placeholder*="Type a message"]');
    await expect(composer).toBeVisible();
    const menu = page.getByRole('listbox', { name: 'Suggestions' });
    const row = menu.getByRole('option', { name: /\/fixture:summarize/ });

    const check = async (context: string) => {
      await composer.fill('');
      await composer.pressSequentially('/fixture');
      await expect(row).toBeVisible();
      await expect(row.getByText('/fixture:summarize')).toBeVisible();
      await expect(row.getByText('MCP', { exact: true })).toBeVisible();
      await expect(
        row.getByText('Summarize a topic in a chosen tone. · <topic> [tone]'),
      ).toBeVisible();
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        await expect(row).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`slash-menu-${context}-${theme}.png`),
          fullPage: false,
        });
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${context}: no horizontal overflow`,
      ).toBe(true);
    };

    await check('desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await check('mobile-390');
    expect(promptListings.length).toBeGreaterThan(0);
    browserHealth.assertHealthy();
  });
});
