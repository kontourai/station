import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/authenticated-request';
import { LAZY_CHUNK_ALLOWANCE_MS } from './helpers/lazy-chunk-allowance';
import {
  countVisibleLazyBoundaryErrors,
  waitForLazySurface,
} from './helpers/lazy-surface-readiness';
import { waitForLocalUiAccessReadiness } from './helpers/local-ui-access-readiness';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';
import {
  FULL_SCREEN_ERROR_SELECTOR,
  fullScreenLoaderLabel,
  LAZY_BOUNDARY_ERROR_SELECTOR,
  PROJECT_LAYOUT_READINESS_TIMEOUT_MS,
  ROUTE_PENDING_STATUS_NAME,
  SETTLED_ERROR_STATE_SELECTOR,
  waitForRouteViewTarget,
} from './helpers/route-view-readiness';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'station-dogfood:latest';
const REPLY = 'First live Station chat works on mobile.';

/**
 * How long the streamed reply may take to appear.
 *
 * AN UNDEFENDED SAMPLE, and named so that the next reader knows it. It has been
 * 30 s since this spec was written and no record says why; deriving it properly
 * means bounding a real provider round trip through the runtime, which is its own
 * piece of work rather than a side effect of #1642. It is carried forward
 * unchanged here, labelled, instead of being quietly reused as if it were
 * evidence. #1697 says what would derive it — a label with no route to evidence
 * eventually reads as settled rather than unexamined, which is why it has one.
 *
 * Note that it now governs a PAIR: the poll below is derived as a relation to it,
 * so their combined worst case is twice this number.
 */
const STREAMED_REPLY_TIMEOUT_MS = 30_000;

/**
 * How long the Ollama fixture may take to record the outbound chat request.
 *
 * DERIVED AS A RELATION, which is the only honest derivation available: this
 * observes a Node-side array in the fixture, not the page, and nothing in the
 * interface derives "the outbound provider request has been received" — so there
 * is no state to wait on and no measurement to cite. What IS certain is the
 * ordering: the streamed reply cannot render before the request that produces it
 * has been received, so this wait can be given exactly the budget of the step it
 * precedes. It was running on the runner's implicit 5 s expect default, inside a
 * journey whose very next assertion is allowed 30 s — so a provider that answered
 * at 6 s failed here and was reported as "expected 1, received 0", which reads
 * like the request was never made.
 *
 * It DOES cost wall-clock, and an earlier version of this comment wrongly claimed
 * otherwise. The ordering means this wait resolves before the reply's own budget
 * starts, but the pair's worst case moves from 5 + 30 to 30 + 30 — a slow request
 * followed by a slow render is now 60 s rather than 35 s. `test.setTimeout` covers
 * that with room, and the alternative was failing correct runs, but "extends the
 * journey's reach by not a millisecond" was false and is the kind of claim this
 * branch exists to stop making.
 *
 * It hides nothing: a duplicate request is not this wait's to catch — it stops at
 * one — and `expect(chatRequests).toHaveLength(1)` after the reply is what holds
 * that line.
 */
const CHAT_REQUEST_RECORDED_TIMEOUT_MS = STREAMED_REPLY_TIMEOUT_MS;

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
  await expect(page.getByRole('dialog').filter({ has: chapter })).toBeVisible();

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
  // Measured, not guessed (#1617). On a host under sibling load this journey
  // spent 62.3 s reaching its last step — the streamed reply — with that step's
  // own 30 s budget still ahead, so 90 s could not cover a slow reply even
  // before the two waits below were widened to this file's 20 s (readiness
  // +10 s, the chat dock +15 s). 62 + 30 + 25 ≈ 117 s, rounded up.
  //
  // That arithmetic was derived when the readiness wait's own budget was 20 s, so
  // every later move of that budget is a term added to it. Carried forward as
  // arithmetic rather than as a new number, because the next person to move a step
  // budget has to recompute this and cannot do that from a total:
  //
  //   117 s  measured path (62.3) + last step's own budget (30) + the widening of
  //          this file's two waits to 20 s (readiness +10, chat dock +15)
  //   +13.4  readiness 20 -> 33.4 s (#1639: the gate got a bounded retry, so its
  //          worst case became a full ladder, the reload, and one more answer)
  //   +19.6  readiness 33.4 -> 53.0 s (#1661: each identity read now has the
  //          gate's own deadline instead of the proxy's 30 s, and the budget
  //          derives from those deadlines rather than scaling one 6.6 s sample)
  //   = 150 s of estimate, under a 170 s ceiling: 20 s of margin.
  //
  // ALL of the growth is the readiness step; no other step's budget has moved
  // since the 117 s figure was measured. The ceiling rose from 150 s for the last
  // term alone, and what that restores is the ABSOLUTE margin, not the fraction:
  // 19.6 s (13.1%) before, 20.0 s (11.8%) after. It buys back the seconds that
  // change consumes; it does not buy headroom.
  //
  // TWO INDEPENDENT INPUTS DECIDE THIS NUMBER, and recomputing from either one
  // alone lands somewhere else — worth saying because they arrived in the same
  // week from opposite directions and were resolved together here. #1642 settled
  // the SHAPE (the two paragraphs below): this is sized against the measured path,
  // not against the sum of declared budgets. #1661 moved one TERM: the readiness
  // step's own budget, the +19.6 above. Take the shape without the term and 150 s
  // still looks sufficient; take the term without the shape and a 330 s budget sum
  // reads as an argument for something far larger than 170 s. The ladder above is
  // what the two produce together, and neither half is redundant.
  //
  // This covers the measured path plus its last step. It is NOT a bound on the
  // sum of the steps: their declared budgets now total over 330 s (#1642 gave
  // four sites derived budgets and added waits on the layout gate this journey
  // passes through twice), so a run where several of them each spend theirs still
  // ends here. What it buys is that the ordinary slow-host failure arrives as the
  // failing assertion's own sentence rather than as a test timeout, which names
  // nothing. No individual budget is relaxed by this.
  //
  // Why the growing sum does not argue for a bigger number: those budgets are
  // spent only by a host that is genuinely still working, and after #1642 every
  // way the surfaces behind them FAIL is reported the moment it renders rather
  // than at the end of an allowance. A run that spends several of them in full is
  // a host in trouble, and the measured path — 62.3 s to the last step — is what
  // this timeout is sized against.
  //
  // Raising it to 170 s costs the same 20 s on a genuinely hung journey and
  // nothing else — and it cannot delay a real failure report, because the
  // readiness wait throws ITS own sentence when its own 53 s budget expires. That
  // wait is NOT the first step (server setup and navigation precede it), so the
  // slack between its sentence and this ceiling is whatever the journey has
  // already spent by then, not the difference between the two numbers.
  test.setTimeout(170_000);

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
    // #1642: wait on the LAYOUT, which is what decides whether this region
    // exists at all — `showAmbientChatDock` gates `RegionShells` on the layout
    // query, and `LayoutView` renders its own loader over the same fact. #1644
    // gave this site 20 s because that was the number the rest of the file used;
    // the captured failure it was fixing showed the layout loader still up
    // ("Compiling the good vibes…", `FullScreenLoader label="layout"`), so the
    // budget was right about the symptom and silent about the cause. Watching
    // the view's settled screens means a layout that 404s, errors, or resolves
    // to something unrenderable is reported by its own words at once, and the
    // budget below bounds only a layout read still in flight.
    await waitForRouteViewTarget(
      {
        viewName: 'The Coding layout view',
        target: chatDock,
        failures: [
          // "Failed to load layout", with its own Retry.
          page.locator(FULL_SCREEN_ERROR_SELECTOR),
          // "Layout not found", and the settled-but-unrenderable state beside it.
          page.locator(SETTLED_ERROR_STATE_SELECTOR),
        ],
        pending: [fullScreenLoaderLabel(page, 'layout')],
      },
      PROJECT_LAYOUT_READINESS_TIMEOUT_MS,
    );
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
    //
    // #1642: this is the site with real evidence, and the evidence says it was
    // never a missing control. Three independently retained failure captures show
    // the same page — `heading "Connections"` beside `status "Loading view"` — for
    // the whole 15 s action timeout, twice with the shell header reading "Can't
    // connect". The view had not mounted. The route needs TWO lazy chunks under
    // one Suspense boundary (`ConnectionsSectionFrame` and `ProviderSettingsView`,
    // both in `AppViewContent`), so a slow second chunk withholds the first one's
    // action too — and the URL and the "Connections" heading both settle OUTSIDE
    // that boundary, which is why every signal this step had was already green.
    //
    // Scoped to `.page__actions` with an exact name, as the other Connections
    // specs do: the picker route this click opens has a HEADING of the same name,
    // and an unscoped substring match is one product change away from ambiguity.
    const addModelConnection = page
      .locator('.page__actions')
      .getByRole('button', { name: 'Add model connection', exact: true });
    await waitForRouteViewTarget(
      {
        viewName: 'The Connections → Models view',
        target: addModelConnection,
        failures: [
          // `RouteViewBoundary`'s three settled failures — a rejected chunk, a
          // refused read, a broken view — all render `ErrorState`.
          page.locator(SETTLED_ERROR_STATE_SELECTOR),
          // A code-split surface failing INSIDE the mounted view is a different
          // finding from the route failing, and says so.
          page.locator(LAZY_BOUNDARY_ERROR_SELECTOR),
        ],
        pending: [
          page.getByRole('status', { name: ROUTE_PENDING_STATUS_NAME }),
        ],
      },
      LAZY_CHUNK_ALLOWANCE_MS,
    );
    await addModelConnection.click();
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
    // #1642: this goto re-mounts the dock, so it passes through the same layout
    // gate as the first one and gets the same wait. Waiting for the region before
    // the header control inside it also puts the two in the order they can
    // actually arrive — a control cannot appear before the region hosting it.
    //
    // This is the ONE bound this change lowers, and deliberately: the trigger
    // below carried 20 s, which was really covering the layout resolution that
    // now has its own wait above. Once the region is up the mobile header renders
    // with it — `isMobile` is a synchronous `matchMedia` read, and no query sits
    // between them — so what is left for the trigger is a render, which the
    // runner's default covers. A budget kept here would be funding the same wait
    // twice and would hide which of the two actually ran long.
    await waitForRouteViewTarget(
      {
        viewName: 'The Coding layout view, reopened',
        target: chatDock,
        failures: [
          page.locator(FULL_SCREEN_ERROR_SELECTOR),
          page.locator(SETTLED_ERROR_STATE_SELECTOR),
        ],
        pending: [fullScreenLoaderLabel(page, 'layout')],
      },
      PROJECT_LAYOUT_READINESS_TIMEOUT_MS,
    );
    const chatActions = page.getByRole('button', {
      name: 'Chat actions',
      exact: true,
    });
    await expect(chatActions).toBeVisible();
    // Counted BEFORE the click: `LazyBoundary`'s failure text is the same constant
    // everywhere, so only a failure that APPEARS across this interaction can be
    // attributed to this sheet. The dock's own prewarmed boundary rejects exactly
    // when the host is unreachable, and it sorts before these portaled sheets.
    const boundaryErrorsBeforeChatActions =
      await countVisibleLazyBoundaryErrors(page);
    await chatActions.click();
    const chatActionsMenu = page.getByRole('menu', { name: 'Chat actions' });
    // The sheet is a lazily imported chunk (`ChatDockMobileOverflowSheet`,
    // kept out of the entry bundle), so its FIRST open is a module fetch that
    // renders nothing while it is in flight. Playwright's 5s expect default is
    // not a budget for that on a loaded host — observed pending at 5s with the
    // trigger already `aria-expanded`.
    //
    // #1642: 15 s did not settle it either, and a bare wait on the menu cannot
    // say why — a chunk that REJECTS looks exactly like a chunk that is slow.
    // Watch the boundary's failure state alongside the menu so the two are
    // different reports, and hand the wait the trigger's `aria-expanded` so its
    // timeout can at least say whether the click was taken.
    await waitForLazySurface(
      page,
      {
        surfaceName: 'The Chat actions sheet',
        surface: chatActionsMenu,
        openIndicator: page.locator(
          'button[aria-label="Chat actions"][aria-expanded="true"]',
        ),
        baselineUnavailableCount: boundaryErrorsBeforeChatActions,
      },
      LAZY_CHUNK_ALLOWANCE_MS,
    );
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
    const taskDialog = page.getByRole('dialog', { name: 'Switch task' });
    // #1642: the same lazy-chunk shape as the sheet above (`MobileTaskSwitcher`,
    // also `pending={null}`, also not prewarmed), so it gets the same wait. This
    // trigger publishes NO open state — no `aria-expanded`, no `aria-haspopup` —
    // so there is deliberately no `openIndicator` here and the wait's timeout
    // says as much rather than implying it knows the click landed.
    const openTaskSwitcher = async (occasion: string) => {
      // Counted before each click, for the same reason as the sheet above: only a
      // boundary failure that appears across THIS interaction is this sheet's.
      const boundaryErrorsBefore = await countVisibleLazyBoundaryErrors(page);
      await taskSwitcher.click();
      await waitForLazySurface(
        page,
        {
          surfaceName: `The Switch task sheet (${occasion})`,
          surface: taskDialog,
          baselineUnavailableCount: boundaryErrorsBefore,
        },
        LAZY_CHUNK_ALLOWANCE_MS,
      );
    };
    await openTaskSwitcher('first open');
    const taskRows = taskDialog.locator('.chat-dock-inbox__item');
    // NOT given a budget, on purpose, and #1690 is why: the sheet renders
    // `Empty label="No chats yet."` whenever it has no rows, with no pending
    // branch beside it, while the three reads behind `taskItems` all default to
    // an empty array in flight. "Still asking" and "there are none" are the same
    // pixels, so no number can be right here — too small and the query has not
    // answered, too large and it waits out a genuine empty result. The wait has
    // nothing to wait on until the product derives the distinction. Leaving the
    // runner default in place keeps that visible instead of dressing it up.
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
    // #1642: selecting a row calls `closeAndRestoreFocus`, so the sheet goes on
    // its own — but nothing here used to say so, and the next two steps re-open
    // it and then act on rows INSIDE it with no precondition of their own. A
    // reopen that failed or lagged was therefore reported as a row locator, which
    // names the wrong thing. That missing precondition is what this closes.
    //
    // An earlier version of this comment also claimed the reused `currentTaskIndex`
    // was racing a re-render free to reorder the list. Review traced that as
    // unreachable in this journey — selecting a row touches no field the group
    // comparator orders on — so the claim is withdrawn rather than left standing as
    // a hazard nobody can reproduce. Keying the row on a stable identifier would
    // earn it back; asserting it without that would be inventing a danger.
    //
    // Asserting the close is also what makes the reopen a real reopen. It carries
    // no budget deliberately: the close is a synchronous state change with no
    // network and no chunk behind it, so the runner default is the correct bound
    // and anything larger would be a number with nothing behind it.
    //
    // (What this does NOT claim: that a click on the trigger while the sheet is up
    // would close it. `onOpenTaskSwitcher` only ever sets open to true — it is not
    // a toggle — and the portaled overlay closes on a pointerdown that hits the
    // overlay itself, which is not where Playwright clicks. The defect fixed here
    // is the missing precondition, not a toggle race.)
    await expect(taskDialog).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('chat'))
      .not.toBe(currentChat);
    await openTaskSwitcher('reopened to return to the first task');
    await taskRows.nth(currentTaskIndex).click();
    await expect(taskDialog).toHaveCount(0);
    await openTaskSwitcher('reopened to read back the restored selection');
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
    await expect
      .poll(() => chatRequests.length, {
        timeout: CHAT_REQUEST_RECORDED_TIMEOUT_MS,
      })
      .toBe(1);
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible({
      timeout: STREAMED_REPLY_TIMEOUT_MS,
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
