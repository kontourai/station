import type { Server } from 'node:http';
import type { Page } from '@playwright/test';
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
import { dragDockTo } from './helpers/region-placement';

/**
 * #3882: opening Chat inventory beside the transcript in a wide bottom dock.
 * The inventory portals into the dock's conversation surface through a mount
 * and a wrapper div; as block boxes they made one flex item twice the aside's
 * width (a dead gutter) and, with the session context card still beside it,
 * left the transcript about 354px at 1600px and 194px at 1440px.
 *
 * A real chat (a real turn through a local model fixture) in a real Station
 * instance, measured at both widths: the aside sits flush against the
 * transcript, the transcript keeps its 640px floor, the card gives way to the
 * inventory (its chip remains), and closing the inventory brings it back.
 * Opened and closed from the keyboard, focus moves into the panel and comes
 * back to the card's Chat inventory button, never to the page.
 */

const CONNECTION_ID = 'e2e-chat-inventory-layout-fixture';
const MODEL = 'station-chat-inventory-layout:latest';
const REPLY = 'Chat inventory layout fixture answered the composer.';
/** TRANSCRIPT_MIN_WIDTH (src-ui/src/components/chat/transcriptMeasure.ts). */
const TRANSCRIPT_FLOOR = 640;

interface LlmConnection {
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

/** Dock columns, in CSS pixels. */
function dockColumns(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector(`#chat-dock ${selector}`);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    };
    return {
      transcript: box('.chat-messages'),
      aside: box('.session-inventory-compact--aside'),
      card: box('.session-context-card:not(.session-context-card--sheet)'),
      chip: Boolean(document.querySelector('.session-context-chip')),
    };
  });
}

/** Where keyboard focus is, in terms of the surfaces under test. */
function focusedSurface(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return 'page';
    if (active.closest('.session-inventory-compact')) return 'inventory';
    if (active.matches('.session-context-chip')) return 'chip';
    if (
      active.closest('.session-context-card__footer') &&
      active.textContent?.trim() === 'Chat inventory'
    )
      return 'card-inventory';
    return active.tagName.toLowerCase();
  });
}

test.describe('Chat inventory beside the transcript (#3882)', () => {
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

  test('keeps the transcript at its floor with no gutter at 1440 and 1600px', async ({
    page,
    authenticatedRequest,
    baseURL,
  }) => {
    test.setTimeout(240_000);
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
          name: 'Chat inventory layout fixture',
          enabled: true,
          capabilities: ['llm'],
          config: { baseUrl: fixture.origin, defaultModel: MODEL },
          status: 'ready',
          prerequisites: [],
        },
      },
    );
    expect(connectionCreated.ok()).toBe(true);
    const agentSlug = `e2e-chat-inventory-layout-${Date.now()}`;
    const agentCreated = await authenticatedRequest.post('/agents', {
      data: {
        slug: agentSlug,
        name: `E2E Chat Inventory Layout ${Date.now()}`,
        prompt: 'Answer in one short sentence.',
      },
    });
    expect(agentCreated.ok()).toBe(true);
    seededAgentSlug = agentSlug;
    await waitForSeededAgent(authenticatedRequest, agentSlug);

    await page.setViewportSize({ width: 1600, height: 900 });
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
      .fill('Chat inventory layout.');
    await draft.getByRole('button', { name: 'Start', exact: true }).click();
    await ensureChatDockOpen(page);
    await waitForDispatchThroughCapacityRetries(page, chatRequests, 1);
    const dock = page.locator('#chat-dock');
    await expect(dock.getByText(REPLY, { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // Closed with its Close button at 1600px and with Escape at 1440px.
    for (const [width, closeWith] of [
      [1600, 'Close'],
      [1440, 'Escape'],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      // The wide dock shows the card beside the transcript.
      const card = dock.locator(
        '.session-context-card:not(.session-context-card--sheet)',
      );
      await expect(card).toBeVisible();
      // From the keyboard: the card folds as the inventory opens, taking
      // the focused button with it, so focus must move into the panel.
      await card.getByRole('button', { name: 'Chat inventory' }).focus();
      await page.keyboard.press('Enter');
      const aside = dock.locator('.session-inventory-compact--aside');
      await expect(aside).toBeVisible();
      await expect.poll(() => focusedSurface(page)).toBe('inventory');

      await expect
        .poll(async () => {
          const columns = await dockColumns(page);
          return {
            card: columns.card,
            chip: columns.chip,
            floor: (columns.transcript?.width ?? 0) >= TRANSCRIPT_FLOOR - 0.5,
            // Flush: no column of nothing between the aside and the
            // transcript.
            gutter:
              columns.aside && columns.transcript
                ? Math.round(columns.transcript.left - columns.aside.right)
                : null,
          };
        })
        .toEqual({ card: null, chip: true, floor: true, gutter: 0 });

      if (closeWith === 'Close')
        await aside
          .getByRole('button', { name: 'Close Chat inventory' })
          .press('Enter');
      else await page.keyboard.press('Escape');
      await expect(aside).toHaveCount(0);
      // Without the inventory the card has its room back, and focus lands
      // on its Chat inventory button (by way of the chip it replaced), not
      // on the page.
      await expect(card).toBeVisible();
      await expect.poll(() => focusedSurface(page)).toBe('card-inventory');
    }
    // #3951: the same real chat in a 400px side dock must remain usable.
    await page.setViewportSize({ width: 1600, height: 900 });
    await dragDockTo(page, 'right');
    await expect(dock).toHaveClass(/chat-dock--right/);
    const resize = dock.getByRole('button', {
      name: 'Resize chat dock',
      exact: true,
    });
    const handle = await resize.boundingBox();
    const beforeResize = await dock.boundingBox();
    if (!handle || !beforeResize)
      throw new Error('Side dock resize handle is missing');
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      beforeResize.x + beforeResize.width - 400,
      handle.y + handle.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => Math.round((await dock.boundingBox())?.width ?? 0))
      .toBe(400);
    const basis = dock.getByRole('button', { name: /^Basis/ }).first();
    await basis.click();
    const inventory = dock.getByLabel('Chat inventory', { exact: true });
    await expect(inventory).toBeVisible();
    await expect(dock.locator('.chat-dock__content-area')).toBeHidden();
    await expect
      .poll(async () => {
        const surface = await dock
          .locator('.chat-dock__conversation-surface')
          .boundingBox();
        const panel = await inventory.boundingBox();
        if (!surface || !panel) return false;
        return (
          Math.abs(panel.width - surface.width) <= 1 &&
          Math.abs(panel.height - surface.height) <= 1
        );
      })
      .toBe(true);
    await inventory
      .getByRole('button', { name: 'Close Chat inventory' })
      .click();
    await expect(dock.getByText(REPLY, { exact: true })).toBeVisible();
    await expect(basis).toBeFocused();
    browserHealth.assertHealthy();
  });
});
