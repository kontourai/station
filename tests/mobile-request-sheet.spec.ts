import { expect, type Locator, type Page } from '@playwright/test';
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
 * #3331, in a real browser at 390x844: every request that needs the person —
 * a tool server's form (#3284) and a tool approval — is a compact card in the
 * transcript plus ONE shared bottom sheet. The sheet's backdrop, swipe,
 * Escape and close control only hide it; the request stays pending until an
 * explicit action answers it. Desktop keeps the inline card.
 *
 * The event windows are fixtures shaped like the relay's `request.opened`
 * (mcpElicitation payload) and the projection's bound tool approval;
 * `respondToRequest` is captured at the real orchestration commands route.
 */

const PHONE = { width: 390, height: 844 };
const KEYBOARD_PX = 336;

const LONG_FORM = {
  serverId: 'fixture',
  message:
    'Who should the quarterly report be addressed to, and how should it be delivered?',
  fields: [
    { name: 'name', title: 'Name', required: true, kind: 'string' },
    {
      name: 'email',
      title: 'Email',
      description: 'Where the report is sent.',
      required: false,
      kind: 'string',
      format: 'email',
    },
    {
      name: 'team',
      title: 'Team',
      description: 'Shown in the report header.',
      required: false,
      kind: 'string',
    },
    {
      name: 'copies',
      title: 'Printed copies',
      required: false,
      kind: 'integer',
      minimum: 0,
      maximum: 20,
    },
    {
      name: 'site',
      title: 'Website',
      required: false,
      kind: 'string',
      format: 'uri',
    },
    { name: 'urgent', title: 'Urgent', required: false, kind: 'boolean' },
    {
      name: 'format',
      title: 'Format',
      required: false,
      kind: 'choice',
      options: [
        { value: 'pdf', label: 'PDF' },
        { value: 'html', label: 'HTML' },
        { value: 'docx', label: 'Word' },
      ],
    },
    {
      name: 'notes',
      title: 'Notes',
      description: 'Anything the recipient should know first.',
      required: false,
      kind: 'string',
    },
  ],
};

const ELICITATION_EVENTS = [
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
    description: LONG_FORM.message,
    payload: { mcpElicitation: LONG_FORM },
  },
];

/** A tool call the transcript renders, with its approval request bound to it. */
const APPROVAL_EVENTS = [
  {
    method: 'turn.started',
    provider: 'codex',
    threadId: 'session-1',
    turnId: 'turn-1',
    createdAt: '2026-04-05T12:00:00.000Z',
    prompt: 'Clean the build folder',
  },
  {
    method: 'tool.started',
    provider: 'codex',
    threadId: 'session-1',
    turnId: 'turn-1',
    itemId: 'tool-1',
    toolCallId: 'tool-1',
    toolName: 'shell_exec',
    createdAt: '2026-04-05T12:00:01.000Z',
    arguments: { command: 'rm -rf build', cwd: '/tmp/project' },
  },
  {
    method: 'request.opened',
    provider: 'codex',
    threadId: 'session-1',
    turnId: 'turn-1',
    createdAt: '2026-04-05T12:00:02.000Z',
    eventId: 'evt-approval-1',
    requestId: 'approval-1',
    requestType: 'approval',
    title: 'Approve shell_exec',
    payload: {
      toolName: 'shell_exec',
      toolCallId: 'tool-1',
      toolInput: { command: 'rm -rf build', cwd: '/tmp/project' },
    },
  },
];

/**
 * A software keyboard, emulated: Chromium cannot raise one, so this replaces
 * `window.visualViewport` with one whose height the test shrinks, exactly as
 * iOS Safari and Android Chrome report an open keyboard. Painting the
 * keyboard's area is for the screenshot only; it takes no pointer events.
 * Real iOS behaviour is a separate, device-only check.
 */
async function installKeyboardEmulation(page: Page) {
  await page.addInitScript(() => {
    const target = new EventTarget();
    let keyboard = 0;
    const viewport = new Proxy(target, {
      get(object, property) {
        switch (property) {
          case 'height':
            return window.innerHeight - keyboard;
          case 'width':
            return window.innerWidth;
          case 'offsetTop':
          case 'offsetLeft':
          case 'pageTop':
          case 'pageLeft':
            return 0;
          case 'scale':
            return 1;
          default: {
            const value = Reflect.get(object, property, object);
            return typeof value === 'function' ? value.bind(object) : value;
          }
        }
      },
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      get: () => viewport,
    });
    (window as any).__emulateKeyboard = (height: number) => {
      keyboard = height;
      document.getElementById('e2e-emulated-keyboard')?.remove();
      if (height > 0) {
        const pane = document.createElement('div');
        pane.id = 'e2e-emulated-keyboard';
        pane.textContent = 'Emulated keyboard';
        pane.setAttribute('aria-hidden', 'true');
        Object.assign(pane.style, {
          position: 'fixed',
          left: '0',
          right: '0',
          bottom: '0',
          height: `${height}px`,
          zIndex: '2147483647',
          pointerEvents: 'none',
          display: 'grid',
          placeItems: 'center',
          font: '14px system-ui',
          color: '#555',
          background: '#d1d3d9',
        });
        document.body.append(pane);
      }
      target.dispatchEvent(new Event('resize'));
    };
  });
}

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
            createdAt: '2026-04-05T11:59:58.000Z',
            updatedAt: '2026-04-05T12:00:05.000Z',
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
  // Opened wide, then narrowed: the established route into the phone dock
  // (orchestration-chat-flow, mcp-elicitation-form). A cold phone load's
  // region lookup is not what these tests are about.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/projects/dev/layouts/code?chat=conv-1');
  await dismissSetupLauncher(page);
  await openChatRegion(page);
  await waitForMockOrchestrationSse(page);
  if (viewport.width < 1280) {
    await page.setViewportSize(viewport);
    await expect(page.locator('#chat-dock')).toBeVisible();
  }
  return posted;
}

/** Answers: every command the page sent that answers a request. */
const answers = (posted: Record<string, unknown>[]) =>
  posted.filter((command) => command.type === 'respondToRequest');

/** The panel has finished its entrance, so geometry is final. */
async function settled(dialog: Locator) {
  await dialog.evaluate((panel) =>
    Promise.all(panel.getAnimations().map((animation) => animation.finished)),
  );
}

async function visibleViewportHeight(page: Page) {
  return page.evaluate(
    () => window.visualViewport?.height ?? window.innerHeight,
  );
}

/** Fully on screen, in the visible viewport, without scrolling anything. */
async function expectReachable(page: Page, control: Locator, label: string) {
  await expect(control, label).toBeVisible();
  const box = await control.boundingBox();
  const height = await visibleViewportHeight(page);
  expect(box, label).not.toBeNull();
  expect(box!.y, `${label} top`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${label} bottom`).toBeLessThanOrEqual(
    height + 0.5,
  );
  expect(box!.height, `${label} touch height`).toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET_PX,
  );
}

async function shot(
  page: Page,
  name: string,
  testInfo: { outputPath(...p: string[]): string },
) {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
    }, theme);
    // A theme switch transitions colours; capture the settled paint, not a
    // frame halfway between the two themes.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          // Transitions only: an infinite animation never finishes.
          .filter((animation) => animation instanceof CSSTransition)
          // A transition a later one replaces rejects; either way it is over.
          .map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
    await page.screenshot({
      path: testInfo.outputPath(`${name}-${theme}.png`),
      fullPage: false,
    });
  }
}

test.describe('Mobile request sheet (#3331)', () => {
  test('long elicitation form: card opens a near-full sheet with pinned actions, labelled dialog, trapped focus', async ({
    page,
  }, testInfo) => {
    const browserHealth = await monitorBrowserHealth(page);
    const posted = await openChatWith(page, ELICITATION_EVENTS, PHONE);

    // R1: the transcript keeps a compact card, not the form.
    const card = page.locator('.request-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('fixture needs your input');
    await expect(card).toContainText(LONG_FORM.message);
    await expect(card.getByRole('status')).toHaveText('Waiting for you');
    await expect(
      page.getByRole('form', { name: 'Answer fixture' }),
    ).toHaveCount(0);
    const answer = card.getByRole('button', { name: 'Answer', exact: true });
    await expect(answer).toBeVisible();
    await shot(page, 'mobile-elicitation-card', testInfo);

    await answer.click();
    const dialog = page.getByRole('dialog', {
      name: 'fixture needs your input',
    });
    await expect(dialog).toBeVisible();
    await settled(dialog);
    // R6: focus moved into the sheet.
    expect(
      await dialog.evaluate((panel) => panel.contains(document.activeElement)),
    ).toBe(true);

    // R3: Decline and Send are reachable without scrolling; Cancel is in
    // the overflow menu, not a third labelled button.
    const send = dialog.getByRole('button', { name: 'Send' });
    const decline = dialog.getByRole('button', { name: 'Decline' });
    await expectReachable(page, send, 'Send');
    await expectReachable(page, decline, 'Decline');
    await expect(
      dialog.getByRole('button', { name: 'Cancel without answering' }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'More answer options' }),
    ).toBeVisible();
    // R6: a drag handle and a visible close control.
    await expect(page.getByTestId('request-sheet-grab')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Close and answer later' }),
    ).toBeVisible();

    // R2: a long form opens near full height and its BODY scrolls.
    const panelBox = await dialog.boundingBox();
    expect(panelBox!.height).toBeGreaterThanOrEqual(PHONE.height * 0.85);
    const body = dialog.locator('.request-sheet__body');
    const overflow = await body.evaluate((node) => ({
      scrollable: node.scrollHeight > node.clientHeight,
      overflowY: getComputedStyle(node).overflowY,
    }));
    expect(overflow).toEqual({ scrollable: true, overflowY: 'auto' });
    const sendBefore = await send.boundingBox();
    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    // R3: pinned — scrolling the body to its end leaves Send where it was.
    expect(await send.boundingBox()).toEqual(sendBefore);
    await body.evaluate((node) => {
      node.scrollTop = 0;
    });

    // R5 / #2021: no editable control under 16px (iOS focus zoom).
    const sizes = await dialog
      .locator(
        'input:not([type="checkbox"]):not([type="radio"]), textarea, select',
      )
      .evaluateAll((controls) =>
        controls.map((control) =>
          Number.parseFloat(getComputedStyle(control).fontSize),
        ),
      );
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);

    // R6: Tab never leaves the dialog.
    for (let index = 0; index < 30; index += 1) {
      await page.keyboard.press('Tab');
      expect(
        await dialog.evaluate((panel) =>
          panel.contains(document.activeElement),
        ),
        `Tab ${index + 1} stays in the sheet`,
      ).toBe(true);
    }
    await shot(page, 'mobile-elicitation-sheet', testInfo);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(answers(posted)).toEqual([]);
    browserHealth.assertHealthy();
  });

  test('R4: backdrop, swipe, Escape and close only hide the elicitation sheet; the request stays pending and the card reopens it', async ({
    page,
  }) => {
    const posted = await openChatWith(page, ELICITATION_EVENTS, PHONE);
    const card = page.locator('.request-card');
    const answer = card.getByRole('button', { name: 'Answer', exact: true });
    const dialog = page.getByRole('dialog', {
      name: 'fixture needs your input',
    });
    const name = dialog.getByRole('textbox', { name: /Name/ });

    const open = async () => {
      await answer.click();
      await expect(dialog).toBeVisible();
      await settled(dialog);
    };
    const expectStillPending = async (how: string) => {
      await expect(dialog, `${how}: sheet hidden`).toBeHidden();
      // Every dismissal must leave the request open — a decline or cancel
      // here would have reached the commands route.
      expect(answers(posted), `${how}: nothing answered`).toEqual([]);
      await expect(card.getByRole('status'), how).toHaveText('Waiting for you');
      await expect(answer, `${how}: focus returns to the card`).toBeFocused();
    };

    await open();
    await name.fill('Ada');
    // The backdrop: the strip of overlay above the sheet.
    await page.mouse.click(PHONE.width / 2, 6);
    await expectStillPending('backdrop');

    await open();
    // The draft survives a dismissal.
    await expect(name).toHaveValue('Ada');
    const grab = page.getByTestId('request-sheet-grab');
    const box = (await grab.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1)
      await page.mouse.move(box.x + box.width / 2, box.y + 8 + step * 30);
    await page.mouse.up();
    await expectStillPending('swipe down');

    await open();
    await page.keyboard.press('Escape');
    await expectStillPending('Escape');

    await open();
    await dialog
      .getByRole('button', { name: 'Close and answer later' })
      .click();
    await expectStillPending('close control');

    // A short drag that does not pass the threshold snaps back, open.
    await open();
    const again = (await grab.boundingBox())!;
    await page.mouse.move(again.x + again.width / 2, again.y + 8);
    await page.mouse.down();
    await page.mouse.move(again.x + again.width / 2, again.y + 30, {
      steps: 6,
    });
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    expect(answers(posted)).toEqual([]);
  });

  test('R5: Send works with the keyboard open; the sheet rides above it', async ({
    page,
  }, testInfo) => {
    await installKeyboardEmulation(page);
    const posted = await openChatWith(page, ELICITATION_EVENTS, PHONE);
    const card = page.locator('.request-card');
    await card.getByRole('button', { name: 'Answer', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'fixture needs your input',
    });
    await expect(dialog).toBeVisible();
    await settled(dialog);

    const team = dialog.getByRole('textbox', { name: /Team/ });
    await team.focus();
    await page.evaluate((height) => {
      (window as any).__emulateKeyboard(height);
    }, KEYBOARD_PX);
    const visible = PHONE.height - KEYBOARD_PX;
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return box ? Math.round(box.y + box.height) : -1;
      })
      .toBeLessThanOrEqual(visible);
    // The focused field is in view inside the shrunken sheet, and Send is
    // still reachable above the keyboard.
    await expect(team).toBeInViewport();
    const teamBox = (await team.boundingBox())!;
    expect(teamBox.y + teamBox.height).toBeLessThanOrEqual(visible);
    const send = dialog.getByRole('button', { name: 'Send' });
    await expectReachable(page, send, 'Send above keyboard');
    await shot(page, 'mobile-elicitation-sheet-keyboard', testInfo);
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });

    const name = dialog.getByRole('textbox', { name: /Name/ });
    await name.fill('Ada');
    await team.fill('Platform');
    await send.click();
    await expect(dialog).toBeHidden();
    await expect(card.getByRole('status')).toHaveText('Answered');
    await expect(
      card.getByRole('button', { name: 'Answer', exact: true }),
    ).toHaveCount(0);
    expect(answers(posted)).toEqual([
      {
        type: 'respondToRequest',
        threadId: 'session-1',
        requestId: 'elicitation-1',
        expectedRequestEventId: 'evt-elicit-1',
        decision: 'accept',
        elicitationContent: { name: 'Ada', team: 'Platform' },
      },
    ]);
  });

  test('R7: an elicitation resolved elsewhere closes the open sheet', async ({
    page,
  }) => {
    const posted = await openChatWith(page, ELICITATION_EVENTS, PHONE);
    await page
      .locator('.request-card')
      .getByRole('button', { name: 'Answer', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'fixture needs your input',
    });
    await expect(dialog).toBeVisible();
    await emitMockOrchestrationEvent(
      page,
      'orchestration:event',
      {
        event: {
          method: 'request.resolved',
          provider: 'codex',
          threadId: 'session-1',
          createdAt: '2026-04-05T12:00:09.000Z',
          requestId: 'elicitation-1',
          status: 'cancelled',
        },
      },
      { sequence: ELICITATION_EVENTS.length + 1 },
    );
    await expect(dialog).toBeHidden();
    // Answered on another device: this page sent nothing.
    expect(answers(posted)).toEqual([]);
  });

  test('short approval: the row opens a half-height sheet; dismissal never denies; Allow Once answers', async ({
    page,
  }, testInfo) => {
    const browserHealth = await monitorBrowserHealth(page);
    const posted = await openChatWith(page, APPROVAL_EVENTS, PHONE);

    // R1: the tool row is the card; on a phone it carries Answer, not the
    // three inline decision buttons.
    const row = page.locator('.tool-call[data-approval-id="approval-1"]');
    await expect(row).toBeVisible();
    await expect(
      row.getByRole('img', { name: 'Needs approval' }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: 'Allow Once' })).toHaveCount(
      0,
    );
    const answer = row.getByRole('button', { name: 'Answer', exact: true });
    await expect(answer).toBeVisible();
    // Drawn small beside a one-line row, but still a 44px target: a point
    // 21px above, below, left and right of its centre lands on it.
    expect((await answer.boundingBox())!.height).toBeLessThan(
      MIN_TOUCH_TARGET_PX,
    );
    expect(
      await answer.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return [
          [x, y - 21],
          [x, y + 21],
          [x - 21, y],
          [x + 21, y],
        ].map(([px, py]) => {
          const hit = document.elementFromPoint(px, py);
          return hit === button || button.contains(hit);
        });
      }),
    ).toEqual([true, true, true, true]);

    const dialog = page.getByRole('dialog', { name: 'Approval needed' });
    const open = async () => {
      await answer.click();
      await expect(dialog).toBeVisible();
      await settled(dialog);
    };
    await open();
    await expect(dialog).toContainText('rm -rf build');
    const allow = dialog.getByRole('button', { name: 'Allow Once' });
    const deny = dialog.getByRole('button', { name: 'Deny' });
    await expectReachable(page, allow, 'Allow Once');
    await expectReachable(page, deny, 'Deny');
    // R3: the session grant is a secondary action, in the overflow menu.
    await expect(
      dialog.getByRole('button', { name: 'More approval options' }),
    ).toBeVisible();
    // R2: a short request opens at about half height.
    const panelBox = (await dialog.boundingBox())!;
    expect(panelBox.height).toBeGreaterThanOrEqual(PHONE.height * 0.4);
    expect(panelBox.height).toBeLessThanOrEqual(PHONE.height * 0.65);
    await shot(page, 'mobile-approval-sheet', testInfo);

    // R4: the backdrop hides it; the request is still waiting.
    await page.mouse.click(PHONE.width / 2, 40);
    await expect(dialog).toBeHidden();
    expect(answers(posted)).toEqual([]);
    await expect(answer).toBeFocused();
    await expect(
      row.getByRole('img', { name: 'Needs approval' }),
    ).toBeVisible();

    await open();
    await allow.click();
    // Accepted, not yet settled: the pressed button says so instead of the
    // sheet sitting there with every control silently disabled.
    const allowing = dialog.getByRole('button', { name: 'Allowing…' });
    await expect(allowing).toBeVisible();
    await expect(allowing).toHaveAttribute('aria-busy', 'true');
    await expect(dialog.getByRole('button', { name: 'Deny' })).toBeDisabled();
    await expect.poll(() => answers(posted).length).toBe(1);
    expect(answers(posted)[0]).toMatchObject({
      type: 'respondToRequest',
      threadId: 'session-1',
      requestId: 'approval-1',
    });
    expect(answers(posted)[0].decision).not.toBe('deny');
    browserHealth.assertHealthy();
  });

  test('Deny in flight says so, and the settled request closes the sheet', async ({
    page,
  }) => {
    const posted = await openChatWith(page, APPROVAL_EVENTS, PHONE);
    const row = page.locator('.tool-call[data-approval-id="approval-1"]');
    await row.getByRole('button', { name: 'Answer', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Approval needed' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Deny' }).click();
    const denying = dialog.getByRole('button', { name: 'Denying…' });
    await expect(denying).toBeVisible();
    await expect(denying).toHaveAttribute('aria-busy', 'true');
    await expect(
      dialog.getByRole('button', { name: 'Allow Once' }),
    ).toBeDisabled();
    await expect.poll(() => answers(posted).length).toBe(1);
    expect(answers(posted)[0]).toMatchObject({
      requestId: 'approval-1',
      decision: 'decline',
    });
    await emitMockOrchestrationEvent(
      page,
      'orchestration:event',
      {
        event: {
          method: 'request.resolved',
          provider: 'codex',
          threadId: 'session-1',
          turnId: 'turn-1',
          createdAt: '2026-04-05T12:00:09.000Z',
          requestId: 'approval-1',
          status: 'denied',
        },
      },
      { sequence: APPROVAL_EVENTS.length + 1 },
    );
    await expect(dialog).toBeHidden();
    // Settled, the row is no longer answerable and drops its request id.
    await expect(
      page
        .locator('.tool-call', { hasText: 'rm -rf build' })
        .getByText('User denied'),
    ).toBeVisible();
  });

  test('a Send that fails after the sheet was dismissed is shown on the card', async ({
    page,
  }) => {
    const posted = await openChatWith(page, ELICITATION_EVENTS, PHONE);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Registered after the fixture's own commands route, so it answers
    // first: hold the Send until the sheet is gone, then refuse it.
    await page.route('**/api/orchestration/commands', async (route) => {
      posted.push(route.request().postDataJSON());
      await held;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'The tool server stopped responding.',
        }),
      });
    });
    const card = page.locator('.request-card');
    await card.getByRole('button', { name: 'Answer', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'fixture needs your input',
    });
    await expect(dialog).toBeVisible();
    await settled(dialog);
    await dialog.getByRole('textbox', { name: /Name/ }).fill('Ada');
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => answers(posted).length).toBe(1);
    // Dismissed while the Send is still in flight.
    await page.mouse.click(PHONE.width / 2, 6);
    await expect(dialog).toBeHidden();
    release();
    await expect(card.getByRole('alert')).toContainText(
      'The tool server stopped responding.',
    );
    await expect(card.getByRole('status')).toHaveText('Waiting for you');
  });

  test('R7: an approval resolved elsewhere closes the open sheet and the row shows the result', async ({
    page,
  }) => {
    const posted = await openChatWith(page, APPROVAL_EVENTS, PHONE);
    const row = page.locator('.tool-call', { hasText: 'rm -rf build' });
    await row.getByRole('button', { name: 'Answer', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Approval needed' });
    await expect(dialog).toBeVisible();
    await emitMockOrchestrationEvent(
      page,
      'orchestration:event',
      {
        event: {
          method: 'request.resolved',
          provider: 'codex',
          threadId: 'session-1',
          turnId: 'turn-1',
          createdAt: '2026-04-05T12:00:09.000Z',
          requestId: 'approval-1',
          status: 'denied',
        },
      },
      { sequence: APPROVAL_EVENTS.length + 1 },
    );
    await expect(dialog).toBeHidden();
    await expect(row.getByText('User denied')).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Answer', exact: true }),
    ).toHaveCount(0);
    expect(answers(posted)).toEqual([]);
  });

  test('R6: the sheet honours reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openChatWith(page, ELICITATION_EVENTS, PHONE);
    await page
      .locator('.request-card')
      .getByRole('button', { name: 'Answer', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'fixture needs your input',
    });
    await expect(dialog).toBeVisible();
    const motion = await dialog.evaluate((panel) => {
      const style = getComputedStyle(panel);
      return {
        animation: Number.parseFloat(style.animationDuration),
        transition: Number.parseFloat(style.transitionDuration),
      };
    });
    // 0.01ms is the global reduced-motion reset; seconds as CSS reports them.
    expect(motion.animation).toBeLessThanOrEqual(0.00001);
    expect(motion.transition).toBeLessThanOrEqual(0.00001);
  });

  test('desktop 1280 keeps the inline form and inline approval buttons', async ({
    page,
  }, testInfo) => {
    await openChatWith(page, ELICITATION_EVENTS, { width: 1280, height: 900 });
    const form = page.getByRole('form', { name: 'Answer fixture' });
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(page.locator('.request-card')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await form.scrollIntoViewIfNeeded();
    await shot(page, 'desktop-elicitation-inline', testInfo);
  });

  test('desktop 1280 approval row keeps its inline decision buttons', async ({
    page,
  }, testInfo) => {
    await openChatWith(page, APPROVAL_EVENTS, { width: 1280, height: 900 });
    const row = page.locator('.tool-call[data-approval-id="approval-1"]');
    await expect(row.getByRole('button', { name: 'Allow Once' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Deny' })).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Answer', exact: true }),
    ).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    await shot(page, 'desktop-approval-inline', testInfo);
  });
});
