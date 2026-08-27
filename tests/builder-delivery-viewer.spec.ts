/** Serial live-plugin proof: published Builder artifacts remain unchanged by viewing. */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';
import { dismissSetupLauncher } from './helpers/orchestration';

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(projectDir, 'examples', 'builder-delivery-viewer');
const api = resolveE2EApiBase();
const plugin = 'builder-delivery-viewer';
const project = 'builder-viewer-e2e';
const secondProject = 'builder-viewer-e2e-second';
let workspace = '';
let secondWorkspace = '';
let before = '';
let secondBefore = '';

function digestTree(root: string) {
  const hash = createHash('sha256');
  const visit = (relativePath: string) => {
    const absolute = join(root, relativePath);
    const stat = lstatSync(absolute);
    const type = stat.isDirectory()
      ? 'directory'
      : stat.isSymbolicLink()
        ? 'symlink'
        : stat.isFile()
          ? 'file'
          : 'other';
    hash.update(`${relativePath}\0${type}\0${stat.mode}\0`);
    if (stat.isDirectory())
      for (const name of readdirSync(absolute).sort())
        visit(join(relativePath, name));
    else if (stat.isSymbolicLink()) hash.update(readlinkSync(absolute));
    else if (stat.isFile()) hash.update(readFileSync(absolute));
  };
  for (const relativePath of ['.kontourai/flow-agents', 'delivery']) {
    if (existsSync(join(root, relativePath))) visit(relativePath);
    else hash.update(`${relativePath}\0missing\0`);
  }
  return hash.digest('hex');
}
function validBundle() {
  const timestamp = '2026-07-19T00:00:00.000Z';
  const claim = (
    id: string,
    fieldOrBehavior: string,
    metadata: Record<string, unknown>,
  ) => ({
    id,
    subjectType: 'artifact',
    subjectId: 'repo:demo',
    facet: 'quality',
    claimType: 'quality.static-checks',
    fieldOrBehavior,
    value: 'pass',
    status: 'verified',
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata,
  });
  return {
    schemaVersion: 5,
    source: 'builder-viewer-e2e',
    claims: [
      claim('check', 'verify:static', { origin: 'check' }),
      claim('critique', 'review:work', { origin: 'critique' }),
      claim('gate', 'implementation-scope', { gate_claim: true }),
    ],
    evidence: [
      {
        id: 'check-evidence',
        claimId: 'check',
        evidenceType: 'test_output',
        method: 'validation',
        sourceRef: 'command:verify-static',
        excerptOrSummary: 'passed',
        observedAt: timestamp,
        collectedBy: 'station',
        passing: true,
      },
    ],
    policies: [],
    events: [],
  };
}
async function remove() {
  for (const slug of [project, secondProject])
    await authenticatedE2EFetch(`${api}/api/projects/${slug}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  await authenticatedE2EFetch(`${api}/api/plugins/${plugin}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}

test.describe('Builder Delivery Viewer plugin', () => {
  test.describe.configure({ mode: 'serial' });
  // The plugin build alone is allowed 120s below; Playwright's default 30s
  // hook timeout cut the whole beforeAll off well before that on a cold
  // tsx/esbuild cache. Budget the hook to cover its own declared build cap.
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    execSync('npx tsx ../../packages/cli/src/cli.ts plugin build', {
      cwd: pluginDir,
      timeout: 120_000,
      windowsHide: true,
    });
    await remove();
    workspace = mkdtempSync(join(tmpdir(), 'builder-viewer-e2e-'));
    const artifact = join(workspace, '.kontourai', 'flow-agents', 'demo');
    mkdirSync(artifact, { recursive: true });
    writeFileSync(
      join(artifact, 'state.json'),
      JSON.stringify({
        schema_version: '1.0',
        task_slug: 'demo',
        status: 'in_progress',
        phase: 'execution',
        updated_at: '2026-07-19T00:00:00Z',
        flow_run: {
          run_id: 'matched',
          definition_id: 'builder.build',
          definition_version: '1',
          status: 'in_progress',
          current_step: 'execution',
          run_ref: 'run:matched',
          open_gate_ids: [],
        },
        next_action: { status: 'continue', summary: 'run checks' },
      }),
    );
    writeFileSync(
      join(artifact, 'trust.bundle'),
      JSON.stringify(validBundle()),
    );
    const unmatched = join(workspace, '.kontourai', 'flow-agents', 'unmatched');
    mkdirSync(unmatched, { recursive: true });
    writeFileSync(
      join(unmatched, 'state.json'),
      JSON.stringify({
        schema_version: '1.0',
        task_slug: 'unmatched',
        status: 'in_progress',
        phase: 'execution',
        updated_at: '2026-07-18T00:00:00Z',
        flow_run: {
          run_id: 'not-present',
          definition_id: 'builder.build',
          definition_version: '1',
          status: 'in_progress',
          current_step: 'execution',
          run_ref: 'run:not-present',
          open_gate_ids: [],
        },
        next_action: { status: 'continue', summary: 'wait' },
      }),
    );
    writeFileSync(
      join(unmatched, 'acceptance.json'),
      JSON.stringify({
        schema_version: '1.0',
        task_slug: 'unmatched',
        criteria: [
          { id: 'honest', description: 'show unmatched', status: 'pass' },
        ],
        goal_fit: { status: 'pass', summary: 'fits' },
      }),
    );
    const bad = join(workspace, '.kontourai', 'flow-agents', 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'state.json'), '{invalid');
    const delivery = join(workspace, 'delivery', 'demo');
    mkdirSync(delivery, { recursive: true });
    for (const file of [
      'trust.bundle',
      'trust.checkpoint.json',
      'trust.checkpoint.intoto.json',
      'trust.checkpoint.sig.json',
      'trust.checkpoint.attestation.json',
    ])
      writeFileSync(join(delivery, file), '{}');
    writeFileSync(
      join(artifact, 'acceptance.json'),
      JSON.stringify({
        schema_version: '1.0',
        task_slug: 'demo',
        criteria: [
          {
            id: 'read-only',
            description: 'viewer cannot write',
            status: 'pass',
          },
        ],
        goal_fit: { status: 'pass', summary: 'fits' },
      }),
    );
    mkdirSync(join(artifact, 'additional-proof'), { recursive: true });
    writeFileSync(
      join(artifact, 'additional-proof', 'unchanged.txt'),
      'full-tree digest coverage',
    );
    before = digestTree(workspace);
    secondWorkspace = mkdtempSync(join(tmpdir(), 'builder-viewer-e2e-second-'));
    const secondArtifact = join(
      secondWorkspace,
      '.kontourai',
      'flow-agents',
      'second',
    );
    mkdirSync(secondArtifact, { recursive: true });
    writeFileSync(
      join(secondArtifact, 'state.json'),
      JSON.stringify({
        schema_version: '1.0',
        task_slug: 'second',
        status: 'in_progress',
        phase: 'execution',
        updated_at: '2026-07-20T00:00:00Z',
        flow_run: {
          run_id: 'second-run',
          definition_id: 'builder.build',
          definition_version: '1',
          status: 'in_progress',
          current_step: 'execution',
          run_ref: 'run:second',
          open_gate_ids: [],
        },
        next_action: { status: 'continue', summary: 'inspect error state' },
      }),
    );
    secondBefore = digestTree(secondWorkspace);
    expect((await installPluginWithConsent(api, pluginDir)).success).toBe(true);
    expect(
      (
        await (
          await authenticatedE2EFetch(`${api}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'Second Builder Viewer',
              slug: secondProject,
              workingDirectory: secondWorkspace,
            }),
          })
        ).json()
      ).success,
    ).toBe(true);
    expect(
      (
        await (
          await authenticatedE2EFetch(`${api}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'Builder Viewer',
              slug: project,
              workingDirectory: workspace,
            }),
          })
        ).json()
      ).success,
    ).toBe(true);
    expect(
      (
        await (
          await authenticatedE2EFetch(
            `${api}/api/projects/${secondProject}/layouts/from-plugin`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ plugin }),
            },
          )
        ).json()
      ).success,
    ).toBe(true);
    expect(
      (
        await (
          await authenticatedE2EFetch(
            `${api}/api/projects/${project}/layouts/from-plugin`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ plugin }),
            },
          )
        ).json()
      ).success,
    ).toBe(true);
  });
  test.afterAll(async () => {
    await remove();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    if (secondWorkspace)
      rmSync(secondWorkspace, { recursive: true, force: true });
  });
  test('grants plugin.server trusted access via host approval', async ({
    page,
  }) => {
    // serverModule routes are trusted-tier: install leaves `plugin.server`
    // pending consent, so the viewer's data fetch 403s until the host
    // approval flow runs. Same walk as fieldwork-review.spec.ts.
    await page.goto('/plugins');
    await dismissSetupLauncher(page);
    await page.getByText('Builder Delivery Viewer', { exact: true }).click();
    await page
      .getByRole('button', { name: /Review Permissions \(1\)/ })
      .click();
    await expect(
      page.getByText('plugin.server', { exact: true }),
    ).toBeVisible();

    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Review trusted access' }).click();
    const approvalPage = await popupPromise;
    // Bounded deliberately. This click is where the 2026-08-23 product baseline
    // hung for 30s per run: the whole approval walk up to here happens on the
    // main page, under whatever overlay a fresh home had open, and an unbounded
    // click turns that into a wall-clock test timeout that names nothing. The
    // bound makes the same failure report as a named action failure instead.
    await approvalPage
      .getByRole('button', { name: 'Approve trusted access' })
      .click({ timeout: 10_000 });
    await expect(
      approvalPage.getByRole('heading', { name: 'Approved' }),
    ).toBeVisible();
  });

  test('renders published trust, invalid artifacts, exact/unmatched joins, and changes no Builder or delivery bytes', async ({
    page,
  }) => {
    let releaseRuns: () => void = () => undefined;
    const runsReady = new Promise<void>((resolve) => {
      releaseRuns = resolve;
    });
    await page.route(`**/api/projects/${project}/flow/runs`, async (route) => {
      await runsReady;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              run_id: 'matched',
              definition_id: 'builder.build',
              subject: 'demo',
              status: 'in_progress',
              current_step: 'execution',
              updated_at: '2026-07-19T00:00:00Z',
            },
          ],
        }),
      });
    });
    await page.goto(`/projects/${project}/layouts/builder-delivery`);
    await expect(page.getByTestId('builder-delivery-viewer')).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: /demo in_progress/ }).click();
    await expect(page.getByRole('heading', { name: 'demo' })).toBeVisible();
    await expect(page.getByText('state: valid')).toBeVisible();
    await expect(
      page.getByText(
        'Flow runs are loading; join status is not evaluated yet.',
      ),
    ).toBeVisible();
    releaseRuns();
    await expect(
      page.getByText('Joined exactly to matched (in_progress).'),
    ).toBeVisible();
    await expect(page.locator('surface-trust-panel')).toBeVisible();
    await expect(
      page.locator('surface-trust-panel').getByText('Surface trust report'),
    ).toBeVisible();
    await expect(page.getByText('implementation-scope:')).toBeVisible();
    await expect(page.getByText('verify:static:')).toBeVisible();
    await expect(page.getByText('review:work:')).toBeVisible();
    await page.getByRole('button', { name: /unmatched/ }).click();
    await expect(
      page.getByText(/Not joinable: explicit run ID not-present/),
    ).toBeVisible();
    await page.getByRole('button', { name: /bad/ }).click();
    await expect(page.getByRole('heading', { name: 'bad' })).toBeVisible();
    await expect(
      page.getByText(/state: unavailable — artifact is invalid JSON/),
    ).toBeVisible();
    await page.route(`**/api/projects/${secondProject}/flow/runs`, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'proof failure' }),
      }),
    );
    await page.goto(`/projects/${secondProject}/layouts/builder-delivery`);
    await expect(page.getByRole('heading', { name: 'second' })).toBeVisible();
    await expect(
      page.getByText(/Flow runs unavailable; explicit run ID second-run/),
      // useFlowRunsQuery inherits react-query's default 3 retries with
      // exponential backoff, so the stubbed 500 only surfaces as an error
      // after ~7s — outlast the retry envelope, don't race it.
    ).toBeVisible({ timeout: 15_000 });
    expect(digestTree(workspace)).toBe(before);
    expect(digestTree(secondWorkspace)).toBe(secondBefore);
  });
});
