/**
 * Related panes from a plugin running in Station's sandboxed plugin frame
 * (docs/design/pane-relationships.md): the `related-reports` example, built
 * and installed through real preview and consent, on a Station this spec
 * owns, reached under a non-loopback name. A browser reaching a Station that
 * way runs every plugin in the isolated frame, never in the page, so the
 * list, the report it opens and the tool all run as frame documents, and
 * every request crosses the frame bootstrap to the same host a direct pane
 * calls.
 *
 * The name resolves to this machine through Chromium's host resolver, and the
 * spec's Station allows it as a browser origin; it is treated as a secure
 * context, as an https remote Station is. The browser is connected the way
 * the suite's own browser is, as the Station's operator: a saved connection
 * holding the operator credential, beside the session the Station's one-time
 * UI bootstrap token exchanges for. Nothing is mocked: the plugin catalog,
 * its visibility, the frame server and the bundle bytes are the Station's.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type Browser,
  chromium,
  expect,
  type FrameLocator,
  type Page,
  test,
} from '@playwright/test';
import { issueE2EBrowserSession } from '../scripts/run-e2e-suite.mjs';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { buildE2EBrowserStorageState } from './helpers/e2e-browser-storage-state';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
import {
  buildExamplePlugin,
  installPluginWithConsent,
} from './helpers/install-plugin';
import {
  allocateLiveStation,
  type LiveStation,
  startStation,
  stationRootForLiveHome,
  stopStation,
} from './helpers/live-station-task';

const REMOTE_HOST = 'station-remote.test';
const pluginDir = resolve('examples/related-reports');
const projectSlug = 'related-panes-frame';
const reportsDescriptor = 'pane:plugin%3Arelated-reports:reports';

let live: LiveStation | null = null;
let browser: Browser | null = null;
let remoteUi = '';
let reportsRoute = '';
let workspaceDir = '';
let stationEnv: NodeJS.ProcessEnv = {};
let storageState: ReturnType<typeof buildE2EBrowserStorageState>;
let passed = false;

/**
 * The launched Station sees only its own home: the suite's Station settings
 * and temporary-directory overrides are not inherited.
 */
function sanitizedLaunchEnvironment(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key.startsWith('STATION_') ||
      key === 'TMPDIR' ||
      key === 'TMP' ||
      key === 'TEMP'
    )
      continue;
    clean[key] = value;
  }
  return {
    ...clean,
    STATION_LOG_LEVEL: 'error',
    OTEL_SDK_DISABLED: 'true',
    AWS_EC2_METADATA_DISABLED: 'true',
  };
}

/** The plugin's own document inside the frame Station mounts for a pane. */
function pluginFrame(page: Page, component: string): FrameLocator {
  return page
    .frameLocator(`iframe[title="Plugin: ${component}"]`)
    .frameLocator('iframe[title="Plugin"]');
}

test.describe('related panes from a plugin in the sandboxed frame', () => {
  test.describe.configure({ mode: 'serial', timeout: 420_000 });

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(420_000);
    live = await allocateLiveStation('station-related-frame-', 'related-frame');
    remoteUi = `http://${REMOTE_HOST}:${live.uiPort}`;
    const bootstrapToken = await startStation(live, true, {
      logFile: testInfo.outputPath(`${live.instance}.log`),
      environment: {
        ...sanitizedLaunchEnvironment(),
        ALLOWED_ORIGINS: remoteUi,
      },
    });
    const operatorCredential = readE2EOperatorCredential(live.home);
    stationEnv = {
      ...process.env,
      PW_API_BASE_URL: live.api,
      PW_BASE_URL: live.ui,
      STATION_E2E_HOST_CREDENTIAL: operatorCredential,
    };
    storageState = buildE2EBrowserStorageState({
      baseURL: remoteUi,
      establishedUser: true,
      browserSessionCredential: await issueE2EBrowserSession({
        uiPort: live.uiPort,
        token: bootstrapToken,
      }),
      operatorCredential,
      runnerOwned: true,
    });

    buildExamplePlugin(pluginDir);
    const installed = await installPluginWithConsent(live.api, pluginDir, {
      env: stationEnv,
    });
    expect(installed.success).toBe(true);

    workspaceDir = mkdtempSync(join(tmpdir(), 'station-related-frame-'));
    const created = await authenticatedE2EFetch(
      `${live.api}/api/projects`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Related Panes Frame',
          slug: projectSlug,
          workingDirectory: workspaceDir,
        }),
      },
      stationEnv,
    );
    expect(created.status).toBe(201);
    const catalogResponse = await authenticatedE2EFetch(
      `${live.api}/api/projects/${projectSlug}/panes`,
      {},
      stationEnv,
    );
    expect(catalogResponse.ok).toBe(true);
    const catalog = (
      (await catalogResponse.json()) as {
        data: {
          instances: Array<{ instanceId: string; descriptorId: string }>;
        };
      }
    ).data;
    const occurrence = catalog.instances.find(
      (instance) => instance.descriptorId === reportsDescriptor,
    );
    expect(occurrence, 'the Project issues a Reports occurrence').toBeDefined();
    reportsRoute = `/projects/${projectSlug}/panes/${encodeURIComponent(reportsDescriptor)}/${encodeURIComponent(occurrence!.instanceId)}`;

    // The full Chromium build: the headless shell ignores the flag that makes
    // this origin a secure context, and a related open needs one (it commits
    // under an exclusive Web Lock, which only a secure context has).
    browser = await chromium.launch({
      channel: 'chromium',
      args: [
        `--host-resolver-rules=MAP ${REMOTE_HOST} 127.0.0.1`,
        `--unsafely-treat-insecure-origin-as-secure=${remoteUi}`,
      ],
    });
  });

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(180_000);
    await browser?.close();
    try {
      if (live) await stopStation(live);
    } finally {
      if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
      // A failed run keeps the Station's home for diagnosis.
      if (live && passed)
        rmSync(stationRootForLiveHome(live.home), {
          recursive: true,
          force: true,
        });
    }
  });

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
  test('opens, replaces, focuses and closes its own report panes, and opens a tool, all from frames', async ({}, testInfo) => {
    if (!browser || !live) throw new Error('the spec Station did not start');
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      storageState,
    });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (error) =>
      problems.push(`pageerror: ${error.message}`),
    );
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning')
        problems.push(`${message.type()}: ${message.text()}`);
    });
    try {
      await page.goto(`${remoteUi}${reportsRoute}`);

      const reports = pluginFrame(page, 'reports').getByRole('region', {
        name: 'Related reports',
      });
      await expect(
        reports.getByRole('heading', { name: 'Reports' }),
      ).toBeVisible({ timeout: 60_000 });
      // The frame tier: the plugin draws in its frame, never in the page.
      await expect(
        page.getByRole('region', { name: 'Related reports' }),
      ).toHaveCount(0);
      const status = reports.getByRole('status');

      await test.step('a report opens beside the list, as its own frame', async () => {
        await reports
          .getByRole('button', { name: 'Open Weekly report', exact: true })
          .click();
        await expect(status).toHaveText('Weekly report: opened, beside.');
        await expect(
          pluginFrame(page, 'report').getByRole('article', {
            name: 'Weekly report',
          }),
        ).toContainText('Seven days of work, summarised.', {
          timeout: 30_000,
        });
        await expect(
          page.getByRole('button', { name: 'Up to Reports', exact: true }),
        ).toBeVisible();
      });

      await test.step('another report replaces the preview; the same one focuses it', async () => {
        await reports
          .getByRole('button', { name: 'Open Monthly report', exact: true })
          .click();
        await expect(status).toHaveText('Monthly report: replaced, beside.');
        await expect(
          pluginFrame(page, 'report').getByRole('article', {
            name: 'Monthly report',
          }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          page.locator('iframe[title="Plugin: report"]'),
        ).toHaveCount(1);
        await reports
          .getByRole('button', { name: 'Open Monthly report', exact: true })
          .click();
        await expect(status).toHaveText('Monthly report: focused, beside.');
      });

      await test.step('the list closes what it opened', async () => {
        await reports
          .getByRole('button', { name: 'Close report', exact: true })
          .click();
        await expect(status).toHaveText('Report closed.');
        await expect(
          page.locator('iframe[title="Plugin: report"]'),
        ).toHaveCount(0);
      });

      await test.step('a tool lands with the Tools', async () => {
        await reports
          .getByRole('button', { name: 'Open report log', exact: true })
          .click();
        await expect(status).toHaveText('Report log: opened, tool.');
        await expect(
          pluginFrame(page, 'log').getByRole('region', { name: 'Report log' }),
        ).toBeVisible({ timeout: 30_000 });
      });
      for (const width of [1280, 390]) {
        await test.step(`Up from a frame report returns to its exact Project pane at ${width}px`, async () => {
          const returnPage = await context.newPage();
          try {
            await returnPage.setViewportSize({ width, height: 900 });
            await returnPage.goto(`${remoteUi}${reportsRoute}`);
            const source = pluginFrame(returnPage, 'reports').getByRole(
              'region',
              { name: 'Related reports' },
            );
            await expect(
              source.getByRole('heading', { name: 'Reports' }),
            ).toBeVisible({ timeout: 30_000 });
            await source
              .getByRole('button', { name: 'Open Weekly report', exact: true })
              .click();
            await expect(
              pluginFrame(returnPage, 'report').getByRole('article', {
                name: 'Weekly report',
              }),
            ).toContainText('Seven days of work, summarised.');
            if (width === 390) {
              await returnPage
                .getByRole('button', { name: 'Keep open', exact: true })
                .click();
              await returnPage.reload();
              await expect(
                pluginFrame(returnPage, 'report').getByRole('article', {
                  name: 'Weekly report',
                }),
              ).toContainText('Seven days of work, summarised.', {
                timeout: 30_000,
              });
              await expect(
                returnPage.getByRole('button', {
                  name: 'Back to Reports',
                  exact: true,
                }),
              ).toBeVisible();
            }
            await returnPage
              .getByRole('button', { name: 'Up to Reports', exact: true })
              .click();
            expect(new URL(returnPage.url()).pathname).toBe(reportsRoute);
            await expect(
              source.getByRole('heading', { name: 'Reports' }),
            ).toBeVisible();
            await returnPage.reload();
            await expect(
              source.getByRole('heading', { name: 'Reports' }),
            ).toBeVisible({ timeout: 30_000 });
          } finally {
            await returnPage.close();
          }
        });
      }
      passed = true;
    } finally {
      if (!passed) {
        // This page is the spec's own, not the runner's: keep its evidence.
        await page
          .screenshot({ path: testInfo.outputPath('frame-journey-failed.png') })
          .catch(() => {});
        await testInfo.attach('page-problems', {
          body: problems.join('\n') || '(none)',
          contentType: 'text/plain',
        });
        // What this browser, as paired, is offered: its own catalog and
        // plugin list, read through its own session.
        const offered = await page
          .evaluate(async (slug) => {
            const read = async (path: string) => {
              const response = await fetch(path, { credentials: 'include' });
              return `${path} ${response.status}\n${(await response.text()).slice(0, 6000)}`;
            };
            return [
              await read(`/api/projects/${slug}/panes`),
              await read('/api/plugins'),
              await read('/config/app'),
            ].join('\n\n');
          }, projectSlug)
          .catch((error: unknown) => String(error));
        await testInfo.attach('offered-to-browser', {
          body: offered,
          contentType: 'text/plain',
        });
      }
      await context.close();
    }
  });
});
