import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import {
  FIRST_RENDER_TIMEOUT_MS,
  openPillInRegionThroughMenu,
} from './helpers/region-placement';

/**
 * D8 (`reports/board-notifications-lane/DESIGN.md`): a project shows a Board
 * only when the SERVER knows of a Builder run for it.
 *
 * The predicate is `OperatingStateService.hasBuilderRun` — the workflow
 * sidecar index under the project's own working directory
 * (`.kontourai/flow-agents/<task>/state.json`), the same index
 * `ConsoleBoardView` already reads for operating state — served at
 * `GET /api/projects/:slug/operating-state/availability` and consumed by
 * BOTH the sidebar entry and the route guard. So both projects below are
 * seeded the way `builder-delivery-viewer.spec.ts` seeds one: a real
 * temporary working directory, with or without a real `state.json`, bound to
 * a real project through `POST /api/projects`.
 *
 * The two projects are IDENTICAL except for that one file. Both carry a
 * non-board layout, because the sidebar only renders its layout chips for the
 * SELECTED project and only when that project has at least one layout
 * (#2063) — without that, "no Board entry" would be true of every project on
 * the instance and the assertion would prove nothing about the predicate.
 */

const API = resolveE2EApiBase();

const NO_RUN_SLUG = 'd8-board-no-run';
const NO_RUN_NAME = 'D8 Board No Run';
const WITH_RUN_SLUG = 'd8-board-with-run';
const WITH_RUN_NAME = 'D8 Board With Run';
const TASK_SLUG = 'd8-demo-task';

/** The one sentence D8 specifies for the redirect. */
const REDIRECT_NOTICE =
  'This project has no Builder runs yet; the Board appears when one starts';

let noRunDir = '';
let withRunDir = '';

function writeBuilderRun(workspace: string): void {
  const task = join(workspace, '.kontourai', 'flow-agents', TASK_SLUG);
  mkdirSync(task, { recursive: true });
  writeFileSync(
    join(task, 'state.json'),
    JSON.stringify({
      schema_version: '1.0',
      task_slug: TASK_SLUG,
      status: 'in_progress',
      phase: 'execution',
      updated_at: '2026-08-20T00:00:00Z',
      flow_run: {
        run_id: 'd8-run',
        definition_id: 'builder.build',
        definition_version: '1',
        status: 'in_progress',
        current_step: 'execution',
        run_ref: 'run:d8-run',
        open_gate_ids: [],
      },
      next_action: { status: 'continue', summary: 'run checks' },
    }),
  );
}

/**
 * Remove both projects and PROVE they are gone.
 *
 * The `.catch(() => undefined)` this replaces swallowed every outcome — a
 * timeout, a 500, a delete that never landed — so a surviving project was
 * silently carried into the next case, where `createProject` got a 409 and
 * reported "creating d8-board-no-run: expected 201, received 409". That names
 * the creation, which is fine; the cleanup, which is what actually failed, was
 * never mentioned. A cleanup that reports success by saying nothing is the one
 * thing a fixture must not do.
 */
async function deleteProjects(request: AuthenticatedE2ERequest): Promise<void> {
  for (const slug of [NO_RUN_SLUG, WITH_RUN_SLUG]) {
    await request.delete(`${API}/api/projects/${slug}`).catch(() => undefined);
    const check = await request.get(`${API}/api/projects/${slug}`);
    expect(
      check.status(),
      `${slug} still exists after cleanup — a later 409 from createProject ` +
        'would have blamed the creation for this',
    ).toBe(404);
  }
}

async function createProject(
  request: AuthenticatedE2ERequest,
  slug: string,
  name: string,
  workingDirectory: string,
): Promise<void> {
  const created = await request.post(`${API}/api/projects`, {
    data: { name, slug, workingDirectory },
  });
  expect(created.status(), `creating ${slug}`).toBe(201);
  // The sidebar's layout chip row — and therefore the Board chip that lives
  // inside it — only renders when the project has at least one layout.
  const layout = await request.post(`${API}/api/projects/${slug}/layouts`, {
    data: { slug: 'notes', name: 'Notes', type: 'custom' },
  });
  expect(layout.status(), `giving ${slug} a layout`).toBe(201);
}

/** The predicate, read from the server, so the DOM is held to ITS answer. */
async function readAvailability(
  request: AuthenticatedE2ERequest,
  slug: string,
): Promise<boolean> {
  const response = await request.get(
    `${API}/api/projects/${slug}/operating-state/availability`,
  );
  expect(response.status(), `availability for ${slug}`).toBe(200);
  return ((await response.json()).data as { hasBuilderRun: boolean })
    .hasBuilderRun;
}

/**
 * archive#3823. Chrome banners the app's own sources present on boot — a
 * capability failure, a plugin-registry gate, a resource-posture warning —
 * occupy the banner host's bounded visible stack, and every one of them
 * presents ABOVE the `info` band the route guard's redirect notice uses. Two
 * independent things keep this spec's assertion about the notice it causes:
 *
 * 1. The sort order lifts a `userInitiated` notice to the top of the
 *    non-connection bands (`banner-store.ts`), which is the product fix and
 *    the reason the notice is readable for a real user, not just in a test.
 * 2. This hook, which clears the PASSIVE banners of the current document. It
 *    can only run after a navigation — the bundle re-executes on every real
 *    page load, and the hook does not exist on `about:blank` — so it is
 *    deliberately scoped to passive banners: called at any moment, before or
 *    after the guard has presented, it can never remove the notice under
 *    test.
 */
async function gotoAndClearPassiveChrome(page: Page, path: string) {
  await page.goto(path);
  await page.evaluate(() =>
    (
      window as unknown as {
        __stationClearPassiveChromeBannersForTestsOnly?: () => void;
      }
    ).__stationClearPassiveChromeBannersForTestsOnly?.(),
  );
}

/**
 * Return one project row's layout chip row. #2063 replaced the nested tree and
 * its expand chevron with chips that belong to the SELECTED project, so being
 * on the project's own route is what puts them on screen; a row that is not
 * selected is selected by clicking its name. The row's own button carries the
 * project avatar's initials as well as its name, so it is reached by the name
 * element inside it rather than by an exact accessible name.
 */
async function projectLayoutChips(page: Page, name: string) {
  const row = page.locator('.sidebar__project-row', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  const strip = row.locator('.sidebar__layout-chips');
  if ((await strip.count()) === 0) {
    await row.locator('.sidebar__project-name').click();
  }
  await expect(strip).toBeVisible({ timeout: 20_000 });
  return { row, strip };
}

test.describe("Board visibility follows the server's Builder-run predicate", () => {
  test.beforeAll(async () => {
    noRunDir = mkdtempSync(join(tmpdir(), 'd8-board-no-run-'));
    withRunDir = mkdtempSync(join(tmpdir(), 'd8-board-with-run-'));
    writeBuilderRun(withRunDir);
  });

  test.beforeEach(async ({ authenticatedRequest }) => {
    await deleteProjects(authenticatedRequest);
    await createProject(
      authenticatedRequest,
      NO_RUN_SLUG,
      NO_RUN_NAME,
      noRunDir,
    );
    await createProject(
      authenticatedRequest,
      WITH_RUN_SLUG,
      WITH_RUN_NAME,
      withRunDir,
    );
    // Both halves of the fixture are proven to differ at the SERVER before
    // any page is opened; otherwise a broken seed would make the "no Board"
    // half pass for the wrong reason.
    expect(
      await readAvailability(authenticatedRequest, NO_RUN_SLUG),
      'the no-run fixture must have no Builder run',
    ).toBe(false);
    expect(
      await readAvailability(authenticatedRequest, WITH_RUN_SLUG),
      'the with-run fixture must have a Builder run',
    ).toBe(true);
  });

  test.afterAll(async () => {
    if (noRunDir) rmSync(noRunDir, { recursive: true, force: true });
    if (withRunDir) rmSync(withRunDir, { recursive: true, force: true });
  });

  test("with no Builder run the route redirects with D8's notice and the nav offers no Board", async ({
    page,
  }) => {
    await gotoAndClearPassiveChrome(
      page,
      `/projects/${NO_RUN_SLUG}/session-board`,
    );

    // The route guard sends the reader to the project page …
    await expect(page).toHaveURL(new RegExp(`/projects/${NO_RUN_SLUG}$`), {
      timeout: 20_000,
    });
    // … and says why, on the page it landed on. A redirect that drops the
    // reader somewhere else without a word is the defect this replaces.
    await expect(page.getByText(REDIRECT_NOTICE)).toBeVisible();

    // The nav offers no Board for this project. The strip itself must be
    // present (the project's other layout is in it) or this assertion would
    // be satisfied by an unrendered sidebar.
    const { strip } = await projectLayoutChips(page, NO_RUN_NAME);
    await expect(strip.getByText('Notes')).toBeVisible({ timeout: 20_000 });
    await expect(strip.getByRole('button', { name: 'Board' })).toHaveCount(0);
  });

  test('with a Builder run the frame names the project and states the receipt once', async ({
    page,
  }) => {
    await gotoAndClearPassiveChrome(
      page,
      `/projects/${WITH_RUN_SLUG}/session-board`,
    );

    // No redirect: the route stays where the reader asked to be.
    await expect(page).toHaveURL(
      new RegExp(`/projects/${WITH_RUN_SLUG}/session-board`),
    );
    const header = page.locator('.page-frame__header');
    await expect(header.locator('.page__title')).toHaveText('Board', {
      timeout: 20_000,
    });
    // 4-HOME-016: the subtitle is the PROJECT, not a sentence about boards —
    // the frame says which project's board this is.
    await expect(header.locator('.page__subtitle')).toHaveText(WITH_RUN_NAME);
    // archive#3776: ONE receipt on the page. Console Kit's `BoardView`
    // renders its own ('.board-receipt', derived from the very projection
    // rendered beneath it) and exposes no prop to suppress its header, so
    // Station stopped printing a second copy of the same number ~40px above
    // it in the frame's action cell.
    await expect(page.locator('.board-receipt')).toHaveText(
      '1 item in flight',
      { timeout: 20_000 },
    );
    await expect(page.getByText('1 item in flight')).toHaveCount(1);
    await expect(header.locator('.page__actions')).not.toContainText(
      'in flight',
    );
    // No redirect notice on a project that has a run.
    await expect(page.getByText(REDIRECT_NOTICE)).toHaveCount(0);

    // And the nav offers the Board entry the other project does not get.
    const { strip } = await projectLayoutChips(page, WITH_RUN_NAME);
    await expect(strip.getByRole('button', { name: 'Board' })).toBeVisible({
      timeout: 20_000,
    });
  });

  /**
   * #2158: a Layout chip is a pill the reader can SEND somewhere, not only a
   * destination to follow.
   *
   * Driven here rather than against a mocked fixture because the pane id is
   * `layout:<projectId>/<layoutId>` and both halves must be the lowercase
   * UUIDs the SERVER mints — `POST /api/projects` and `POST
   * /api/projects/:slug/layouts` are what produce them, and a fixture that
   * invented the ids would be asserting against its own spelling. The `Notes`
   * layout these projects already carry is the subject.
   *
   * The Session Board chip beside it is deliberately excluded: it is a route,
   * not a pane (#2157), and this asserts that difference is visible to a user
   * rather than only to a unit test.
   */
  test('a Layout chip opens into the Right region, and the reload keeps it', async ({
    page,
  }) => {
    await gotoAndClearPassiveChrome(page, `/projects/${WITH_RUN_SLUG}`);
    const { strip } = await projectLayoutChips(page, WITH_RUN_NAME);
    const notes = strip.getByRole('button', { name: 'Notes', exact: true });
    await expect(notes).toBeVisible({ timeout: 20_000 });

    await openPillInRegionThroughMenu(page, notes, 'Notes', 'Right');

    // The region holds it: a dock shell rendered in `right`, carrying the
    // Layout's own name — the title `RegionPaneHost` resolves from the
    // project's layout list, not the `layout:` prefix fallback.
    const right = page.locator('.chat-dock--right');
    await expect(right).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
    await expect(
      page.getByRole('button', { name: 'Move Notes', exact: true }),
      'the right region must hold a pane the model calls Notes',
    ).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });

    // The Board chip beside it offers no such menu — asserted AFTER the open
    // above, deliberately. The chip menu is behind a lazy boundary, so a
    // `toHaveCount(0)` taken before anything had fetched that chunk would be
    // satisfied by a menu that simply had not arrived yet. The journey above
    // has loaded it in this document, so the absence is now a decision.
    await strip
      .getByRole('button', { name: 'Board', exact: true })
      .click({ button: 'right' });
    await expect(
      page.getByRole('menu'),
      'the Session Board chip is a route, not a pane: it offers no menu',
    ).toHaveCount(0);

    // …and it is a placement, not a render: the arrangement is persisted, so
    // the reader finds it there again. A tab that only survived until the next
    // navigation would make the menu a preview rather than an open.
    await page.reload();
    await expect(page.locator('.chat-dock--right')).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT_MS,
    });
    await expect(
      page.getByRole('button', { name: 'Move Notes', exact: true }),
    ).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });
  });
});

test.describe('Board visibility at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeAll(async () => {
    noRunDir = mkdtempSync(join(tmpdir(), 'd8-board-no-run-m-'));
    withRunDir = mkdtempSync(join(tmpdir(), 'd8-board-with-run-m-'));
    writeBuilderRun(withRunDir);
  });

  test.beforeEach(async ({ authenticatedRequest }) => {
    await deleteProjects(authenticatedRequest);
    await createProject(
      authenticatedRequest,
      NO_RUN_SLUG,
      NO_RUN_NAME,
      noRunDir,
    );
    await createProject(
      authenticatedRequest,
      WITH_RUN_SLUG,
      WITH_RUN_NAME,
      withRunDir,
    );
    expect(await readAvailability(authenticatedRequest, NO_RUN_SLUG)).toBe(
      false,
    );
    expect(await readAvailability(authenticatedRequest, WITH_RUN_SLUG)).toBe(
      true,
    );
  });

  test.afterAll(async () => {
    if (noRunDir) rmSync(noRunDir, { recursive: true, force: true });
    if (withRunDir) rmSync(withRunDir, { recursive: true, force: true });
  });

  test('the redirect notice and the board frame both survive the phone', async ({
    page,
  }) => {
    await gotoAndClearPassiveChrome(
      page,
      `/projects/${NO_RUN_SLUG}/session-board`,
    );
    await expect(page).toHaveURL(new RegExp(`/projects/${NO_RUN_SLUG}$`), {
      timeout: 20_000,
    });
    await expect(page.getByText(REDIRECT_NOTICE)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'the redirect notice must not push the project page sideways',
    ).toBe(true);

    await page.goto(`/projects/${WITH_RUN_SLUG}/session-board`);
    const header = page.locator('.page-frame__header');
    await expect(header.locator('.page__title')).toHaveText('Board', {
      timeout: 20_000,
    });
    await expect(header.locator('.page__subtitle')).toHaveText(WITH_RUN_NAME);
    // Same 20s budget as the two assertions above, and for the same reason:
    // the frame's title arrives from the route table long before the board's
    // own content, which waits on the availability read AND the workflow
    // sidecar index under the project's working directory. This assertion was
    // the only one of the three left on the 5s default, so on a loaded host it
    // was the one that reported "0 elements" while the other two had already
    // waited out the same lag.
    await expect(page.getByText('1 item in flight')).toHaveCount(1, {
      timeout: 20_000,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      'the board must not push the page sideways at 390',
    ).toBe(true);

    // archive#3777: the kanban strip scrolls inside the page, so the document
    // check above passes while IN FLIGHT — the only populated column — sits
    // entirely off-screen with its count. The tab strip is what states the
    // columns that the scroller hides; without it the reader lands on what
    // looks like an empty board.
    const stages = page.getByRole('tablist', { name: 'Flow stages' });
    await expect(stages).toBeVisible({ timeout: 20_000 });
    const tabs = stages.getByRole('tab');
    await expect(tabs).toHaveCount(
      await page.locator('.board-columns > *').count(),
    );
    // Every tab is a real tap target, and the strip names the populated column.
    for (const tab of await tabs.all()) {
      const box = await tab.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expect(stages).toContainText('In flight');

    // The board lands ON the work rather than on an empty BACKLOG: the first
    // populated column is the one scrolled into view.
    const landed = await page.evaluate(() => {
      const scroller = document.querySelector('.board-columns');
      if (!scroller) return null;
      const columns = [...scroller.children] as HTMLElement[];
      const populated = columns.findIndex(
        (column) => column.querySelectorAll('.board-cards > *').length > 0,
      );
      return {
        populated,
        scrollLeft: Math.round(scroller.scrollLeft),
        populatedOffset:
          populated >= 0
            ? Math.round(
                columns[populated].offsetLeft -
                  (scroller as HTMLElement).offsetLeft,
              )
            : -1,
      };
    });
    expect(landed?.populated ?? -1).toBeGreaterThan(0);
    expect(
      Math.abs((landed?.scrollLeft ?? 0) - (landed?.populatedOffset ?? 0)),
    ).toBeLessThanOrEqual(2);
  });
});
