import type { Server } from 'node:http';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  ensureChatDockOpen,
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
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * Chat inventory's item drill-down on a phone. A real chat (one turn through
 * a local model fixture) in a real isolated Station; at 390x844 the reader
 * opens from the dock header (the turn itself is sent at desktop width), the authored input is drilled into, and its
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

    // The turn is sent at desktop width, where the dock opens beside the
    // composer; on a phone it can settle collapsed under the turn-finished
    // notice, which would make this gate race a step it is not about. Every
    // inventory step below runs at the phone size.
    await page.setViewportSize({ width: 1280, height: 900 });
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
    // On a fresh instance the dock can mount collapsed after Start returns;
    // `ensureChatDockOpen` decides from one look, so let the dock's toggle
    // exist (in either state) before it looks.
    await expect(
      page
        .getByRole('button', {
          name: /^(?:Expand chat(?: dock)?|Show Chat|Collapse chat(?: dock)?|Hide Chat)$/,
        })
        .first(),
    ).toBeVisible({ timeout: 20_000 });
    await ensureChatDockOpen(page);
    const dock = page.locator('#chat-dock');
    await expect(dock.getByText(REPLY, { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await dock
      .getByRole('button', { name: 'Chat inventory', exact: true })
      .click();
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
    browserHealth.assertHealthy();
  });
});
