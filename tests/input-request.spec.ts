import { inputRequestFromMcpElicitation } from '@kontourai/station-shared/mcp-elicitation';
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import legacy from '../packages/shared/src/__tests__/fixtures/legacy-harness-question-events.json' with {
  type: 'json',
};
import {
  claudeInputRequest,
  codexInputRequest,
} from '../src-server/providers/adapters/harness-questions';
import { monitorBrowserHealth } from './helpers/browser-health';
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
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * #3390, in a real browser at 1280 and 390x844: every input request renders
 * through the one `station.input-request/v1` renderer — Claude's and Codex's
 * questions and a tool server's form inline on desktop and in the request
 * sheet on a phone, an approval's decision options, and a transcript record
 * for every request that keeps its outcome after it resolves (#3331 R1/R7).
 *
 * Fixture payloads are built by the real writers: the Claude and Codex
 * harness adapters, the MCP edge adapter, and — for the legacy case — the
 * pre-#3390 adapters' captured stored events.
 */

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const VIEWPORTS = [
  ['desktop-1280', DESKTOP],
  ['phone-390', PHONE],
] as const;

const claudeInput = {
  questions: [
    {
      question: 'Where should we deploy?',
      header: 'Target',
      multiSelect: false,
      options: [
        { label: 'Staging', description: 'Try it first' },
        { label: 'Production', description: 'Release now' },
      ],
    },
    {
      question: 'Which checks should run first?',
      header: 'Checks',
      multiSelect: true,
      options: [
        { label: 'Unit', description: 'Fast' },
        { label: 'Browser', description: 'Slow' },
        { label: 'Lint', description: 'Style' },
      ],
    },
  ],
};
const codexParams = {
  threadId: 'codex-thread',
  turnId: 'turn-1',
  itemId: 'questions-1',
  isBlocking: true,
  autoResolutionMs: null,
  questions: [
    {
      id: 'region',
      header: 'Region',
      question: 'Which region?',
      isOther: false,
      isSecret: false,
      options: [
        { label: 'us-east', description: 'Virginia' },
        { label: 'eu-west', description: 'Ireland' },
      ],
    },
    {
      id: 'token',
      header: 'Token',
      question: 'Paste the deploy token',
      isOther: false,
      isSecret: true,
      options: null,
    },
  ],
};
const mcpForm = inputRequestFromMcpElicitation('fixture', {
  mode: 'form',
  message: 'Confirm the report settings.',
  requestedSchema: {
    type: 'object',
    properties: {
      recipient: { type: 'string', title: 'Recipient', default: 'Ada' },
      copies: { type: 'integer', title: 'Copies', default: 2 },
      format: {
        type: 'string',
        title: 'Format',
        oneOf: [
          { const: 'pdf', title: 'PDF' },
          { const: 'html', title: 'HTML' },
        ],
        default: 'html',
      },
    },
    required: ['recipient'],
  },
});
if (!mcpForm) throw new Error('fixture MCP form did not map');
const claudeForm = claudeInputRequest(claudeInput);
const codexForm = codexInputRequest(codexParams);
if (!claudeForm || !codexForm) throw new Error('fixture harness forms');

const TURN = [
  {
    method: 'turn.started',
    provider: 'codex',
    threadId: 'session-1',
    turnId: 'turn-0',
    createdAt: '2026-10-05T11:59:58.000Z',
    prompt: 'Prepare the release',
  },
  {
    method: 'turn.completed',
    provider: 'codex',
    threadId: 'session-1',
    turnId: 'turn-0',
    createdAt: '2026-10-05T11:59:59.000Z',
    outputText: 'Ready.',
  },
];

function opened(
  requestId: string,
  title: string,
  payload: Record<string, unknown>,
  provider = 'codex',
) {
  return {
    method: 'request.opened',
    provider,
    threadId: 'session-1',
    createdAt: '2026-10-05T12:00:05.000Z',
    eventId: `evt-${requestId}`,
    requestId,
    requestType: 'approval',
    title,
    payload,
  };
}

const FORM_EVENTS = [
  ...TURN,
  // The Claude adapter's own payload shape for AskUserQuestion.
  opened(
    'claude-q',
    claudeForm.message,
    {
      inputRequest: claudeForm,
      toolName: 'AskUserQuestion',
      toolCallId: 'toolu-question',
      toolInput: claudeInput,
    },
    'claude',
  ),
  // The Codex adapter's: the engine params plus the form.
  opened('codex-q', codexForm.message, {
    ...codexParams,
    inputRequest: codexForm,
  }),
  // The Station agent's relay of a tool server's elicitation.
  opened('mcp-q', 'fixture needs your input', { inputRequest: mcpForm }),
];

async function openChatWith(
  page: Page,
  events: Record<string, unknown>[],
  viewport: { width: number; height: number },
) {
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
    'session-1': events,
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
            eventCount: events.length,
            createdAt: '2026-10-05T11:59:58.000Z',
            updatedAt: '2026-10-05T12:00:05.000Z',
          },
        ],
      }),
    }),
  );
  const posted: Record<string, unknown>[] = [];
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
  await page.setViewportSize(DESKTOP);
  await page.goto('/projects/dev/layouts/code?chat=conv-1');
  await dismissSetupLauncher(page);
  await openChatRegion(page);
  await waitForMockOrchestrationSse(page);
  await page.addStyleTag({
    content:
      '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  if (viewport.width < DESKTOP.width) {
    await page.setViewportSize(viewport);
    await expect(page.locator('#chat-dock')).toBeVisible();
  }
  return posted;
}

const answers = (posted: Record<string, unknown>[]) =>
  posted.filter((command) => command.type === 'respondToRequest');

/** A screenshot in this test's output folder, for review. */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

/**
 * The form for one request: inline on desktop; on a phone, its card's
 * Answer opens it in the request sheet. Returns where the fields are and
 * where its Send/Decline actions are.
 */
async function openForm(
  page: Page,
  requester: string,
  phone: boolean,
): Promise<{ form: Locator; actions: Locator }> {
  const form = page.getByRole('form', { name: `Answer ${requester}` });
  if (!phone) {
    await form.scrollIntoViewIfNeeded();
    return { form, actions: form };
  }
  const card = page.getByRole('region', {
    name: `${requester} needs your input`,
  });
  await card.getByRole('button', { name: 'Answer', exact: true }).click();
  const sheet = page.getByRole('dialog', {
    name: `${requester} needs your input`,
  });
  await expect(sheet).toBeVisible();
  return { form, actions: sheet };
}

for (const [label, viewport] of VIEWPORTS) {
  const phone = viewport.width < DESKTOP.width;

  test.describe(`input requests at ${label} (#3390)`, () => {
    test('single, multi and custom answers; a required error marks and focuses its field', async ({
      page,
    }, testInfo) => {
      const health = await monitorBrowserHealth(page);
      const posted = await openChatWith(page, FORM_EVENTS, viewport);
      const { form, actions } = await openForm(page, 'Claude', phone);
      await expect(form.getByText('Where should we deploy?')).toBeVisible();

      // Required-field error: nothing chosen, Send refused on the fields.
      await actions.getByRole('button', { name: 'Send' }).click();
      const target = form.getByRole('group', {
        name: /Where should we deploy\?/,
      });
      const checks = form.getByRole('group', {
        name: /Which checks should run first\?/,
      });
      await expect(target).toHaveAttribute('aria-invalid', 'true');
      await expect(checks).toHaveAttribute('aria-invalid', 'true');
      // Claude's question headers are kept and drawn with their questions.
      await expect(
        target.locator('.input-request-card__field-header'),
      ).toHaveText('Target');
      await expect(
        checks.locator('.input-request-card__field-header'),
      ).toHaveText('Checks');
      await expect(
        target.getByText('Where should we deploy? is required.'),
      ).toBeVisible();
      await expect(form.getByRole('radio', { name: /Staging/ })).toBeFocused();
      expect(answers(posted)).toEqual([]);
      await shot(page, testInfo, `${label}-required-error`);

      // Single choice with a custom answer, and a multi choice.
      await target.getByRole('radio', { name: /Other/ }).check();
      await form
        .getByRole('textbox', {
          name: 'Your answer to Where should we deploy?',
        })
        .fill('A canary host');
      await checks.getByRole('checkbox', { name: /Unit/ }).check();
      await checks.getByRole('checkbox', { name: /Browser/ }).check();
      await expect(target).not.toHaveAttribute('aria-invalid', 'true');
      for (const button of await actions.getByRole('button').all()) {
        const box = await button.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }
      await shot(page, testInfo, `${label}-single-multi-custom`);
      await actions.getByRole('button', { name: 'Send' }).click();
      await expect
        .poll(() => answers(posted))
        .toEqual([
          {
            type: 'respondToRequest',
            threadId: 'session-1',
            requestId: 'claude-q',
            expectedRequestEventId: 'evt-claude-q',
            decision: 'accept',
            content: {
              '0': { custom: 'A canary host' },
              '1': ['0', '1'],
            },
          },
        ]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      health.assertHealthy();
    });

    test('a secret answer is masked, and `default`s arrive pre-selected', async ({
      page,
    }, testInfo) => {
      const health = await monitorBrowserHealth(page);
      const posted = await openChatWith(page, FORM_EVENTS, viewport);

      const codex = await openForm(page, 'Codex', phone);
      const token = codex.form.getByLabel(/Paste the deploy token/);
      await expect(token).toHaveAttribute('type', 'password');
      await codex.form.getByRole('radio', { name: /eu-west/ }).check();
      await token.fill('canary-private-answer');
      await shot(page, testInfo, `${label}-secret`);
      await codex.actions.getByRole('button', { name: 'Send' }).click();
      await expect.poll(() => answers(posted).length).toBe(1);
      if (phone) await expect(codex.actions).toBeHidden();

      const mcp = await openForm(page, 'fixture', phone);
      await expect(
        mcp.form.getByRole('textbox', { name: /Recipient/ }),
      ).toHaveValue('Ada');
      await expect(
        mcp.form.getByRole('spinbutton', { name: /Copies/ }),
      ).toHaveValue('2');
      await expect(mcp.form.getByRole('radio', { name: 'HTML' })).toBeChecked();
      // A tool server's form has no headers: no empty header slot either.
      await expect(
        mcp.form.locator('.input-request-card__field-header'),
      ).toHaveCount(0);
      await shot(page, testInfo, `${label}-defaults`);
      await mcp.actions.getByRole('button', { name: 'Send' }).click();
      await expect
        .poll(() => answers(posted).map((command) => command.content))
        .toEqual([
          { region: '1', token: 'canary-private-answer' },
          { recipient: 'Ada', copies: 2, format: 'html' },
        ]);
      // The secret never reaches the transcript record or the page text.
      await expect(page.getByText('canary-private-answer')).toHaveCount(0);
      health.assertHealthy();
    });

    test('an approval renders its decision options and answers with the decision', async ({
      page,
    }, testInfo) => {
      const health = await monitorBrowserHealth(page);
      // Codex reports no call identity, so no transcript row binds it: the
      // pending strip answers it, and the transcript records it.
      const posted = await openChatWith(
        page,
        [
          ...TURN,
          opened('approval-1', 'git push origin main', {
            toolName: 'shell',
            command: 'git push origin main',
          }),
        ],
        viewport,
      );
      const strip = page.getByRole('region', {
        name: 'Approvals waiting on you',
      });
      const record = page.locator(
        '.input-request-record[data-request-id="approval-1"]',
      );
      await expect(record).toContainText('needed approval');
      await expect(record).toContainText('Waiting for you');
      let decisions: Locator = strip;
      if (phone) {
        await strip
          .getByRole('button', { name: 'Answer', exact: true })
          .click();
        decisions = page.getByRole('dialog', { name: 'Approval needed' });
        await expect(decisions).toBeVisible();
        await expect(
          decisions.getByRole('button', { name: 'Deny' }),
        ).toBeVisible();
      } else {
        await expect(strip.getByRole('button', { name: 'Deny' })).toBeVisible();
      }
      await expect(
        decisions.getByRole('button', { name: 'Allow Once' }),
      ).toBeVisible();
      await shot(page, testInfo, `${label}-approval-decision`);
      await decisions.getByRole('button', { name: 'Allow Once' }).click();
      await expect
        .poll(() => answers(posted))
        .toEqual([
          {
            type: 'respondToRequest',
            threadId: 'session-1',
            requestId: 'approval-1',
            expectedRequestEventId: 'evt-approval-1',
            decision: 'accept',
          },
        ]);
      health.assertHealthy();
    });

    test('history: resolved requests keep their outcome, including one answered on another device', async ({
      page,
    }, testInfo) => {
      const health = await monitorBrowserHealth(page);
      const events = [
        ...TURN,
        opened('done-form', 'fixture needs your input', {
          inputRequest: mcpForm,
        }),
        {
          method: 'request.resolved',
          provider: 'codex',
          threadId: 'session-1',
          createdAt: '2026-10-05T12:00:06.000Z',
          requestId: 'done-form',
          status: 'denied',
        },
        opened('done-approval', 'rm -rf build', { command: 'rm -rf build' }),
        {
          method: 'request.resolved',
          provider: 'codex',
          threadId: 'session-1',
          createdAt: '2026-10-05T12:00:07.000Z',
          requestId: 'done-approval',
          status: 'approved',
        },
        opened('live-form', 'fixture needs your input', {
          inputRequest: mcpForm,
        }),
      ];
      const posted = await openChatWith(page, events, viewport);
      const record = (id: string) =>
        page.locator(`.input-request-record[data-request-id="${id}"]`);
      await expect(record('done-form')).toContainText('Declined');
      await expect(record('done-approval')).toContainText('Allowed');
      await expect(record('live-form')).toContainText('Waiting for you');
      // The one still waiting has its answer card (a phone's compact card).
      const pendingCard = phone
        ? page.getByRole('region', { name: 'fixture needs your input' })
        : page.getByRole('form', { name: 'Answer fixture' });
      await expect(pendingCard).toHaveCount(1);
      // Answered on another device: only the resolution reaches this page.
      await emitMockOrchestrationEvent(
        page,
        'orchestration:event',
        {
          event: {
            method: 'request.resolved',
            provider: 'codex',
            threadId: 'session-1',
            createdAt: '2026-10-05T12:00:09.000Z',
            requestId: 'live-form',
            status: 'approved',
          },
        },
        { sequence: events.length + 1 },
      );
      await expect(record('live-form')).toContainText('Answered');
      await expect(pendingCard).toHaveCount(0);
      await record('live-form').scrollIntoViewIfNeeded();
      await shot(page, testInfo, `${label}-history`);
      expect(answers(posted)).toEqual([]);
      health.assertHealthy();
    });

    test('a harness question stored before #3390 still renders and answers', async ({
      page,
    }, testInfo) => {
      const health = await monitorBrowserHealth(page);
      // The pre-#3390 Claude adapter's stored event, verbatim.
      const stored = {
        ...(legacy.claude as Record<string, unknown>),
        threadId: 'session-1',
      };
      const posted = await openChatWith(page, [...TURN, stored], viewport);
      const { form, actions } = await openForm(page, 'Claude', phone);
      await expect(
        form.getByRole('group', { name: /Which checks should run first\?/ }),
      ).toBeVisible();
      await form.getByRole('radio', { name: /Production/ }).check();
      await form.getByRole('checkbox', { name: /Lint/ }).check();
      await shot(page, testInfo, `${label}-legacy-question`);
      await actions.getByRole('button', { name: 'Send' }).click();
      await expect
        .poll(() => answers(posted))
        .toEqual([
          {
            type: 'respondToRequest',
            threadId: 'session-1',
            requestId: (legacy.claude as { requestId: string }).requestId,
            expectedRequestEventId: (legacy.claude as { eventId: string })
              .eventId,
            decision: 'accept',
            content: { '0': '1', '1': ['2'] },
          },
        ]);
      health.assertHealthy();
    });
  });
}
