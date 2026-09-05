/**
 * Real portable install→browser→SDK→HTTP→captured admission→Muse echo→EventStore proof.
 * The smoke-live runner selects Muse's no-network echo provider only in its
 * attested disposable home. No route interception or live paid model is used.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { getOrchestrationDatabasePath } from '../src-server/domain/migrations/003-orchestration-events.js';
import { buildPlugin } from '../src-server/routes/plugins/plugin-bundles.js';
import { installPluginFromSource } from '../src-server/routes/plugins/plugin-install-shared.js';
import { EventStore } from '../src-server/services/orchestration/event-store.js';
import {
  closePluginActivationSession,
  createPluginActivationSession,
} from '../src-server/services/plugins/plugin-activation-composition.js';
import { derivePluginConsentBasis } from '../src-server/services/plugins/plugin-install-consent.js';
import { createLocalPluginInstallationHost } from '../src-server/services/plugins/plugin-installation-local.js';
import { readPluginManifestFile } from '../src-server/services/plugins/plugin-manifest-loader.js';
import { readPluginGrantRevision } from '../src-server/services/plugins/plugin-permissions.js';
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

/** Deliberately models an interrupted owner in the runner's disposable home.
 * Recovery itself still goes through the actual browser/SDK/HTTP/runtime owner. */
async function leaveRetainedActivationPending() {
  const home = process.env.STATION_E2E_HOME;
  if (process.env.STATION_E2E_RUNNER !== '1' || !home || !isAbsolute(home))
    throw new Error('Recovery proof requires the managed runner-owned home.');
  const database = getOrchestrationDatabasePath(home);
  if (!existsSync(database))
    throw new Error('Managed runtime EventStore must already exist.');
  const store = new EventStore(database);
  const session = createPluginActivationSession();
  try {
    const journal = store.createPackageMcpAdmissionJournal();
    const source = resolve('tests/fixtures/workspace-pane-host-actions');
    const grantRevision = readPluginGrantRevision(home, plugin);
    const manifest = await readPluginManifestFile(join(source, 'plugin.json'));
    const basis = derivePluginConsentBasis(source, manifest);
    if (!basis) throw new Error('Fixture consent basis is unavailable.');
    const pluginsDir = join(home, 'plugins');
    const logger = { info() {}, warn() {}, debug() {}, error() {} } as any;
    const installed = await installPluginFromSource(
      source,
      [],
      {
        projectHomeDir: home,
        pluginsDir,
        agentsDir: join(home, 'agents'),
        packageMcpJournal: journal,
        installationHost: createLocalPluginInstallationHost(
          pluginsDir,
          journal,
        ),
        buildPlugin: (directory, name, declaration) =>
          buildPlugin(directory, name, logger, declaration),
        logger,
      },
      {
        expectedPluginName: plugin,
        activationSession: session,
        consent: {
          kind: 'operator-decision',
          contentDigest: basis.contentDigest,
          permissions: basis.required,
          dependencies: basis.dependencies,
          grantRevision,
        },
      },
    );
    if (!installed.success)
      throw new Error(
        'Fixture installation did not settle its retained resources.',
      );
    const pending = journal.currentInstallation(plugin);
    if (
      pending.state !== 'observed' ||
      journal.admissionOpen(pending.installation)
    )
      throw new Error('Fixture must remain activation-pending.');
  } finally {
    // Closing before runtime composition leaves the real installer-owned
    // generation and Agent markers pending; no synthetic journal plan is used.
    closePluginActivationSession(session);
    store.close();
  }
}

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

test('retained plugin recovers through responsive UI and its host default Agent action completes one real echo turn', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const cssResponses: Array<{ path: string; status: number }> = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.endsWith('.css'))
      cssResponses.push({ path, status: response.status() });
  });
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
  writeFileSync(
    join(workspace, 'HOST-ACTION-README.md'),
    '# Host action workspace\nThis file belongs to the disposable browser proof.\n',
  );
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
  await leaveRetainedActivationPending();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/plugins');
  await page
    .getByRole('button', { name: /Host action proof.*Activation pending/ })
    .click();
  const observer = await page.context().newPage();
  await observer.goto('/plugins');
  await observer
    .getByRole('button', { name: /Host action proof.*Activation pending/ })
    .click();
  await expect(
    observer
      .locator('.detail-panel')
      .getByText('Activation pending', { exact: true }),
  ).toBeVisible();
  const recoveryEvidenceRoot = join(
    process.cwd(),
    '.kontourai',
    'pane-host-actions-browser',
    basename(process.env.STATION_E2E_OUTPUT_DIR ?? 'manual'),
  );
  mkdirSync(recoveryEvidenceRoot, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page
        .locator('.detail-panel')
        .getByText('Activation pending', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`recovery-pending-${width}.png`),
      animations: 'disabled',
    });
    copyFileSync(
      testInfo.outputPath(`recovery-pending-${width}.png`),
      join(recoveryEvidenceRoot, `recovery-pending-${width}.png`),
    );
  }
  await page
    .getByRole('button', { name: 'Review recovery', exact: true })
    .click();
  const review = page.getByRole('region', { name: 'Recovery review' });
  await expect(review).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('recovery-review-390.png'),
    animations: 'disabled',
  });
  copyFileSync(
    testInfo.outputPath('recovery-review-390.png'),
    join(recoveryEvidenceRoot, 'recovery-review-390.png'),
  );
  await review
    .getByRole('button', { name: 'Recover plugin', exact: true })
    .click();
  const consent = page.getByRole('dialog', {
    name: 'Recover plugin permissions',
  });
  await expect(consent).toBeVisible();
  await expect(
    consent.getByText('Recover this plugin?', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('recovery-consent-390.png'),
    animations: 'disabled',
  });
  copyFileSync(
    testInfo.outputPath('recovery-consent-390.png'),
    join(recoveryEvidenceRoot, 'recovery-consent-390.png'),
  );
  const recoveredResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' &&
      new URL(candidate.url()).pathname.endsWith(`/plugins/${plugin}/recover`),
  );
  await consent
    .getByRole('button', { name: 'Recover plugin', exact: true })
    .click();
  const recoveryReceipt = await (await recoveredResponse).json();
  expect(recoveryReceipt.success, JSON.stringify(recoveryReceipt)).toBe(true);
  // No reload or user refresh in the other already-connected client.
  await expect(
    observer
      .locator('.detail-panel')
      .getByText('Activation pending', { exact: true }),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page
      .locator('.detail-panel')
      .getByText('Activation pending', { exact: true }),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(async () => {
      const inventory = await (
        await authenticatedE2EFetch(`${api}/api/plugins`)
      ).json();
      return inventory.plugins.find((entry: any) => entry.name === plugin)
        ?.installationReadiness?.state;
    })
    .toBe('ready');
  await expect(
    page
      .locator('.detail-panel')
      .getByRole('button', { name: 'Remove', exact: true }),
  ).toBeVisible();
  await expect(
    observer
      .locator('.detail-panel')
      .getByRole('button', { name: 'Remove', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('recovery-ready-390.png'),
    animations: 'disabled',
  });
  copyFileSync(
    testInfo.outputPath('recovery-ready-390.png'),
    join(recoveryEvidenceRoot, 'recovery-ready-390.png'),
  );
  await observer.setViewportSize({ width: 1280, height: 900 });
  await observer.screenshot({
    path: testInfo.outputPath('recovery-ready-1280.png'),
    animations: 'disabled',
  });
  copyFileSync(
    testInfo.outputPath('recovery-ready-1280.png'),
    join(recoveryEvidenceRoot, 'recovery-ready-1280.png'),
  );
  await observer.close();
  writeFileSync(
    join(recoveryEvidenceRoot, 'recovery-receipt.json'),
    JSON.stringify(
      {
        plugin,
        success: recoveryReceipt.success,
        configurationActivation: recoveryReceipt.configurationActivation,
        otherClientConverged: true,
      },
      null,
      2,
    ),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/projects/${slug}/layouts/coding`);
  const bar = page.getByRole('region', {
    name: 'Workspace actions',
    exact: true,
  });
  await expect(bar).toBeVisible({ timeout: 20_000 });
  const hostStyles = await bar.evaluate((element) => {
    const controls = element.querySelector(
      '.workspace-host-actions__controls',
    )!;
    const select = element.querySelector('select')!;
    return {
      bar: {
        padding: getComputedStyle(element).padding,
        background: getComputedStyle(element).backgroundColor,
      },
      controls: {
        display: getComputedStyle(controls).display,
        gap: getComputedStyle(controls).gap,
      },
      select: {
        background: getComputedStyle(select).backgroundColor,
        color: getComputedStyle(select).color,
      },
      stylesheets: [...document.styleSheets].map((sheet) => ({
        href: sheet.href,
        disabled: sheet.disabled,
      })),
    };
  });
  writeFileSync(
    join(recoveryEvidenceRoot, 'host-style-diagnostic.json'),
    JSON.stringify({ ...hostStyles, cssResponses }, null, 2),
  );
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(
    page.getByText('HOST-ACTION-README.md', { exact: true }).first(),
  ).toBeVisible();

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
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(button).toBeDisabled();
    await expect(
      page.getByText('HOST-ACTION-README.md', { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText('This host does not support this pane.', { exact: true }),
    ).toBeHidden();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`host-actions-files-${width}.png`),
      animations: 'disabled',
    });
    copyFileSync(
      testInfo.outputPath(`host-actions-files-${width}.png`),
      join(recoveryEvidenceRoot, `host-actions-files-${width}.png`),
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });
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
    page
      .locator(
        '#chat-dock .message.assistant, #chat-workspace-pane .message.assistant',
      )
      .filter({ hasText: 'HOST_ACTION_BROWSER_1372' })
      .last(),
  ).toBeVisible();
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
    animations: 'disabled',
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
