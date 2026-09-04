/**
 * Browser-owned host composition/keyboard/reflow proof. Project/Layout/Pane
 * routes are real; the action transport is intercepted to avoid live provider
 * effects. Real HTTP→foreground→provider execution is covered by the server
 * controlled-provider seam test, not claimed from this interception.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';

const api = resolveE2EApiBase();
const slug = 'pane-host-actions-proof';
let workspace = '';
let directRoute = '';
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'station-host-actions-browser-'));
  const response = await authenticatedE2EFetch(`${api}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      name: 'Host Actions Proof',
      workingDirectory: workspace,
    }),
  });
  expect(response.status).toBe(201);
  const applied = await authenticatedE2EFetch(
    `${api}/api/projects/${slug}/layouts/apply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layoutId: 'builtin:coding' }),
    },
  );
  expect(applied.status).toBe(201);
  const catalog = await (
    await authenticatedE2EFetch(`${api}/api/projects/${slug}/panes`)
  ).json();
  const descriptor = catalog.data.descriptors.find(
    (item: { renderer?: { name?: string } }) =>
      item.renderer?.name === 'workspace-coding-file-browser',
  );
  expect(descriptor).toBeTruthy();
  const occurrence = catalog.data.instances.find(
    (item: { descriptorId: string }) => item.descriptorId === descriptor.id,
  );
  expect(occurrence).toBeTruthy();
  directRoute = `/projects/${slug}/layouts/coding/panes/${encodeURIComponent(descriptor.id)}/${encodeURIComponent(occurrence.instanceId)}`;
});
test.afterAll(async () => {
  const response = await authenticatedE2EFetch(`${api}/api/projects/${slug}`, {
    method: 'DELETE',
  });
  expect([200, 404]).toContain(response.status);
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

for (const width of [1280, 390]) {
  test(`one host bar on direct and placed panes, keyboard selection and ${width}px reflow`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() =>
      localStorage.setItem('station:onboarding-setup-dismissed', '1'),
    );
    const owner = {
      pluginId: 'workspace-helper',
      installationGeneration: `sha256:${'a'.repeat(64)}`,
    };
    const actions = [
      {
        key: `plugin-host-action:${'b'.repeat(64)}`,
        id: 'overview',
        label: 'Daily overview',
        presentation: 'action',
        availability: 'available',
      },
    ];
    const agents = ['assistant', 'reviewer'].map((agentId) => ({
      declaration: { kind: 'own-plugin-agent', agentId },
      resolution: {
        state: 'available',
        agent: { kind: 'plugin-agent', ...owner, agentId },
      },
    }));
    const requests: unknown[] = [];
    let executionCount = 0;
    await page.route('**/api/orchestration/pane-host/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown;
      if (path.endsWith('/catalog')) {
        data = {
          projectSlug: slug,
          support: 'supported',
          complete: true,
          contributions: [
            {
              projection: {
                version: 'station.workspace-pane-host-contribution/v1',
                owner,
                projectId: 'project-proof',
                actions,
                agentSelection: {
                  availableAgents: agents,
                  defaultAgent: agents[0],
                },
              },
            },
          ],
        };
      } else if (path.endsWith('/prepare')) {
        requests.push(route.request().postDataJSON());
        data = { state: 'prepared', ticket: 'a'.repeat(43) };
      } else {
        executionCount++;
        data = {
          state: 'accepted',
          conversationId: 'browser-conversation',
          sessionId: 'browser-execution',
          turnId: 'browser-turn',
        };
      }
      await route.fulfill({ json: { success: true, data } });
    });
    for (const path of [`/projects/${slug}/layouts/coding`, directRoute]) {
      await page.goto(path);
      const bar = page.getByRole('region', {
        name: 'Workspace actions',
        exact: true,
      });
      await expect(bar).toBeVisible({ timeout: 20_000 });
      await expect(bar).toHaveCount(1);
      await expect(
        bar.getByRole('button', { name: 'Daily overview', exact: true }),
      ).toHaveCount(1);
      const combo = bar.getByRole('combobox', { name: 'Agent' });
      await expect(combo).toHaveValue('own-plugin-agent:assistant');
      await combo.focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(combo).toHaveValue('own-plugin-agent:reviewer');
      expect(
        await bar.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      const box = await combo.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      await testInfo.attach(
        `host-actions-${width}-${path.includes('/panes/') ? 'direct' : 'placed'}`,
        { body: await bar.screenshot(), contentType: 'image/png' },
      );
    }
    const action = page.getByRole('button', {
      name: 'Daily overview',
      exact: true,
    });
    await action.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('button', { name: 'Open conversation', exact: true }),
    ).toBeVisible();
    expect(requests).toEqual([
      {
        ...owner,
        actionKey: actions[0]!.key,
        selectedAgent: { kind: 'own-plugin-agent', agentId: 'reviewer' },
      },
    ]);
    expect(executionCount).toBe(1);
    await expect(action).toBeDisabled();
  });
}
