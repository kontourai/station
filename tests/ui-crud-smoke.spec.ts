import type { Server } from 'node:http';
import { expect, test } from './helpers/authenticated-request';
import { monitorBrowserHealth } from './helpers/browser-health';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

let ollamaServer: Server | null = null;

test.afterEach(async () => {
  await closeFixtureServer(ollamaServer);
  ollamaServer = null;
});

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * DESIGN.md §4's starting points replaced "start with a blank agent" and the
 * `#ae-engine` select. This journey wants Station's own engine, which is the
 * "Run it on Station" starting point — an UNCONDITIONAL step, not an optional
 * one: the previous helper's `if (visible)` guards are what let this journey
 * drift a whole redesign behind the product while staying green (archive#3743).
 */
async function chooseStationEngine(page: import('@playwright/test').Page) {
  await page
    .getByRole('button', { name: /Run it on Station/i })
    .first()
    .click({ timeout: 15_000 });
  await expect(page.locator('#ae-name')).toBeVisible({ timeout: 15_000 });
}

test.describe('UI CRUD Smoke', () => {
  test('request-only project maintenance authenticates each protected mutation', async ({
    authenticatedRequest,
  }) => {
    const projectName = `Request Auth Project ${Date.now()}`;
    const projectSlug = slugify(projectName);
    let deleted = false;
    const creation = await authenticatedRequest.post('/api/projects', {
      data: { name: projectName, slug: projectSlug },
    });
    expect(creation.ok()).toBe(true);

    try {
      const update = await authenticatedRequest.put(
        `/api/projects/${projectSlug}`,
        { data: { name: `${projectName} Updated` } },
      );
      expect(update.ok()).toBe(true);
      await expect(update.json()).resolves.toMatchObject({
        success: true,
        data: { name: `${projectName} Updated` },
      });

      const deletion = await authenticatedRequest.delete(
        `/api/projects/${projectSlug}`,
      );
      expect(deletion.ok()).toBe(true);
      await expect(deletion.json()).resolves.toMatchObject({ success: true });
      deleted = true;
    } finally {
      if (!deleted) {
        await authenticatedRequest.delete(`/api/projects/${projectSlug}`);
      }
    }
  });

  test('projects CRUD through the live UI', async ({
    page,
    authenticatedRequest,
  }) => {
    const browserHealth = await monitorBrowserHealth(page);
    const projectName = `Smoke Project ${Date.now()}`;
    const projectSlug = slugify(projectName);
    const updatedName = `${projectName} Updated`;
    await page.goto('/projects/new');
    await page.getByRole('heading', { name: 'New Project' }).waitFor({
      timeout: 15_000,
    });

    await page.getByPlaceholder('My Project').fill(projectName);
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await page.waitForURL(new RegExp(`/projects/${projectSlug}$`), {
      timeout: 10_000,
    });

    const updateResponse = await authenticatedRequest.put(
      `/api/projects/${projectSlug}`,
      { data: { name: updatedName } },
    );
    expect(updateResponse.ok()).toBe(true);
    const update = await updateResponse.json();
    expect(update.success).toBe(true);
    expect(update.data.name).toBe(updatedName);

    const deletionResponse = await authenticatedRequest.delete(
      `/api/projects/${projectSlug}`,
    );
    expect(deletionResponse.ok()).toBe(true);
    const deletion = await deletionResponse.json();
    expect(deletion.success).toBe(true);
    browserHealth.assertHealthy();
  });

  test('agents CRUD through the live UI', async ({
    page,
    authenticatedRequest,
  }) => {
    // This journey provisions a real model connection before covering create,
    // save, reload, and delete. Keep the end-to-end journey bounded without
    // clipping the strict 10-second save-response budget below.
    test.setTimeout(90_000);
    const browserHealth = await monitorBrowserHealth(page);
    const agentName = `Smoke Agent ${Date.now()}`;
    const agentSlug = slugify(agentName);
    const updatedDescription = 'Updated through Playwright smoke coverage.';
    const updatedPrompt = 'You are a smoke-tested connected agent.';
    const ollama = await startOllamaFixture('station-smoke:latest');
    ollamaServer = ollama.server;
    const existingResponse = await authenticatedRequest.get(
      '/api/connections/models',
    );
    const existingBody = (await existingResponse.json()) as {
      data?: Array<{
        id: string;
        kind: 'model';
        type: string;
        name: string;
        config: Record<string, unknown>;
        capabilities: string[];
      }>;
    };
    for (const connection of existingBody.data ?? []) {
      const disabled = await authenticatedRequest.put(
        `/api/connections/${encodeURIComponent(connection.id)}`,
        { data: { ...connection, enabled: false } },
      );
      expect(disabled.ok()).toBe(true);
    }
    const modelConnection = await authenticatedRequest.post(
      '/api/connections',
      {
        data: {
          id: `smoke-ollama-${Date.now()}`,
          kind: 'model',
          type: 'ollama',
          name: 'Smoke Ollama',
          enabled: true,
          capabilities: ['llm'],
          config: { baseUrl: ollama.origin },
          status: 'ready',
          prerequisites: [],
        },
      },
    );
    expect(modelConnection.ok()).toBe(true);

    await page.goto('/agents');
    await page.waitForSelector('.split-pane', { timeout: 15_000 });
    await page.getByRole('button', { name: 'New agent', exact: true }).click();
    await page.waitForURL(/\/agents\/new$/, { timeout: 5_000 });
    await chooseStationEngine(page);

    await page.locator('#ae-name').fill(agentName);
    // §3 put the editor on one scrolling page: no Basic/Prompt tabs, and the
    // system prompt is required for a Station-engine agent — Create stays
    // disabled until it is authored (archive#3741).
    await page.locator('#ae-prompt').fill('You are a helpful smoke test.');
    const createButton = page.getByRole('button', { name: 'Create Agent' });
    await expect(createButton).toBeEnabled({ timeout: 15_000 });
    await createButton.click();

    // §4 appends `?created=1` on the hop into the new agent, so anchoring on
    // the slug's end never matches.
    await page.waitForURL(new RegExp(`/agents/${agentSlug}(\\?|$)`), {
      timeout: 10_000,
    });
    const saveButton = page.getByRole('button', { name: 'Save Changes' });
    await expect(saveButton).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /^Saving/ })).toHaveCount(0);

    await page.locator('#ae-description').fill(updatedDescription);
    await page.locator('#ae-prompt').fill(updatedPrompt);
    const updateResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === `/agents/${agentSlug}`,
      { timeout: 10_000 },
    );
    await saveButton.click();
    const updateResponse = await updateResponsePromise;
    expect(updateResponse.ok()).toBe(true);
    // Receiving a successful response is not enough: the UI must leave its
    // pending state promptly before this journey verifies persistence.
    await expect(page.getByRole('button', { name: /^Saving/ })).toHaveCount(0, {
      timeout: 5_000,
    });

    await page.reload();
    await page.getByRole('button', { name: 'Save Changes' }).waitFor({
      timeout: 15_000,
    });
    await expect(page.locator('#ae-description')).toHaveValue(
      updatedDescription,
    );
    await expect(page.locator('#ae-prompt')).toHaveValue(updatedPrompt);

    // §8 moved Delete out of the header row and behind More actions.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete Agent' });
    await expect(deleteDialog).toBeVisible();
    // `exact` matters: the dialog's own close button is "Close Delete Agent".
    await deleteDialog
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await page.waitForURL('**/agents', { timeout: 10_000 });
    browserHealth.assertHealthy();
  });
});
