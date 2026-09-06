import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/authenticated-request';
import { waitForLocalUiAccessReadiness } from './helpers/local-ui-access-readiness';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'station-dogfood:latest';
const REPLY = 'First live Station chat works on mobile.';

test.use({ actionTimeout: 15_000 });

// archive#1628: a short, dedicated desktop check that a fresh temp-home server
// boots to Home's zero-project empty state with no dead end — deliberately
// not a full chat round-trip (no ollama fixture) so the 'first-run' bucket's
// weight budget is not meaningfully increased. Declared BEFORE the mobile
// test below: both tests share one real temp-home server for the whole
// file/bucket (see run-e2e-suite.mjs), and the mobile test durably
// configures a real Ollama provider partway through its own journey — this
// test must observe the still-pristine zero-provider/zero-project boot
// state, which only holds before that mutation happens.
test('desktop first run boots to a coherent zero-project Home view', async ({
  baseURL,
  page,
  authenticatedRequest,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  if (!baseURL) throw new Error('First-run suite requires a UI base URL');

  await page.goto(baseURL);
  // The launcher is reachable on the FIRST click now. The usage-telemetry
  // disclosure used to render over it — `OnboardingGate` mounts it after its
  // children, so it lands on top of whatever else is up — and this spec had to
  // find and answer it before it could touch anything. On a `pending` home
  // that modal is not mounted at all; the disclosure is a step of the run,
  // below.
  await expect(page.getByTestId('setup-launcher')).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByTestId('usage-telemetry-disclosure-modal'),
  ).toHaveCount(0);
  const initialProjects = (await (
    await authenticatedRequest.get('/api/projects')
  ).json()) as { success: boolean; data: unknown[] };
  expect(initialProjects.data).toEqual([]);

  await page.getByRole('button', { name: 'Continue Without Setup' }).click();

  // UX audit RT-02, live and un-intercepted: this home was created by this
  // run, so its `config/app.json` genuinely carries `firstRun: {status:
  // 'pending'}` and the guided chapter opens on Home — the exact case the old
  // `sawSetupLauncher` rule failed, twice, on a machine with a CLI installed.
  // Nothing here patches a route; the only reason the chapter is on screen is
  // what the server wrote when it made this home.
  // STEP ONE IS THE DISCLOSURE, and it is the only thing on screen — the real
  // server's real inventory, in the chapter's own dialog, with no second modal
  // over it. Acknowledging goes to the real
  // `/api/usage-telemetry/disclosure/acknowledgements` on this home.
  const disclosure = page.getByTestId('first-run-disclosure');
  await expect(disclosure).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Step 1 of 4')).toBeVisible();
  await expect(
    page.getByTestId('usage-telemetry-disclosure-modal'),
  ).toHaveCount(0);
  await expect(page.locator('.responsive-surface-overlay')).toHaveCount(1);
  await disclosure
    .getByRole('button', { name: 'Keep usage telemetry on' })
    .click();

  const chapter = page.getByTestId('first-run-engines');
  await expect(chapter).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Step 2 of 4')).toBeVisible();
  // Same archive#3656 shell move as tests/first-run-engines.spec.ts — the `main`
  // landmark is the shell's, Home is a `section` inside it (archive#3877).
  await expect(
    page.locator('main.main-content .home-view .first-run-engines'),
  ).toHaveCount(1);

  // Deferring is a decision, and it is written down: the chapter closes, Home
  // keeps the card that offers it, and a reload does not re-open it.
  await chapter.getByRole('button', { name: 'Not now' }).click();
  await expect(chapter).toHaveCount(0);
  await expect(page.getByTestId('first-run-home-card')).toBeVisible();

  // Polled: the write is deliberately fire-and-forget — closing the chapter is
  // the user's decision and does not wait on the network — so an immediate read
  // can beat it.
  await expect
    .poll(
      async () => {
        const payload = (await (
          await authenticatedRequest.get('/config/app')
        ).json()) as { data?: { firstRun?: { status?: string } } };
        return payload.data?.firstRun?.status;
      },
      { timeout: 10_000 },
    )
    .toBe('skipped');

  await page.reload();
  await expect(page.getByTestId('first-run-home-card')).toBeVisible({
    timeout: 20_000,
  });
  await expect(chapter).toHaveCount(0);
  // This home is no longer `pending`, so the standalone modal is mounted again
  // — and stays silent, because the receipt written above is what stops it
  // coming back. Placement decides WHERE the disclosure is made; the receipt
  // still decides whether it is made at all.
  await expect(
    page.getByTestId('usage-telemetry-disclosure-modal'),
  ).toHaveCount(0);

  // The run was DEFERRED, so this home has no Agent to chat with — and since
  // archive#3627 Home says so rather than recommending one. The card used to
  // read "Start direct chat" unconditionally over `flatList[0]`, which on a
  // fresh home named an Agent the New Chat picker one click away flagged "Not
  // set up". Asserting the old label here would be asserting that
  // contradiction back into place.
  const startAgent = page.getByRole('button', { name: /Set up an agent/i });
  const openLocalProject = page.getByRole('button', {
    name: /Open local project/i,
  });
  await expect(startAgent).toBeVisible();
  await expect(startAgent).toBeEnabled();
  await expect(
    page.getByRole('button', { name: /Start direct chat/i }),
  ).toHaveCount(0);
  await expect(openLocalProject).toBeVisible();
  await expect(openLocalProject).toBeEnabled();

  await expect(page.getByText(/^Error:/)).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test('phone first run recovers from no provider to a real streamed reply', async ({
  baseURL,
  page,
  authenticatedRequest,
}) => {
  test.setTimeout(90_000);

  let ollamaServer: Server | null = null;
  const chatRequests: unknown[] = [];

  try {
    if (!baseURL) throw new Error('First-run suite requires a UI base URL');

    const ollama = await startOllamaFixture(
      MODEL,
      (body) => chatRequests.push(body),
      REPLY,
    );
    ollamaServer = ollama.server;

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseURL);
    await expect(page.getByTestId('setup-launcher')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText('Choose what powers Station', { exact: true }),
    ).toBeVisible();
    const initialStatus = (await (
      await authenticatedRequest.get('/api/system/status')
    ).json()) as { providers?: { configuredChatReady?: boolean } };
    expect(initialStatus.providers?.configuredChatReady).toBe(false);
    // archive#1628: a fresh temp-home server must not have seeded a phantom
    // `Default` project — the direct proof that runStartupMigrations did
    // not create anything, at the E2E layer rather than just the unit layer.
    const initialProjects = (await (
      await authenticatedRequest.get('/api/projects')
    ).json()) as { success: boolean; data: unknown[] };
    expect(initialProjects.data).toEqual([]);
    await page.getByRole('button', { name: 'Continue Without Setup' }).click();

    const chapter = page.getByTestId('first-run-engines');
    const firstRunStatus = (await (
      await authenticatedRequest.get('/config/app')
    ).json()) as { data?: { firstRun?: { status?: string } } };
    if (firstRunStatus.data?.firstRun?.status === 'pending') {
      const disclosure = page.getByTestId('first-run-disclosure');
      await expect(disclosure).toBeVisible();
      await disclosure
        .getByRole('button', { name: 'Keep usage telemetry on' })
        .click();
      await expect(chapter).toBeVisible();
      await chapter.getByRole('button', { name: 'Not now' }).click();
      await expect
        .poll(
          async () => {
            const payload = (await (
              await authenticatedRequest.get('/config/app')
            ).json()) as { data?: { firstRun?: { status?: string } } };
            return payload.data?.firstRun?.status;
          },
          { timeout: 10_000 },
        )
        .toBe('skipped');
    } else {
      expect(firstRunStatus.data?.firstRun?.status).toBe('skipped');
      await expect(chapter).toHaveCount(0);
    }
    await page.getByRole('button', { name: /Open local project/i }).click();

    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toBeVisible();
    await page
      .locator('input[placeholder="/path/to/project"]')
      .fill(`${REPO_ROOT}/`);
    await page
      .locator('input[placeholder="My Project"]')
      .fill('Mobile Dogfood');
    await expect(page.getByRole('button', { name: /Coding/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/mobile-dogfood$/);

    await page.evaluate(() => {
      sessionStorage.setItem(
        'activeChats',
        JSON.stringify([
          {
            sessionId: 'first-run-empty',
            agentSlug: 'station',
            projectSlug: 'mobile-dogfood',
            projectName: 'Mobile Dogfood',
          },
        ]),
      );
    });
    await page.goto(
      `${baseURL}/projects/mobile-dogfood/layouts/coding?dock=open&chat=first-run-empty`,
    );
    await waitForLocalUiAccessReadiness(page);

    // Chat remains the independent dock beside the Workspace Pane host. The
    // route opens the named session directly; no workspace tab owns it.
    const chatDock = page.getByRole('region', { name: 'Chat dock' });
    await expect(chatDock).toBeVisible();
    const emptyState = chatDock.getByTestId('chat-empty-state-unconfigured');
    await expect(emptyState).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Error:/)).toHaveCount(0);
    // Dismissing first-run is durable. Recovery remains available where it is
    // relevant without covering the project workspace with the launcher again.
    await expect(page.getByTestId('setup-launcher')).toHaveCount(0);
    await emptyState.getByRole('button', { name: 'Open Connections' }).click();
    await expect(page).toHaveURL(/\/connections\/models(?:\?|$)/);

    // archive#3733 gave every Connections section ONE add action, named for what it
    // adds; the picker it opens is a route now, not a dialog (archive#3877 —
    // same structural staleness, a different shipped change).
    await page.getByRole('button', { name: 'Add model connection' }).click();
    await expect(page).toHaveURL(/\/connections\/models\/new(?:\?|$)/);
    // Scope inside the picker — the background stack overview also renders an
    // Ollama quickstart entry.
    await page
      .locator('.provider-picker-modal')
      .getByRole('button', { name: /^Ollama/ })
      .first()
      .click();
    await page.getByLabel('Name').fill('First Run Ollama');
    await page.getByLabel('Base URL').fill(ollama.origin);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/connections\/models\/[^/?]+(?:\?|$)/);
    await page.getByRole('button', { name: 'Test Connection' }).click();
    await expect(page.getByText('Connection healthy')).toBeVisible();

    await expect
      .poll(async () => {
        const response = await authenticatedRequest.get('/api/system/status');
        const status = (await response.json()) as {
          providers?: { configuredChatReady?: boolean };
        };
        return status.providers?.configuredChatReady;
      })
      .toBe(true);

    await page.goto(
      `${baseURL}/projects/mobile-dogfood/layouts/coding?dock=open`,
    );
    // archive#3309 pulled New chat out of the "Chat actions" overflow to a
    // pinned far-right header icon; #1512 deleted that icon from
    // `ChatDockMobileHeader` and handed `onNewChat` to the sheet again, so on a
    // phone the sheet is where the affordance now is (#1606).
    // Assert it there, then open the selection surface via the deterministic
    // event — clicking the item takes the one-click direct path whenever
    // exactly one runtime is chat-ready, which is this fixture once the Ollama
    // connection above is healthy, and this live spec must land on the picker
    // to choose `station` by id (same pattern as
    // new-chat-mobile-context-sheet.spec.ts's openNewChat).
    const chatActions = page.getByRole('button', {
      name: 'Chat actions',
      exact: true,
    });
    await expect(chatActions).toBeVisible({ timeout: 20_000 });
    await chatActions.click();
    const chatActionsMenu = page.getByRole('menu', { name: 'Chat actions' });
    // The sheet is a lazily imported chunk (`ChatDockMobileOverflowSheet`,
    // kept out of the entry bundle), so its FIRST open is a module fetch that
    // renders nothing while it is in flight. Playwright's 5s expect default is
    // not a budget for that on a loaded host — observed pending at 5s with the
    // trigger already `aria-expanded`.
    await expect(chatActionsMenu).toBeVisible({ timeout: 15_000 });
    await expect(
      chatActionsMenu.getByRole('menuitem', { name: 'New chat', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    // The picker must open over a closed sheet, not under its overlay.
    await expect(chatActionsMenu).toHaveCount(0);
    await page.evaluate(() =>
      window.dispatchEvent(new Event('station:open-new-chat')),
    );
    // The row also contains an engine chip, so rendered text is not a unique
    // identity. Select the stable agent id exposed by the picker instead.
    const stationAgent = page.locator(
      '.new-chat-modal__agent[data-agent-slug="station"]',
    );
    await expect(stationAgent).toBeVisible({ timeout: 20_000 });
    await stationAgent.click();
    const currentChat = new URL(page.url()).searchParams.get('chat');
    expect(currentChat).toBeTruthy();
    const taskSwitcher = page.getByRole('button', { name: 'Switch task' });
    await taskSwitcher.click();
    const taskDialog = page.getByRole('dialog', { name: 'Switch task' });
    await expect(taskDialog).toBeVisible({ timeout: 20_000 });
    const taskRows = taskDialog.locator('.chat-dock-inbox__item');
    await expect(taskRows).toHaveCount(2);
    await expect(
      taskDialog.locator('.chat-dock-inbox__item[aria-current="true"]'),
    ).toHaveCount(1);
    const currentTaskIndex = await taskRows.evaluateAll((rows) =>
      rows.findIndex((row) => row.getAttribute('aria-current') === 'true'),
    );
    expect(currentTaskIndex).toBeGreaterThanOrEqual(0);
    await taskDialog
      .locator('.chat-dock-inbox__item:not([aria-current="true"])')
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('chat'))
      .not.toBe(currentChat);
    await taskSwitcher.click();
    await taskRows.nth(currentTaskIndex).click();
    await taskSwitcher.click();
    await expect(taskRows.nth(currentTaskIndex)).toHaveAttribute(
      'aria-current',
      'true',
    );
    await taskDialog
      .getByRole('button', { name: 'Close task switcher' })
      .click();

    const composer = page.locator('textarea[placeholder*="Type a message"]');
    await expect(composer).toBeVisible();
    await composer.fill('Confirm the live first-run path');
    await expect(composer).toHaveValue('Confirm the live first-run path');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => chatRequests.length).toBe(1);
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0]).toMatchObject({
      model: MODEL,
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Confirm the live first-run path'),
        }),
      ]),
    });

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await closeFixtureServer(ollamaServer);
  }
});
