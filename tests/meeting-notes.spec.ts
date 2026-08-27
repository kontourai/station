/**
 * Meeting Notes plugin — end-to-end proof for the K5 slice
 * (`s203-knowledge-meeting-notes` plan, Wave 3 Task 6): install the example
 * plugin, then exercise the three tabs against mocked `/api/knowledge/*`
 * routes (this repo's own `/api/knowledge/search` and record-CRUD routes
 * are real core routes, not a plugin server module — mocked here the same
 * way `tests/knowledge-onboarding.spec.ts` mocks `/api/knowledge/*` for its
 * K4 coverage, rather than depending on a live Kit-store/embedder-backed
 * server):
 *
 *  - Capture: save a transcript as a `raw` record, then compile it into a
 *    `compiled` record whose provenance link back to the raw record is
 *    asserted both in the UI and in the actual POST request body.
 *  - Library (`GraphPane`): renders fixture nodes/edges and a selected
 *    node's detail panel.
 *  - Ask (`AskPane`): a query returns provenance-linked answer cards, and a
 *    second query demonstrates the honest `NO_EMBEDDER_ERROR` state.
 *
 * Plugin build+install pattern mirrors `tests/survey-review-workbench.spec.ts`
 * (`station plugin build` via the CLI, then `/api/plugins/install` +
 * `/api/projects/:slug/layouts/from-plugin`).
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_DIR = join(dirname(__filename), '..');
const PLUGIN_DIR = join(PROJECT_DIR, 'examples', 'meeting-notes');
const API = resolveE2EApiBase();

const PLUGIN_NAME = 'meeting-notes';
const PROJECT_SLUG = 'meeting-notes-e2e';

let workspaceDir: string;

async function deleteProject(): Promise<void> {
  try {
    await authenticatedE2EFetch(`${API}/api/projects/${PROJECT_SLUG}`, {
      method: 'DELETE',
    });
  } catch {}
}

async function deletePlugin(): Promise<void> {
  try {
    await authenticatedE2EFetch(`${API}/api/plugins/${PLUGIN_NAME}`, {
      method: 'DELETE',
    });
  } catch {}
}

const PERSONAL_ROOT = {
  id: 'root:personal',
  scope: { kind: 'personal' },
  adapterId: 'kit-default-store',
  storeRoot: '/mock/knowledge/personal',
  displayName: 'Personal knowledge store',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const RAW_RECORD = {
  id: 'rec_raw_1',
  type: 'raw',
  title: 'Meeting transcript — 2026-01-01T00:00:00.000Z',
  body: 'Alice: we should ship K5 this week.\nBob: agreed, roadmap first.',
  category: 'meeting-transcript',
  links: [],
  provenance: { agent: 'station.meeting-notes.capture' },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const COMPILED_RECORD = {
  id: 'rec_compiled_1',
  type: 'compiled',
  title: 'Weekly sync',
  body: 'Discussed roadmap.\n\nAction items:\n- Ship K5',
  category: 'meeting-note',
  links: [{ target_id: 'rec_raw_1', kind: 'source' }],
  provenance: {
    agent: 'station.meeting-notes.compile',
    source_ids: ['rec_raw_1'],
  },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const GRAPH_FIXTURE = {
  nodes: [
    {
      id: 'rec_raw_1',
      type: 'raw',
      title: RAW_RECORD.title,
      category: 'meeting-transcript',
    },
    {
      id: 'rec_compiled_1',
      type: 'compiled',
      title: COMPILED_RECORD.title,
      category: 'meeting-note',
    },
  ],
  edges: [{ source: 'rec_compiled_1', target: 'rec_raw_1', kind: 'source' }],
};

function jsonBody(data: unknown): string {
  return JSON.stringify({ success: true, data });
}

/** Every `/api/knowledge/*` route this plugin's three tabs touch, mocked in
 * one place (the "capture" record-POST branch inspects the request body to
 * distinguish the raw-transcript call from the compile call, since both hit
 * the same `POST .../records` path). */
async function mockKnowledgeRoutes(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.route('**/api/knowledge/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();

    if (pathname === '/api/knowledge/roots' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: jsonBody([PERSONAL_ROOT]),
      });
    }

    if (
      pathname === '/api/knowledge/roots/root%3Apersonal/records' &&
      method === 'POST'
    ) {
      const payload = request.postDataJSON() as { type?: string };
      const data = payload?.type === 'compiled' ? COMPILED_RECORD : RAW_RECORD;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: jsonBody(data),
      });
    }

    if (
      pathname ===
        '/api/knowledge/roots/root%3Apersonal/records/rec_compiled_1' &&
      method === 'GET'
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: jsonBody(COMPILED_RECORD),
      });
    }

    if (
      pathname === '/api/knowledge/roots/root%3Apersonal/records/rec_raw_1' &&
      method === 'GET'
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: jsonBody(RAW_RECORD),
      });
    }

    if (
      pathname === '/api/knowledge/roots/root%3Apersonal/graph' &&
      method === 'GET'
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: jsonBody(GRAPH_FIXTURE),
      });
    }

    if (pathname === '/api/knowledge/index/search' && method === 'POST') {
      const payload = request.postDataJSON() as { query?: string };
      if (payload?.query === 'NO_EMBEDDER_TRIGGER') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: 'No embedding provider connection is configured',
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: jsonBody([
          {
            recordId: 'rec_compiled_1',
            rootId: 'root:personal',
            score: 0.93,
            title: COMPILED_RECORD.title,
            excerpt: 'Discussed roadmap. Action items: Ship K5',
            category: 'meeting-note',
          },
        ]),
      });
    }

    return route.continue();
  });

  // The compile agent invoke — mocked regardless of the plugin-namespaced
  // resolved agent slug (e.g. `meeting-notes:compile`).
  await page.route('**/agents/**/invoke', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        response: {
          title: 'Weekly sync',
          summary: 'Discussed roadmap.',
          actionItems: ['Ship K5'],
        },
      }),
    }),
  );
}

test.describe('Meeting Notes plugin', () => {
  test.describe.configure({ mode: 'serial' });

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
  test.beforeAll(async ({}, testInfo) => {
    // A cold plugin build may legitimately approach the child process's
    // 120-second ceiling. Keep Playwright from killing the hook at its 30s
    // default while the bounded build is still healthy.
    testInfo.setTimeout(150_000);
    execSync('npx tsx ../../packages/cli/src/cli.ts plugin build', {
      cwd: PLUGIN_DIR,
      timeout: 120_000,
    });

    await deletePlugin();
    await deleteProject();

    const install = await installPluginWithConsent(API, PLUGIN_DIR);
    expect(install.success).toBe(true);
    expect(install.plugin.name).toBe(PLUGIN_NAME);
    expect(install.plugin.hasBundle).toBe(true);

    workspaceDir = mkdtempSync(join(tmpdir(), 'meeting-notes-e2e-workspace-'));
    const project = await (
      await authenticatedE2EFetch(`${API}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Meeting Notes E2E',
          slug: PROJECT_SLUG,
          workingDirectory: workspaceDir,
        }),
      })
    ).json();
    expect(project.success).toBe(true);

    const layout = await (
      await authenticatedE2EFetch(
        `${API}/api/projects/${PROJECT_SLUG}/layouts/from-plugin`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plugin: PLUGIN_NAME }),
        },
      )
    ).json();
    expect(layout.success).toBe(true);
    expect(layout.data.slug).toBe('meeting-notes');
  });

  test.afterAll(async () => {
    await deleteProject();
    await deletePlugin();
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
  });

  test('capture: saves a raw transcript, then compiles a linked note with a provenance link', async ({
    page,
  }) => {
    const recordPosts: Array<{ type?: string }> = [];
    await mockKnowledgeRoutes(page);
    await page.route(
      '**/api/knowledge/roots/root%3Apersonal/records',
      async (route) => {
        if (route.request().method() === 'POST') {
          recordPosts.push(route.request().postDataJSON());
        }
        return route.fallback();
      },
    );

    await page.goto(`/projects/${PROJECT_SLUG}/layouts/meeting-notes`);

    const captureTab = page.getByRole('button', { name: 'Capture' });
    await expect(captureTab).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('mn-root-select').selectOption('root:personal');
    await page
      .getByTestId('mn-transcript')
      .fill('Alice: we should ship K5 this week.\nBob: agreed, roadmap first.');

    const saveButton = page.getByTestId('mn-save-transcript');
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect(page.getByTestId('mn-raw-record')).toContainText('rec_raw_1', {
      timeout: 15_000,
    });

    const compileButton = page.getByTestId('mn-compile');
    await expect(compileButton).toBeEnabled();
    await compileButton.click();

    await expect(page.getByTestId('mn-compiled-record')).toContainText(
      'rec_compiled_1',
      { timeout: 15_000 },
    );
    // Provenance link asserted in the UI...
    await expect(page.getByTestId('mn-compiled-record')).toContainText(
      'rec_raw_1',
    );
    await expect(page.getByTestId('mn-compiled-record')).toContainText(
      'source',
    );

    // ...and in the actual request bodies sent to the record-CRUD route.
    expect(recordPosts).toHaveLength(2);
    expect(recordPosts[0]).toMatchObject({
      type: 'raw',
      body: 'Alice: we should ship K5 this week.\nBob: agreed, roadmap first.',
      provenance: { agent: 'station.meeting-notes.capture' },
    });
    expect(recordPosts[1]).toMatchObject({
      type: 'compiled',
      title: 'Weekly sync',
      links: [{ target_id: 'rec_raw_1', kind: 'source' }],
      provenance: {
        agent: 'station.meeting-notes.compile',
        source_ids: ['rec_raw_1'],
      },
    });
  });

  test('library: graph pane renders fixture nodes/edges and a selection detail panel', async ({
    page,
  }) => {
    await mockKnowledgeRoutes(page);

    await page.goto(`/projects/${PROJECT_SLUG}/layouts/meeting-notes`);
    await page.getByRole('button', { name: 'Library' }).click();

    await page.getByTestId('mn-root-select').selectOption('root:personal');

    await expect(page.getByTestId('mn-graph-node-rec_raw_1')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByTestId('mn-graph-node-rec_compiled_1'),
    ).toBeVisible();
    await expect(page.getByTestId('mn-graph-edge')).toHaveCount(1);

    await page.getByTestId('mn-graph-node-rec_compiled_1').click();

    await expect(page.getByTestId('mn-graph-detail-title')).toHaveText(
      'Weekly sync',
      { timeout: 10_000 },
    );
    await expect(page.getByTestId('mn-graph-detail-body')).toContainText(
      'Discussed roadmap',
    );
    await expect(
      page.getByTestId('mn-graph-detail-link-rec_raw_1'),
    ).toBeVisible();
  });

  test('ask: a query returns provenance-linked answer cards, and a second query shows the honest NO_EMBEDDER state', async ({
    page,
  }) => {
    await mockKnowledgeRoutes(page);

    await page.goto(`/projects/${PROJECT_SLUG}/layouts/meeting-notes`);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    await page
      .getByTestId('mn-ask-query')
      .fill('what did we decide about the roadmap?');
    await page.getByTestId('mn-ask-submit').click();

    const result = page.getByTestId('mn-ask-result');
    await expect(result).toBeVisible({ timeout: 15_000 });
    await expect(result).toContainText('Weekly sync');
    await expect(result).toContainText(
      'Discussed roadmap. Action items: Ship K5',
    );

    await page.getByTestId('mn-ask-source-link-rec_compiled_1').click();
    await expect(page.getByTestId('mn-ask-detail')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('mn-ask-detail')).toContainText(
      'Weekly sync',
    );

    // A second query, engineered to surface the honest NO_EMBEDDER_ERROR
    // state — never a generic/blank failure.
    await page.getByTestId('mn-ask-query').fill('NO_EMBEDDER_TRIGGER');
    await page.getByTestId('mn-ask-submit').click();

    await expect(page.getByText('No embedding model configured')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('mn-ask-configure-embedder')).toBeVisible();
  });
});
