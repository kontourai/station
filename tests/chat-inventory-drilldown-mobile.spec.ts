import type { Server } from 'node:http';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  waitForAgentRemoved,
  waitForDispatchThroughCapacityRetries,
  waitForSeededAgent,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { monitorBrowserHealth } from './helpers/browser-health';
import { phoneChatInventoryControls } from './helpers/chat-inventory';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * Chat inventory's item drill-down on a phone. A real chat (one turn through
 * a local model fixture) in a real isolated Station; at 390x844 the reader
 * opens from the dock header, the authored input is drilled into, and its
 * text must come back from the exact input read and render. Then the layout
 * is measured, not read from the DOM: nothing overflows the viewport, the
 * classification chip is not card-wide, the title and its "View details" cue
 * share one row, and every action is a 44px target on its own row.
 *
 * Shipped broken because the only browser coverage of this reader sat in the
 * dispatch-only extended bucket; this journey is in PR_BROWSER_SMOKE_CONTRACT.
 */

const CONNECTION_ID = 'e2e-chat-inventory-drilldown-fixture';
const MODEL = 'station-chat-inventory-drilldown:latest';
const PROMPT = 'Chat inventory drill-down on a phone.';
const REPLY = 'Chat inventory drill-down fixture answered.';
const WIDTH = 390;
const HEIGHT = 844;

interface LlmConnection extends Record<string, unknown> {
  id: string;
  enabled?: boolean;
  capabilities?: string[];
}

async function enabledLlmConnections(request: AuthenticatedE2ERequest) {
  const response = await request.get('/api/connections/models');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { data?: LlmConnection[] };
  return (body.data ?? []).filter(
    (connection) =>
      connection.enabled !== false &&
      (connection.capabilities ?? []).includes('llm'),
  );
}

async function setConnectionsEnabled(
  request: AuthenticatedE2ERequest,
  connections: LlmConnection[],
  enabled: boolean,
) {
  for (const connection of connections) {
    const response = await request.put(
      `/api/connections/${encodeURIComponent(connection.id)}`,
      { data: { ...connection, enabled } },
    );
    expect(response.ok()).toBe(true);
  }
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error('expected a rendered box');
  return value;
}

/** Elements under `selector` whose right edge passes the viewport. */
function overflowingElements(page: Page, selector: string) {
  return page.evaluate(
    ({ selector, width }) =>
      [...document.querySelectorAll(`${selector}, ${selector} *`)]
        .filter((node) => node.getBoundingClientRect().right > width + 0.5)
        .map((node) => node.className || node.tagName),
    { selector, width: WIDTH },
  );
}

/**
 * #4176: the reader names itself once, and its header never sits over its
 * content: the body is the scroll box under the header, and at rest the
 * first row of the inventory (its description and Scope) is wholly inside it.
 */
async function expectOneTitleAndNoOverlap(reader: Locator) {
  await expect(reader.getByText('Chat inventory', { exact: true })).toHaveCount(
    1,
  );
  const body = reader.locator('.station-dialog__body');
  await body.evaluate((node) => {
    node.scrollTop = 0;
  });
  const headerBox = await box(reader.locator('.station-dialog__header'));
  const bodyBox = await box(body);
  expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(bodyBox.y + 0.5);
  const firstRow = await box(reader.locator('.session-inventory__header'));
  expect(firstRow.y).toBeGreaterThanOrEqual(bodyBox.y - 0.5);
}

test.describe('Chat inventory item drill-down on a phone', () => {
  let fixtureServer: Server | null = null;
  let suspended: LlmConnection[] = [];
  let seededAgentSlug = '';

  test.afterEach(async ({ authenticatedRequest }) => {
    const removedSlug = seededAgentSlug;
    try {
      if (removedSlug) {
        const removal = await authenticatedRequest.delete(
          `/agents/${encodeURIComponent(removedSlug)}`,
        );
        expect(removal.ok() || removal.status() === 404).toBe(true);
      }
      const connectionRemoval = await authenticatedRequest.delete(
        `/api/connections/${CONNECTION_ID}`,
      );
      expect(connectionRemoval.ok() || connectionRemoval.status() === 404).toBe(
        true,
      );
      await setConnectionsEnabled(
        authenticatedRequest,
        suspended.splice(0),
        true,
      );
      if (removedSlug)
        await waitForAgentRemoved(authenticatedRequest, removedSlug);
    } finally {
      seededAgentSlug = '';
      await closeFixtureServer(fixtureServer);
      fixtureServer = null;
    }
  });

  test(`reads an authored input and lays it out at ${WIDTH}x${HEIGHT}`, async ({
    page,
    authenticatedRequest,
    baseURL,
  }, testInfo) => {
    test.setTimeout(150_000);
    if (!baseURL) throw new Error('Playwright baseURL is required');
    const browserHealth = await monitorBrowserHealth(page);

    suspended = await enabledLlmConnections(authenticatedRequest);
    await setConnectionsEnabled(authenticatedRequest, suspended, false);
    const chatRequests: unknown[] = [];
    const fixture = await startOllamaFixture(
      MODEL,
      (body) => chatRequests.push(body),
      REPLY,
    );
    fixtureServer = fixture.server;
    const connectionCreated = await authenticatedRequest.post(
      '/api/connections',
      {
        data: {
          id: CONNECTION_ID,
          kind: 'model',
          type: 'ollama',
          name: 'Chat inventory drill-down fixture',
          enabled: true,
          capabilities: ['llm'],
          config: { baseUrl: fixture.origin, defaultModel: MODEL },
          status: 'ready',
          prerequisites: [],
        },
      },
    );
    expect(connectionCreated.ok()).toBe(true);
    const agentSlug = `e2e-chat-inventory-drilldown-${Date.now()}`;
    const agentCreated = await authenticatedRequest.post('/agents', {
      data: {
        slug: agentSlug,
        name: `E2E Chat Inventory Drill-down ${Date.now()}`,
        prompt: 'Answer in one short sentence.',
      },
    });
    expect(agentCreated.ok()).toBe(true);
    seededAgentSlug = agentSlug;
    await waitForSeededAgent(authenticatedRequest, agentSlug);

    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await page.goto(baseURL);
    const draft = page.getByRole('form', { name: 'Start work' });
    await draft
      .getByRole('button', { name: /^Agent:/ })
      .click({ timeout: 30_000 });
    await page
      .getByRole('dialog', { name: 'Choose agent' })
      .locator(`.new-chat-modal__agent[data-agent-slug="${agentSlug}"]`)
      .click({ timeout: 30_000 });
    await draft
      .getByRole('textbox', { name: 'What would you like done?', exact: true })
      .fill(PROMPT);
    await draft.getByRole('button', { name: 'Start', exact: true }).click();
    await waitForDispatchThroughCapacityRetries(page, chatRequests, 1);
    // Start opens the phone dock on the chat it started (#4175). Asserted, not
    // helped: clicking the dock's toggle here raced that open and closed it.
    const dock = page.locator('#chat-dock');
    const header = dock.getByTestId('chat-dock-mobile-header');
    await expect(
      header.getByRole('button', { name: 'Collapse chat', exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(dock.getByText(REPLY, { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // The header stays one row: Chat actions and New chat are 44px targets
    // inside it, clear of each other and of the chat title, and Chat inventory
    // is a row of the Chat actions sheet rather than a third bar control
    // (#4192: it wrapped above ⋯ as a floating pill). 320px is the narrowest
    // phone the header supports; 390px is this journey's.
    const { chatActions, inventoryRow } = phoneChatInventoryControls(page);
    // Measured once Chat inventory is available (the row appears when the
    // chat's inventory is ready), since that is when it used to wrap the bar.
    await chatActions.click();
    await expect(inventoryRow).toBeVisible({ timeout: 15_000 });
    await page
      .getByRole('button', { name: 'Close actions menu', exact: true })
      .click();
    await expect(inventoryRow).toHaveCount(0);
    for (const width of [320, WIDTH]) {
      await page.setViewportSize({ width, height: HEIGHT });
      await expect(async () => {
        const headerBox = await box(header);
        const titleBox = await box(
          header.getByRole('button', { name: /^Chats and tasks — / }),
        );
        const actionBoxes = [
          await box(chatActions),
          await box(
            header.getByRole('button', { name: 'New chat', exact: true }),
          ),
        ];
        expect(headerBox.width).toBe(width);
        for (const action of actionBoxes) {
          expect(action.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
          expect(action.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
          expect(action.x).toBeGreaterThanOrEqual(headerBox.x);
          expect(action.y).toBeGreaterThanOrEqual(headerBox.y);
          expect(action.x + action.width).toBeLessThanOrEqual(
            headerBox.x + headerBox.width + 0.5,
          );
          expect(action.y + action.height).toBeLessThanOrEqual(
            headerBox.y + headerBox.height + 0.5,
          );
          expect(action.x).toBeGreaterThanOrEqual(
            titleBox.x + titleBox.width - 0.5,
          );
          // One row: level with the title, not stacked above or below it.
          expect(
            Math.abs(
              action.y + action.height / 2 - (titleBox.y + titleBox.height / 2),
            ),
          ).toBeLessThan(1);
        }
        expect(actionBoxes[1].x).toBeGreaterThanOrEqual(
          actionBoxes[0].x + actionBoxes[0].width - 0.5,
        );
        // Nothing else in the bar sits where the wrapped pill did.
        for (const button of await header.getByRole('button').all()) {
          const control = await box(button);
          expect(control.y + control.height).toBeLessThanOrEqual(
            headerBox.y + headerBox.height + 0.5,
          );
          expect(
            Math.abs(
              control.y +
                control.height / 2 -
                (titleBox.y + titleBox.height / 2),
            ),
          ).toBeLessThan(1);
        }
      }).toPass({ timeout: 5_000 });
    }

    await chatActions.click();
    await inventoryRow.click();
    const reader = page.getByRole('dialog', {
      name: 'Chat inventory',
      exact: true,
    });
    await expect(reader).toBeVisible();
    const toggle = reader.getByRole('button', {
      name: /^Authored message (View|Hide) details$/,
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // The body came back from the exact input read: the text this test sent,
    // not a failure in its place.
    const details = reader.getByRole('region', {
      name: 'Authored message details',
    });
    await expect(details.locator('pre')).toHaveText(PROMPT, {
      timeout: 15_000,
    });
    await expect(details.getByRole('alert')).toHaveCount(0);

    // Geometry. The drawer must have finished opening before measuring.
    await expect
      .poll(async () => (await box(reader)).x)
      .toBeGreaterThanOrEqual(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(WIDTH);
    expect(await overflowingElements(page, '.session-inventory__item')).toEqual(
      [],
    );

    const item = reader.locator('.session-inventory__item').first();
    const itemBox = await box(item);
    const chipBox = await box(
      item.locator('.session-inventory__classification'),
    );
    expect(chipBox.width).toBeLessThan(itemBox.width / 3);

    const toggleBox = await box(toggle);
    const titleBox = await box(toggle.locator('.session-inventory__label'));
    const cueBox = await box(toggle.locator('.session-inventory__item-cue'));
    expect(toggleBox.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(
      Math.abs(
        cueBox.y + cueBox.height / 2 - (titleBox.y + titleBox.height / 2),
      ),
    ).toBeLessThan(4);
    expect(cueBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);

    const bodyBox = await box(details.locator('pre'));
    const openSession = details.getByRole('button', {
      name: 'Open session',
      exact: true,
    });
    const origin = details.locator('summary', { hasText: 'Recorded origin' });
    for (const target of [openSession, origin]) {
      const targetBox = await box(target);
      expect(targetBox.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(targetBox.y).toBeGreaterThanOrEqual(
        bodyBox.y + bodyBox.height - 0.5,
      );
    }

    // WCAG 2.5.3 in the real app: every control in the inventory has an
    // accessible name containing its visible label.
    const axe = await new AxeBuilder({ page })
      .include('[role="dialog"] .session-inventory')
      .withRules(['label-content-name-mismatch', 'button-name'])
      .analyze();
    const mismatches = axe.violations.flatMap((violation) =>
      violation.nodes.map((node) => `${violation.id}:${node.target.join(' ')}`),
    );
    expect(mismatches).toEqual([]);

    await reader.screenshot({
      path: testInfo.outputPath(`inventory-drilldown-${WIDTH}.png`),
    });

    // #4176: one title per surface. The dialog chrome names the reader, and
    // the inventory inside it does not repeat that name under it.
    await expectOneTitleAndNoOverlap(reader);
    // The same reader at desktop width still carries one title.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(reader).toBeVisible();
    await expectOneTitleAndNoOverlap(reader);
    browserHealth.assertHealthy();
  });
});
