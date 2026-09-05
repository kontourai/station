/**
 * Real portable install→browser→SDK→HTTP→captured admission→Muse echo→EventStore proof.
 * The smoke-live runner selects Muse's no-network echo provider only in its
 * attested disposable home. No route interception or live paid model is used.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  authenticatedE2EFetch,
  createAuthenticatedE2ERequest,
} from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';

const api = resolveE2EApiBase();
const slug = 'host-action-live-proof';
const plugin = 'host-action-browser-proof';
let workspace = '';
let installed = false;
let created = false;

test.afterAll(async () => {
  if (created) {
    const response = await authenticatedE2EFetch(
      `${api}/api/projects/${slug}`,
      { method: 'DELETE' },
    );
    expect(response.ok || response.status === 404).toBe(true);
  }
  if (installed) {
    const response = await authenticatedE2EFetch(
      `${api}/api/registry/plugins/${plugin}`,
      { method: 'DELETE' },
    );
    expect(response.ok || response.status === 404).toBe(true);
  }
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

test('portable installed host default Agent action completes one real echo turn and exposes its durable evidence', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const connection = await (
    await authenticatedE2EFetch(`${api}/api/connections/muse`)
  ).json();
  expect(
    connection.data,
    'Muse must be a ready external connection; missing engine is not a passing proof',
  ).toMatchObject({ kind: 'agent', enabled: true, status: 'ready' });
  const result = await installPluginWithConsent(
    api,
    resolve('tests/fixtures/workspace-pane-host-actions'),
  );
  expect(result.success).toBe(true);
  installed = true;
  const installedAgent = await authenticatedE2EFetch(
    `${api}/api/agents/host-action-echo`,
  );
  expect(
    installedAgent.ok,
    'Installation must materialize the declared Agent',
  ).toBe(true);
  expect((await installedAgent.json()).data).toMatchObject({
    execution: { agentConnectionId: 'muse' },
  });
  workspace = mkdtempSync(join(tmpdir(), 'station-host-action-live-'));
  const project = await authenticatedE2EFetch(`${api}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      name: 'Host Action Live Proof',
      workingDirectory: workspace,
      agents: ['host-action-echo'],
    }),
  });
  expect(project.status, await project.text()).toBe(201);
  created = true;
  const layout = await authenticatedE2EFetch(
    `${api}/api/projects/${slug}/layouts/apply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layoutId: 'builtin:coding' }),
    },
  );
  expect(layout.status).toBe(201);
  await page.goto(`/projects/${slug}/layouts/coding`);
  const bar = page.getByRole('region', {
    name: 'Workspace actions',
    exact: true,
  });
  await expect(bar).toBeVisible({ timeout: 20_000 });
  await expect(bar.getByRole('combobox', { name: 'Agent' })).toHaveValue(
    'own-plugin-agent:host-action-echo',
  );
  const button = bar.getByRole('button', {
    name: 'Run host action proof',
    exact: true,
  });
  await expect(button).toBeEnabled();
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' &&
      new URL(candidate.url()).pathname.endsWith(`/pane-host/${slug}/execute`),
  );
  await button.click();
  const execution = (await (await response).json()).data;
  expect(
    execution,
    'The UI must receive the actual route execution receipt',
  ).toMatchObject({ state: 'accepted' });
  await expect(button).toBeDisabled();
  const browserRequest = createAuthenticatedE2ERequest(page.request);
  let evidence: any;
  await expect
    .poll(
      async () => {
        const read = await browserRequest.get(
          `${api}/api/orchestration/sessions/${encodeURIComponent(execution.sessionId)}`,
        );
        if (!read.ok()) return false;
        evidence = (await read.json()).data;
        return evidence?.events?.some(
          (event: any) =>
            event.method === 'turn.completed' &&
            event.turnId === execution.turnId &&
            /echo:[\s\S]*HOST_ACTION_BROWSER_1372/.test(event.outputText ?? ''),
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  expect(
    evidence.events.filter(
      (event: any) =>
        event.method === 'turn.started' && event.turnId === execution.turnId,
    ),
  ).toHaveLength(1);
  const source = evidence.events.find(
    (event: any) => event.method === 'session.started',
  )?.metadata?.workspacePaneHostAction;
  expect(source).toMatchObject({ pluginId: plugin, actionId: 'echo-proof' });
  expect(typeof source.installationGeneration).toBe('string');
  expect(source.installationGeneration.length).toBeGreaterThan(0);
  await bar
    .getByRole('button', { name: 'Open conversation', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await page
            .locator(
              '#chat-dock .message.assistant, #chat-workspace-pane .message.assistant',
            )
            .allInnerTexts()
        ).join('\n'),
      { timeout: 20_000 },
    )
    .toMatch(/echo:[\s\S]*HOST_ACTION_BROWSER_1372/);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Session record missing.' }),
  ).toHaveCount(0);
  await expect(
    bar.getByRole('button', { name: 'View result', exact: true }),
  ).toBeVisible();
  const evidenceRoot = join(
    process.cwd(),
    '.kontourai',
    'pane-host-actions-browser',
    basename(process.env.STATION_E2E_OUTPUT_DIR ?? 'manual'),
  );
  mkdirSync(evidenceRoot, { recursive: true });
  const receiptPath = join(evidenceRoot, 'connected-host-action.json');
  writeFileSync(
    receiptPath,
    JSON.stringify(
      { ...execution, source, agentId: 'host-action-echo', completed: true },
      null,
      2,
    ),
  );
  const imagePath = join(evidenceRoot, 'connected-host-action.png');
  await page.screenshot({
    path: testInfo.outputPath('connected-host-action.png'),
  });
  copyFileSync(testInfo.outputPath('connected-host-action.png'), imagePath);
  await testInfo.attach('connected-host-action-receipt', {
    path: receiptPath,
    contentType: 'application/json',
  });
  await testInfo.attach('connected-host-action-browser', {
    path: imagePath,
    contentType: 'image/png',
  });
});
