import { expect, type Page, type TestInfo } from '@playwright/test';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import { test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  installMockOrchestrationSse,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';
import { mockRuntimeConversation } from './helpers/runtime-conversation-fixture';

/*
 * One capability contract across new chat, reply, steer and queue: a start
 * composer attaches and dictates like the chat composer, its files reach the
 * new chat's first send through the same staging, and a running turn keeps
 * attach usable while saying why files cannot steer or queue. The runtime is
 * mocked at HTTP: the foreground send is acknowledged and its turn never
 * completes, so the chat stays mid-turn (the pending-message-queue harness).
 */

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
    // Long on purpose: the composer's Agent chip must end it in an ellipsis
    // inside the chip on a phone, not run it under the caret.
    name: 'Claude Runtime for the workspace review lane',
    description: 'Direct chat using Claude Runtime.',
    source: 'local',
    execution: {
      agentConnectionId: 'claude',
      modelId: 'claude-sonnet-4-20250514',
    },
  },
];

// A 1x1 PNG: real image bytes, so the composer's own intake reads it.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const NOTES = {
  name: 'notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('build log excerpt\n'),
};
const SHOT = { name: 'shot.png', mimeType: 'image/png', buffer: PNG_1X1 };

function json(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function seedRoutes(
  page: Page,
  executionRequests: Array<Record<string, unknown>>,
) {
  const prepared = new Map<string, Record<string, unknown>>();
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
        json({ voice: { stt: [], tts: [] }, context: { providers: [] } }),
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
              // Declares document input; the Claude engine's own matrix
              // refuses images, which the refusal case below relies on.
              capabilities: ['agent-runtime', 'file-input'],
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
    page.route('**/api/orchestration/sessions/read-model', (route) =>
      route.fulfill(
        json({
          success: true,
          data: executionRequests.map((request) => ({
            threadId: request.conversationId,
            conversationId: request.conversationId,
            provider: 'claude',
            model: 'claude-sonnet-4-20250514',
            assignedAgentSlug: 'claude',
            status: 'running',
            lifecycleState: 'running',
            createdAt: '2026-04-12T00:00:00Z',
            updatedAt: '2026-04-12T00:00:00Z',
            isLoaded: true,
            isPersisted: true,
            eventCount: 1,
          })),
        }),
      ),
    ),
    page.route('**/api/orchestration/chat', async (route) => {
      const request = route.request().postDataJSON() as Record<string, unknown>;
      executionRequests.push(request);
      const conversationId = String(request.conversationId ?? '');
      const turnId = `provider-turn-${executionRequests.length}`;
      await mockRuntimeConversation(page, {
        id: conversationId,
        agentSlug: 'claude',
        title: 'Composer capability task',
        provider: 'claude',
        model: 'claude-sonnet-4-20250514',
        canContinue: true,
        turns: () => [
          [
            {
              eventId: `${turnId}-started`,
              method: 'turn.started',
              provider: 'claude',
              threadId: conversationId,
              turnId,
              createdAt: '2026-04-12T00:00:00Z',
              prompt: request.message,
            },
          ],
        ],
      });
      await route.fulfill(
        json(
          foregroundMessageReceiptEnvelope({
            conversationId,
            providerTurnId: turnId,
            agent: 'claude',
          }),
        ),
      );
    }),
    // Upload staging, in the shapes the staging client reads (the same
    // fixture as sidebar-file-intake.spec.ts).
    page.route('**/api/orchestration/attachment-staging/capability', (route) =>
      route.fulfill(
        json({ state: 'supported', version: 1, maxConcurrentUploads: 3 }),
      ),
    ),
    page.route('**/api/orchestration/attachment-staging/prepare', (route) => {
      const descriptor = route.request().postDataJSON();
      const stageId = `stage-${prepared.size}`;
      const entry = {
        ...descriptor,
        stageId,
        uploadGrant: 'fixture-upload-grant',
        expiresAt: '2030-01-01T00:00:00Z',
      };
      prepared.set(stageId, entry);
      return route.fulfill(json(entry));
    }),
    page.route(
      /\/api\/orchestration\/attachment-staging\/stage-\d+$/,
      (route) => {
        const entry = prepared.get(
          new URL(route.request().url()).pathname.split('/').at(-1)!,
        );
        if (!entry) throw new Error('Unknown staged file');
        const { uploadGrant: _, ...descriptor } = entry;
        return route.fulfill(
          json({
            ...descriptor,
            source: 'current-composer',
            digest: `sha256-${'a'.repeat(64)}`,
          }),
        );
      },
    ),
    page.route('**/api/orchestration/attachment-staging/reconcile', (route) => {
      const { stageIds } = route.request().postDataJSON();
      return route.fulfill(
        json(
          stageIds.map((id: string) => {
            const entry = prepared.get(id);
            if (!entry) throw Error('Unknown stage');
            const { uploadGrant: _, ...descriptor } = entry;
            return {
              stageId: id,
              state: 'complete',
              reference: {
                ...descriptor,
                source: 'current-composer',
                digest: `sha256-${'a'.repeat(64)}`,
              },
            };
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
  return prepared;
}

/**
 * The dock's New chat, on a desktop. Maximized: in a dock too short for the
 * composer's rows, an attachment chip already squeezes the draft under the
 * controls row (an existing reservation limit this spec does not cover).
 */
async function openDockStartComposer(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('lastProject', 'default');
    localStorage.removeItem('recentAgents');
  });
  await page.goto('/?dock=open&maximize=true');
  await dismissSetupLauncher(page);
  const add = page.locator('.chat-dock__tab-actions .chat-dock__new').last();
  await expect(add).toBeVisible({ timeout: 15_000 });
  await add.click();
  const modal = page.getByRole('dialog', { name: 'New chat', exact: true });
  await expect(modal).toBeVisible({ timeout: 10_000 });
  const composer = modal.getByRole('form', { name: 'Start work' });
  await composer.getByRole('button', { name: /^Agent:/ }).click();
  const agents = page.getByRole('dialog', { name: 'Choose agent' });
  const runtimeRow = agents.locator('[data-agent-slug="claude"]').first();
  await expect(runtimeRow).toBeVisible({ timeout: 10_000 });
  await runtimeRow.click();
  return { composer, started: () => expect(modal).toBeHidden() };
}

/** Home's start composer, which hands its start to the dock (a phone). */
async function openHomeStartComposer(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('lastProject', 'default');
    localStorage.removeItem('recentAgents');
  });
  await page.goto('/');
  await dismissSetupLauncher(page);
  const composer = page.getByRole('form', { name: 'Start work' });
  await expect(
    composer.getByRole('button', { name: /^Agent: Claude Runtime/ }),
  ).toBeVisible({ timeout: 15_000 });
  return {
    composer,
    started: () =>
      expect(
        page.getByRole('group', { name: 'Message composer', exact: true }),
      ).toBeVisible(),
  };
}

const openStartComposer = (page: Page, label: 'desktop' | 'phone') =>
  label === 'desktop'
    ? openDockStartComposer(page)
    : openHomeStartComposer(page);

/** Attach through the control a person uses: the paperclip and its picker. */
async function attachThroughPicker(
  page: Page,
  button: import('@playwright/test').Locator,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const chooser = page.waitForEvent('filechooser');
  await button.click();
  await (await chooser).setFiles(file);
}

async function evidence(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name) });
}

for (const [label, viewport] of [
  ['desktop', { width: 1280, height: 860 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`${label}: a file attached at Start reaches the new chat's first send`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const executionRequests: Array<Record<string, unknown>> = [];
    await installMockOrchestrationSse(page);
    const prepared = await seedRoutes(page, executionRequests);
    const { composer, started } = await openStartComposer(page, label);

    await composer
      .getByRole('textbox', { name: 'What would you like done?' })
      .fill('read these notes');
    await attachThroughPicker(
      page,
      composer.getByRole('button', { name: 'Attach files' }),
      NOTES,
    );
    const files = composer.getByRole('list', { name: 'Files for this chat' });
    await expect(files.getByRole('listitem')).toHaveText(['notes.txt']);
    await expect(
      composer.getByRole('button', { name: 'Remove notes.txt' }),
    ).toBeVisible();
    await evidence(page, testInfo, `start-composer-file-${label}.png`);

    await composer.getByRole('button', { name: 'Start', exact: true }).click();
    await started();
    await waitForMockOrchestrationSse(page);
    await expect
      .poll(() => executionRequests.length, { timeout: 15_000 })
      .toBe(1);
    expect(executionRequests[0]).toMatchObject({ message: 'read these notes' });
    // The file went through the new chat's own staging and rode the send.
    expect(prepared.size).toBe(1);
    expect(JSON.stringify(executionRequests[0])).toContain('stage-0');
    await evidence(page, testInfo, `start-composer-sent-${label}.png`);
  });

  test(`${label}: a running turn keeps attach usable and says why files wait`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const executionRequests: Array<Record<string, unknown>> = [];
    await installMockOrchestrationSse(page);
    await seedRoutes(page, executionRequests);
    const { composer, started } = await openStartComposer(page, label);
    await composer
      .getByRole('textbox', { name: 'What would you like done?' })
      .fill('start the task');
    await composer.getByRole('button', { name: 'Start', exact: true }).click();
    await started();
    await waitForMockOrchestrationSse(page);
    await expect
      .poll(() => executionRequests.length, { timeout: 15_000 })
      .toBe(1);

    const messageComposer = page.getByRole('group', {
      name: 'Message composer',
      exact: true,
    });
    const textarea = messageComposer.getByRole('textbox');
    await expect(textarea).toHaveAttribute('placeholder', /follow-up|Steer/);
    const stop = page.getByRole('button', { name: 'Stop the current turn' });
    await expect(stop).toBeVisible();
    await evidence(page, testInfo, `running-turn-empty-${label}.png`);

    // The Agent chip's name ends before its caret, in an ellipsis.
    const agentChip = page.locator('.chat-input__agent-btn');
    const [nameBox, caretBox, nameClipped] = await Promise.all([
      agentChip.locator('.chat-input__agent-name').boundingBox(),
      agentChip.locator('.choice-caret').boundingBox(),
      agentChip
        .locator('.chat-input__agent-name')
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ]);
    expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(caretBox!.x);
    if (label === 'phone')
      expect(nameClipped, 'clipped, not wrapped').toBe(true);

    // Stop sits at the end of the controls row, before and after a draft
    // reveals Send: nothing to its right, and it does not move.
    const row = page.locator('.chat-controls-row');
    const stopBefore = await stop.boundingBox();
    const rowBox = await row.boundingBox();
    expect(stopBefore && rowBox).toBeTruthy();
    const rowPaddingEnd = await row.evaluate(
      (element) =>
        Number.parseFloat(getComputedStyle(element).paddingInlineEnd) || 0,
    );
    if (label === 'phone') {
      expect(
        rowBox!.x +
          rowBox!.width -
          rowPaddingEnd -
          (stopBefore!.x + stopBefore!.width),
        'Stop ends at the row edge, not beside a hidden Send/Queue gap',
      ).toBeLessThanOrEqual(1);
    }
    await textarea.fill('a follow-up');
    await expect(
      page.getByRole('button', { name: 'Send', exact: true }),
    ).toBeVisible();
    const stopAfter = await stop.boundingBox();
    expect(stopAfter!.x).toBeCloseTo(stopBefore!.x, 0);
    await expect(
      page.getByRole('button', { name: 'Send mode: Queue' }),
    ).toBeVisible();
    await evidence(page, testInfo, `running-turn-queue-${label}.png`);
    await page.getByRole('button', { name: 'Send mode: Queue' }).click();
    await page
      .getByRole('button', { name: /Steer (this turn|when safe)/ })
      .click();
    await expect(
      page.getByRole('button', { name: 'Send mode: Steer' }),
    ).toBeVisible();
    await evidence(page, testInfo, `running-turn-steer-${label}.png`);
    // Horizontally: at 390px a running turn's full row (Clear, Send, Queue,
    // Stop) wraps onto a second line, which is a separate, existing limit.
    await textarea.fill('');

    // Attach is not disabled by the running turn; a file joins the draft and
    // the composer says why it waits, with the way out beside it.
    const attach = page
      .locator('.chat-controls-row')
      .getByRole('button', { name: 'Attach files' });
    await expect(attach).toBeEnabled();
    await attachThroughPicker(page, attach, NOTES);
    const reason = messageComposer.getByText(
      'Files can’t be added to a running turn',
      { exact: false },
    );
    await expect(reason).toBeVisible();
    await textarea.fill('with a file');
    await expect(
      page.getByRole('button', { name: 'Send', exact: true }),
    ).toBeDisabled();
    await textarea.press('Enter');
    await evidence(page, testInfo, `running-turn-file-${label}.png`);
    expect(executionRequests).toHaveLength(1);
    await messageComposer
      .getByRole('button', { name: 'Remove attachments' })
      .click();
    await expect(reason).toBeHidden();
  });
}

test("a pasted image the new chat's engine cannot see keeps the message for the person", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const executionRequests: Array<Record<string, unknown>> = [];
  await installMockOrchestrationSse(page);
  const prepared = await seedRoutes(page, executionRequests);
  const { composer, started } = await openDockStartComposer(page);
  await composer
    .getByRole('textbox', { name: 'What would you like done?' })
    .fill('look at this screenshot');
  // Clipboard payload seam: proves intake once a browser delivers file data,
  // not Android keyboard/IME delivery into a native WebView.
  await composer.getByRole('textbox').evaluate(
    (field, bytes) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' }),
      );
      field.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, clipboardData }),
      );
    },
    [...SHOT.buffer],
  );
  await expect(
    composer.getByRole('list', { name: 'Files for this chat' }),
  ).toContainText('shot.png');
  await composer.getByRole('button', { name: 'Start', exact: true }).click();
  await started();
  const messageComposer = page.getByRole('group', {
    name: 'Message composer',
    exact: true,
  });
  // The chat's own intake answers for its engine, and the first send waits
  // for the person instead of going out without the file.
  await expect(messageComposer.getByText('cannot see images')).toBeVisible();
  await expect(messageComposer.getByRole('textbox')).toHaveValue(
    'look at this screenshot',
  );
  await evidence(page, testInfo, 'start-composer-image-refused-desktop.png');
  expect(prepared.size).toBe(0);
  expect(executionRequests).toHaveLength(0);
});

test.describe('on a touch phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('the start composer field shows one focus ring and no resize grip', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const executionRequests: Array<Record<string, unknown>> = [];
    await installMockOrchestrationSse(page);
    await seedRoutes(page, executionRequests);
    const { composer } = await openHomeStartComposer(page);
    const field = composer.getByRole('textbox', {
      name: 'What would you like done?',
    });
    await field.tap();
    await field.fill('Fix the flaky upload test');
    const style = await field.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        focused: document.activeElement === element,
        outline: computed.outlineStyle,
        resize: computed.resize,
      };
    });
    // The box's own focus border is the ring; the field draws none inside it.
    expect(style).toEqual({ focused: true, outline: 'none', resize: 'none' });
    await evidence(page, testInfo, 'touch-start-composer-focus-phone.png');
  });
});
