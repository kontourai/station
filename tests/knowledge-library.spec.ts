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
const projectDir = join(dirname(__filename), '..');
const pluginDir = join(projectDir, 'examples', 'knowledge-library');
const api = resolveE2EApiBase();
const pluginName = 'knowledge-library';
const projectSlug = 'knowledge-library-e2e';

let workspaceDir: string;

const personalRoot = {
  id: 'root:personal',
  scope: { kind: 'personal' },
  adapterId: 'kit-default-store',
  storeRoot: '/mock/knowledge/personal',
  displayName: 'Personal knowledge',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const activeProjectRoot = {
  id: 'root:active-project',
  scope: { kind: 'project', projectSlug },
  adapterId: 'kit-default-store',
  storeRoot: '/mock/knowledge/active-project',
  displayName: 'Active project knowledge',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const otherProjectRoot = {
  id: 'root:other-project',
  scope: { kind: 'project', projectSlug: 'other-project' },
  adapterId: 'kit-default-store',
  storeRoot: '/mock/knowledge/other-project',
  displayName: 'Other project knowledge',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const sourceRecord = {
  id: 'record-source',
  type: 'raw',
  title: 'Traycer research source',
  body: 'Original competitive research notes.',
  category: 'research.source',
  provenance: { agent: 'knowledge.ingest' },
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};
const decisionRecord = {
  id: 'record-decision',
  type: 'concept',
  title: 'Unified product authority decision',
  body: 'Station composes the experience while each product retains authority.',
  category: 'product.decision',
  status: 'active',
  expires_at: '2099-01-01T00:00:00.000Z',
  links: [{ target_id: sourceRecord.id, kind: 'source' }],
  provenance: {
    agent: 'knowledge.synthesize',
    session_id: 'epic-84',
    source_ids: [sourceRecord.id],
  },
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-19T00:00:00.000Z',
};
const graph = {
  nodes: [
    {
      id: decisionRecord.id,
      type: decisionRecord.type,
      title: decisionRecord.title,
      category: decisionRecord.category,
    },
    {
      id: sourceRecord.id,
      type: sourceRecord.type,
      title: sourceRecord.title,
      category: sourceRecord.category,
    },
  ],
  edges: [
    {
      source: decisionRecord.id,
      target: sourceRecord.id,
      kind: 'source',
    },
  ],
};

function jsonBody(data: unknown): string {
  return JSON.stringify({ success: true, data });
}

async function deleteProject(): Promise<void> {
  try {
    await authenticatedE2EFetch(`${api}/api/projects/${projectSlug}`, {
      method: 'DELETE',
    });
  } catch {}
}

async function deletePlugin(): Promise<void> {
  try {
    await authenticatedE2EFetch(`${api}/api/plugins/${pluginName}`, {
      method: 'DELETE',
    });
  } catch {}
}

test.describe('Knowledge Library plugin', () => {
  test.describe.configure({ mode: 'serial' });

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(150_000);
    execSync('npx tsx ../../packages/cli/src/cli.ts plugin build', {
      cwd: pluginDir,
      timeout: 120_000,
    });

    await deletePlugin();
    await deleteProject();

    const install = await installPluginWithConsent(api, pluginDir);
    expect(install.success).toBe(true);
    expect(install.plugin.name).toBe(pluginName);

    workspaceDir = mkdtempSync(join(tmpdir(), 'knowledge-library-e2e-'));
    const project = await (
      await authenticatedE2EFetch(`${api}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Knowledge Library E2E',
          slug: projectSlug,
          workingDirectory: workspaceDir,
        }),
      })
    ).json();
    expect(project.success).toBe(true);

    const layout = await (
      await authenticatedE2EFetch(
        `${api}/api/projects/${projectSlug}/layouts/from-plugin`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plugin: pluginName }),
        },
      )
    ).json();
    expect(layout.success).toBe(true);
    expect(layout.data.slug).toBe('knowledge-library');
  });

  test.afterAll(async () => {
    await deleteProject();
    await deletePlugin();
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
  });

  test('recalls canonical record provenance through read-only Knowledge Store requests', async ({
    page,
  }) => {
    const knowledgeRequests: Array<{ method: string; pathname: string }> = [];
    await page.route('**/api/knowledge/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      knowledgeRequests.push({
        method: request.method(),
        pathname: url.pathname,
      });

      if (url.pathname === '/api/knowledge/roots') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: jsonBody([personalRoot, activeProjectRoot, otherProjectRoot]),
        });
      }
      if (url.pathname === '/api/knowledge/roots/root%3Aactive-project/graph') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: jsonBody(graph),
        });
      }
      if (
        url.pathname ===
        '/api/knowledge/roots/root%3Aactive-project/records/record-decision'
      ) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: jsonBody(decisionRecord),
        });
      }
      if (
        url.pathname ===
        '/api/knowledge/roots/root%3Aactive-project/records/record-source'
      ) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: jsonBody(sourceRecord),
        });
      }
      return route.abort();
    });

    await page.goto(`/projects/${projectSlug}/layouts/knowledge-library`);
    await expect(
      page.getByRole('heading', { name: 'Knowledge Library' }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByRole('option', { name: /Personal knowledge/ }),
    ).toBeAttached();
    await expect(
      page.getByRole('option', { name: /Active project knowledge/ }),
    ).toBeAttached();
    await expect(
      page.getByRole('option', { name: /Other project knowledge/ }),
    ).toHaveCount(0);

    await page.getByTestId('kl-root-select').selectOption(activeProjectRoot.id);
    await page.getByTestId(`kl-node-${decisionRecord.id}`).click();

    await expect(page.getByTestId('kl-record-title')).toHaveText(
      decisionRecord.title,
      { timeout: 10_000 },
    );
    await expect(page.getByTestId('kl-record-provenance')).toContainText(
      'knowledge.synthesize',
    );
    await expect(page.getByTestId('kl-record-freshness')).toContainText(
      'Expires at 2099-01-01',
    );
    await expect(page.getByTestId('kl-authority')).toContainText(
      'graph is derived',
    );

    await page.getByTestId(`kl-record-link-${sourceRecord.id}`).click();
    await expect(page.getByTestId('kl-record-title')).toHaveText(
      sourceRecord.title,
    );
    expect(knowledgeRequests.length).toBeGreaterThanOrEqual(4);
    expect(knowledgeRequests.every((request) => request.method === 'GET')).toBe(
      true,
    );
  });
});
