/**
 * #2995 — the layout contract fields are honoured generically.
 *
 * One set of assertions, run against built-in Coding and against a test-only
 * plugin layout (`tests/fixtures/layout-stack-parity`, installed through the
 * real preview, consent and install API) that declares `primary: 'chat'`,
 * `presentation: 'stack'` and two drill-ins. Both must behave the same: the
 * dock's Chat is suspended, ⌘D focuses the layout's Chat, the breadcrumb and
 * the icon rail drill in, and Back pops the stack.
 *
 * Nothing is intercepted: a real Station, a real installed plugin, the real
 * layout read that states the declaration, the real pane catalog.
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
import { expect, type Page, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';

const api = resolveE2EApiBase();
const projectSlug = 'layout-stack-parity';
const PLUGIN = 'stack-fx';
const evidenceRoot = join(
  process.cwd(),
  '.kontourai',
  'layout-stack-parity',
  basename(process.env.STATION_E2E_OUTPUT_DIR ?? 'manual'),
);

interface Subject {
  name: string;
  layoutSlug: string;
  /** The stack's navigation landmark. */
  navigation: string;
  /** Two of its drill-ins, by their rail names. */
  first: string;
  second: string;
  /** Text the first drill-in renders once it is the page. */
  firstContent: string;
}

const subjects: Subject[] = [
  {
    name: 'built-in Coding',
    layoutSlug: 'coding',
    navigation: 'Coding navigation',
    first: 'Files',
    second: 'Diff',
    firstContent: 'PARITY-README.md',
  },
  {
    name: 'the fixture plugin layout',
    layoutSlug: 'fx',
    navigation: 'Stack Parity navigation',
    first: 'Parity notes',
    second: 'Parity checks',
    firstContent: 'Parity notes drill-in',
  },
];

let workspaceDir = '';

async function removeProject() {
  const response = await authenticatedE2EFetch(
    `${api}/api/projects/${projectSlug}`,
    { method: 'DELETE' },
  );
  if (response.status !== 404) expect(response.ok).toBe(true);
}

async function removePlugin() {
  const response = await authenticatedE2EFetch(
    `${api}/api/registry/plugins/${PLUGIN}`,
    { method: 'DELETE' },
  );
  if (response.status !== 404) expect(response.ok).toBe(true);
}

async function applyLayout(layoutId: string): Promise<void> {
  const response = await authenticatedE2EFetch(
    `${api}/api/projects/${projectSlug}/layouts/apply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layoutId }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(201);
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Views' });
const railItem = (page: Page, name: string) =>
  rail(page).getByRole('button', {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|$)`),
  });
const chatPage = (page: Page) => page.locator('.coding-workbench__page--chat');
const drillInPage = (page: Page) =>
  page.locator('.coding-workbench__page--drill-in');
const centreChat = (page: Page) => page.locator('#chat-workspace-pane');
const crumbs = (page: Page, subject: Subject) =>
  page
    .getByRole('navigation', { name: subject.navigation })
    .getByRole('list', { name: 'Breadcrumb' });

test.describe('layout contract fields: built-in Coding and a plugin layout behave alike (#2995)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.use({ viewport: { width: 1180, height: 800 } });

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    await removeProject();
    await removePlugin();
    const installed = await installPluginWithConsent(
      api,
      resolve('tests/fixtures/layout-stack-parity'),
    );
    expect(installed.success, JSON.stringify(installed)).toBe(true);

    workspaceDir = mkdtempSync(join(tmpdir(), 'station-layout-stack-parity-'));
    writeFileSync(
      join(workspaceDir, 'PARITY-README.md'),
      '# Parity\nThe workspace the built-in Coding Files pane lists.\n',
    );
    const project = await authenticatedE2EFetch(`${api}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Layout Stack Parity',
        slug: projectSlug,
        workingDirectory: workspaceDir,
      }),
    });
    expect(project.status, await project.clone().text()).toBe(201);
    await applyLayout('builtin:coding');
    await applyLayout(`plugin:${PLUGIN}:fx`);

    // The read states the declaration each host is chosen by; the fixture's
    // claim stands because its plugin was granted `layout.primaryChat`.
    for (const subject of subjects) {
      const read = await authenticatedE2EFetch(
        `${api}/api/projects/${projectSlug}/layouts/${subject.layoutSlug}`,
      );
      expect(read.ok).toBe(true);
      expect((await read.json()).data).toMatchObject({
        primary: 'chat',
        presentation: 'stack',
      });
    }
  });

  test.afterAll(async () => {
    await removeProject();
    await removePlugin();
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
  });

  for (const subject of subjects) {
    test(`${subject.name}: Chat is the centre, the dock's Chat is suspended, and the stack drills in and pops`, async ({
      page,
    }, testInfo) => {
      const mac = process.platform === 'darwin';
      const primary = mac ? 'Meta' : 'Control';

      // Control: off the layout, the dock's Chat is the ambient one.
      await page.goto(`/projects/${projectSlug}`);
      await expect(page.locator('#chat-dock')).toHaveCount(1, {
        timeout: 30_000,
      });

      await page.goto(`/projects/${projectSlug}/layouts/${subject.layoutSlug}`);
      await expect(chatPage(page)).toHaveAttribute('data-active', 'true', {
        timeout: 30_000,
      });
      await expect(centreChat(page)).toBeVisible();
      // One Chat controller: the layout's centre, and no dock Chat.
      await expect(page.locator('#chat-workspace-pane')).toHaveCount(1);
      await expect(page.locator('#chat-dock')).toHaveCount(0);
      await expect(
        page.getByRole('navigation', { name: subject.navigation }),
      ).toBeVisible();
      await expect(railItem(page, subject.first)).toBeVisible({
        timeout: 30_000,
      });
      await expect(railItem(page, subject.second)).toBeVisible();
      await expect(rail(page).locator('[aria-current="page"]')).toHaveCount(0);

      mkdirSync(evidenceRoot, { recursive: true });
      const landing = `${subject.layoutSlug}-chat.png`;
      await page.screenshot({
        path: testInfo.outputPath(landing),
        animations: 'disabled',
      });
      copyFileSync(testInfo.outputPath(landing), join(evidenceRoot, landing));

      // The rail drills in: the pane is the page, named in the breadcrumb.
      await railItem(page, subject.first).click();
      await expect(drillInPage(page)).toHaveAttribute('data-active', 'true');
      await expect(railItem(page, subject.first)).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page).toHaveURL(/[?&]pane=/);
      await expect(
        crumbs(page, subject).getByRole('listitem').last(),
      ).toHaveText(subject.first);
      await expect(
        drillInPage(page).getByText(subject.firstContent).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(centreChat(page)).toBeHidden();
      const drilled = `${subject.layoutSlug}-drill-in.png`;
      await page.screenshot({
        path: testInfo.outputPath(drilled),
        animations: 'disabled',
      });
      copyFileSync(testInfo.outputPath(drilled), join(evidenceRoot, drilled));

      // Back pops the stack to Chat — the browser's Back…
      await page.goBack();
      await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
      await expect(centreChat(page)).toBeVisible();
      await expect(page).not.toHaveURL(/[?&]pane=/);
      // …and the stack's own chord.
      await railItem(page, subject.second).click();
      await expect(drillInPage(page)).toHaveAttribute('data-active', 'true');
      await expect(
        crumbs(page, subject).getByRole('listitem').last(),
      ).toHaveText(subject.second);
      await page.evaluate(() =>
        (document.activeElement as HTMLElement)?.blur(),
      );
      await page.keyboard.press(mac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft');
      await expect(chatPage(page)).toHaveAttribute('data-active', 'true');

      // ⌘D from a drill-in returns to the layout's Chat page and never opens
      // the dock's Chat.
      await railItem(page, subject.first).click();
      await expect(drillInPage(page)).toHaveAttribute('data-active', 'true');
      await page.evaluate(() =>
        (document.activeElement as HTMLElement)?.blur(),
      );
      await page.keyboard.press(`${primary}+KeyD`);
      await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
      // The chord went to the layout's Chat (`requestCenterChatPage`), not
      // to the dock: no dock Chat appeared. A fresh Project has no open
      // conversation, so there is no composer to focus here; composer focus
      // is pinned with a seeded conversation in coding-stack-navigation.
      await expect(centreChat(page)).toBeVisible();
      await expect(page.locator('#chat-dock')).toHaveCount(0);
    });
  }
});
