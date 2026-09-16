import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Reading and driving the shell's region model from a browser journey (#928).
 *
 * The model is the one authority for where each registered surface lives
 * (`src-ui/src/regions/region-model.ts`); these helpers only read what it
 * rendered and press the controls a user would. Shared by every spec that
 * needs it so the two copies this replaced cannot drift apart — the exact
 * failure that made `useRegionSurfaceMenu` carry its own show/hide rules
 * twice in one epic (#1420).
 *
 * WHAT THE DOM SAYS. `RegionShells` mounts one `DockShell` per occupied DOCK
 * region, and each takes its accessible name from its occupant — "Dock" for
 * Chat, the registered surface title for anything else — while
 * `chat-dock--<region>` on the same element names the region it renders in.
 * Chat's shell also carries `id="chat-dock"`. A `main` occupant gets no
 * `DockShell` at all: it is rendered by the route outlet
 * (`MainRegionSurface`), so "this surface has no dock shell" is how a journey
 * observes that it holds the primary area.
 */

/**
 * The budget for a FIRST-RENDER wait — a shell region appearing after the app
 * has resolved the data behind it, as opposed to a reaction to a click.
 *
 * Home is the case that forced it: its region appears only once the home
 * surface resolves (connections, projects, the resolved surface itself), so on
 * a loaded machine it lands seconds after the dock region beside it — observed
 * live with the Activity shell already up and `#station-main` still empty.
 * Playwright's 5s default is not a budget for that, and an assertion whose
 * outcome depends on machine load is not a gate.
 *
 * Applies to the region/dock first-render waits in the specs that drive
 * placement; it is deliberately not retrofitted onto unrelated waits for other
 * surfaces, which carry their own budgets.
 */
export const FIRST_RENDER_TIMEOUT_MS = 15_000;

/** Chat's dock shell, wherever Chat currently is. */
export function chatDockShell(page: Page): Locator {
  return page.locator('#chat-dock');
}

/** The dock shell of a non-Chat surface, named by its registered title. */
export function surfaceDockShell(page: Page, title: string): Locator {
  return page.locator(`.chat-dock[aria-label="${title}"]`);
}

/**
 * The region's TAB STRIP as the reader sees it: which panes it holds, in tab
 * order, and which one is pressed (#2046 2b, `RegionChromeBar`).
 *
 * This is how a journey observes a pane SET, because a shell no longer names
 * one: since #2046 2a a dock placement joins the region's panes instead of
 * displacing its occupant, so a region holding Chat and Activity is a single
 * `#chat-dock` shell labelled "Dock" whichever tab is selected (D3), and
 * `surfaceDockShell` finds nothing for the pane that joined it.
 *
 * The strip renders only for a region holding two or more panes, on a fine
 * pointer, with the region open (`RegionChromeBar`'s `showStrip`, D1/D2) — so
 * asserting through it also pins that the region is expanded and that the
 * device is not folded.
 */
export async function expectRegionTabs(
  page: Page,
  titles: readonly string[],
  selected: string,
): Promise<void> {
  const strip = page.getByRole('tablist', { name: 'Region panes' });
  await expect(
    strip.getByRole('tab'),
    `the region must hold ${titles.join(' and ')}, in that tab order`,
  ).toHaveText([...titles]);
  await expect(
    strip.getByRole('tab', { name: selected, exact: true }),
    `${selected} must be the pane the region shows`,
  ).toHaveAttribute('aria-selected', 'true');
}

/**
 * The header's per-region toggle (#2143): `aria-pressed` is the region's
 * visibility from the model. Presses it and reads the flipped state back off
 * the SAME control — the model re-derives it, so the assertion sees the
 * arrangement rather than the DOM it just clicked. Refuses to prove a
 * no-op: the precondition pins the state it expects to flip FROM.
 */
export async function toggleRegionThroughToolbar(
  page: Page,
  regionLabel: 'Left' | 'Bottom' | 'Right',
  from: 'shown' | 'hidden',
): Promise<void> {
  const toggle = page.getByRole('button', {
    name: `${regionLabel} region`,
    exact: true,
  });
  const before = from === 'shown' ? 'true' : 'false';
  await expect(
    toggle,
    `${regionLabel} region must be ${from} before the toggle, or this proves nothing`,
  ).toHaveAttribute('aria-pressed', before);
  await toggle.click();
  await expect(
    toggle,
    `${regionLabel} region did not flip from ${from}`,
  ).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
}

/**
 * Shows a surface in a HIDDEN, EMPTY region — the journey a user makes in two
 * acts since #2155, through the two controls that own them. The toolbar's
 * toggle opens the region (it only shows and hides now; #2143's offer menu
 * is retired), and the region's own body is the chooser that fills it
 * (#2154). The name and signature are the same as the toolbar-menu version
 * this replaces, so both callers describe the same outcome.
 *
 * The post-condition is the toggle reading pressed AND the surface owning
 * that region's shell — the first says the region opened, the second that
 * the pane landed in it.
 *
 * NOT for Chat: a region holding Chat takes the landmark `Dock` rather than
 * the surface's own title (`DockShell`), so the shell assertion below would
 * never find it. `orchestration.ts` drives Chat's own route.
 */
export async function showSurfaceInEmptyRegion(
  page: Page,
  surfaceTitle: string,
  regionLabel: 'Left' | 'Bottom' | 'Right',
): Promise<void> {
  const control = page.getByRole('button', {
    name: `${regionLabel} region`,
    exact: true,
  });
  await expect(
    control,
    `${regionLabel} region is already shown, so this is not the empty-region journey`,
  ).toHaveAttribute('aria-pressed', 'false');
  await control.click();
  await expect(
    control,
    `${regionLabel} region did not open, so there is no chooser to fill it from`,
  ).toHaveAttribute('aria-pressed', 'true');
  await chooseSurfaceInEmptyRegion(page, surfaceTitle, regionLabel);
  await expect(
    control,
    `${regionLabel} region closed again, so ${surfaceTitle} did not land there`,
  ).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Opens #2154's chooser from a region's TOOLBAR toggle (#2155): a hold, which
 * on a coarse pointer is the only route to it, and on a fine one sits beside
 * the right-click. Held past the control's 500ms threshold with room to
 * spare, because a hold measured to the millisecond is a flake.
 *
 * THE PANEL IS ASSERTED WHILE THE POINTER IS STILL DOWN, and then again after
 * the release. That ordering is the whole point of driving this from a
 * browser at all (#2155 review B1): the hold opens the panel from a timer
 * mid-gesture, so the panel's full-viewport dismiss backdrop is on screen
 * before the release — and a backdrop that dismissed on any release, or a
 * control that let the release go to it, would eat the gesture that opened
 * it. Waiting for the panel BEFORE the release is also what stops this being
 * a race: without it, a release that beat a cold lazy chunk's fetch would
 * pass for the same reason a broken build would.
 *
 * The toggle's ordinary click shows or hides the region, so a press that
 * lands short opens nothing and toggles the region instead — which the
 * caller's `aria-pressed` assertion around this catches.
 */
export async function openChooserFromToggle(
  page: Page,
  regionLabel: 'Left' | 'Bottom' | 'Right',
): Promise<Locator> {
  const control = page.getByRole('button', {
    name: `${regionLabel} region`,
    exact: true,
  });
  const box = await control.boundingBox();
  expect(
    box,
    `${regionLabel} region's toggle must have a rendered box`,
  ).not.toBeNull();
  const menu = page.getByRole('menu', { name: `Add to ${regionLabel} region` });
  await page.mouse.move(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2,
  );
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(
    menu,
    `the hold on ${regionLabel} region's toggle opened no chooser`,
  ).toBeVisible();
  await page.mouse.up();
  await expect(
    menu,
    `the release that ended the hold on ${regionLabel} region's toggle dismissed the panel it had just opened`,
  ).toBeVisible();
  return menu;
}

/**
 * Fills an EMPTY, VISIBLE region from its own body (#2154): the region's
 * host renders a chooser — a list named "Add to <Region> region" of every
 * registry surface declaring that region — and a row's press is the model's
 * `openSurfaceInRegion(id, { region })`. A row for a surface held elsewhere
 * reads "<title> Move here from <Region>" and is a move; this helper presses
 * the row by its title whichever it is. The post-condition is the region's
 * shell carrying the surface's own landmark, which only a placed pane
 * produces. `showSurfaceInEmptyRegion` is the toolbar route to the same
 * placement; this is the in-region one.
 */
export async function chooseSurfaceInEmptyRegion(
  page: Page,
  surfaceTitle: string,
  regionLabel: 'Left' | 'Bottom' | 'Right',
): Promise<void> {
  const list = page.getByRole('list', {
    name: `Add to ${regionLabel} region`,
  });
  await expect(
    list,
    `${regionLabel} region shows no chooser, so it is not empty and visible`,
  ).toBeVisible();
  await list
    .getByRole('button', { name: new RegExp(`^${surfaceTitle}( |$)`) })
    .click();
  await expect(list).toBeHidden();
  await expect(
    surfaceDockShell(page, surfaceTitle),
    `${surfaceTitle} did not become ${regionLabel}'s shell, so it was not placed there`,
  ).toHaveClass(new RegExp(`chat-dock--${regionLabel.toLowerCase()}`));
}

/**
 * Moves ONE pane to another region through its tab's own menu (#2143): a
 * right-click on the tab opens "Move <title>", whose rows are the regions the
 * pane declares on this device minus the one it is in. `Main` hands the pane
 * the primary area. The tab strip renders only for a region holding two or
 * more panes; a LONE pane reaches the same menu from the region bar's Move
 * button — `moveLonePaneToRegion` below (#2160).
 */
export async function moveTabToRegion(
  page: Page,
  surfaceTitle: string,
  regionLabel: 'Left' | 'Bottom' | 'Right' | 'Main',
): Promise<void> {
  const strip = page.getByRole('tablist', { name: 'Region panes' });
  await strip
    .getByRole('tab', { name: surfaceTitle, exact: true })
    .click({ button: 'right' });
  const menu = page.getByRole('menu', { name: `Move ${surfaceTitle}` });
  await expect(menu).toBeVisible();
  await menu
    .getByRole('menuitem', { name: `Move to ${regionLabel}`, exact: true })
    .click();
  await expect(menu).toBeHidden();
}

/**
 * Moves a LONE pane — the only one its region holds, so there is no tab strip
 * — through the region bar's own "Move <title>" button (#2160). It opens the
 * SAME menu `moveTabToRegion` drives from a tab, for the pane the region
 * shows, so this route reaches `main` where the bar's ⋮⋮ grab (whole region,
 * dock edges only) cannot.
 *
 * Asserting the strip is absent first is what keeps this a drive of the lone
 * pane's route rather than of a tab that happened to be on screen.
 */
export async function moveLonePaneToRegion(
  page: Page,
  surfaceTitle: string,
  regionLabel: 'Left' | 'Bottom' | 'Right' | 'Main',
): Promise<void> {
  // Scoped to the surface's OWN shell: another region on the page may hold
  // two panes and render a strip of its own, which says nothing about this
  // one.
  await expect(
    surfaceDockShell(page, surfaceTitle).getByRole('tablist', {
      name: 'Region panes',
    }),
    `${surfaceTitle}'s region renders a tab strip, so it is not alone there and this is not the lone pane's route`,
  ).toHaveCount(0);
  const button = page.getByRole('button', {
    name: `Move ${surfaceTitle}`,
    exact: true,
  });
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.click();
  const menu = page.getByRole('menu', { name: `Move ${surfaceTitle}` });
  await expect(menu).toBeVisible();
  await menu
    .getByRole('menuitem', { name: `Move to ${regionLabel}`, exact: true })
    .click();
  await expect(menu).toBeHidden();
}

/**
 * Moves a whole REGION — every pane, in order, with its selection — through
 * the region bar's ⋮⋮ grab (`moveRegionPanes`, #2046 2b). The grab is
 * revealed by hovering the bar (#1552 D3: hidden until the row is engaged),
 * so the hover is part of the gesture, not a workaround.
 */
export async function moveRegionThroughGrab(
  page: Page,
  shell: Locator,
  regionLabel: 'Left' | 'Bottom' | 'Right',
): Promise<void> {
  await shell.locator('.chat-dock__header').hover();
  await shell
    .getByRole('button', { name: 'Move the dock', exact: true })
    .click();
  const menu = page.getByRole('menu', { name: 'Dock placement' });
  await expect(menu).toBeVisible();
  await menu
    .getByRole('menuitemradio', { name: regionLabel, exact: true })
    .click();
  await expect(menu).toBeHidden();
}

/**
 * The phone's region route (#917): a coarse pointer narrow enough to be
 * mobile renders no region control in the toolbar row at all — the width
 * budget could not hold one — so the Show/Hide rows live in the `⋯` overflow
 * menu, and `useRegionSurfaceMenu` decides that, not the toolbar.
 *
 * Asserting the row is absent before the menu opens is what keeps this a
 * drive of that route rather than of some other surface that happens to carry
 * the same label.
 *
 * The rows name the dock since #1386 — "Show Activity in the dock", "Hide
 * Activity from the dock" — so they no longer collide with the docked shell's
 * own `Hide <surface>` control, which is the name a journey that means the
 * pane should ask for.
 */
export async function showRegionThroughOverflowMenu(
  page: Page,
  row: string,
): Promise<void> {
  const control = page.getByRole('button', { name: row, exact: true });
  await expect(
    control,
    `"${row}" is reachable without opening the ⋯ menu, so this is not the phone's region route`,
  ).toHaveCount(0);
  const overflow = page.getByRole('button', { name: 'More actions' });
  await expect(overflow).toBeVisible();
  await overflow.click();
  await expect(control).toBeVisible();
  await control.click();
}

/** Whether the document fits its own viewport widthwise. */
export function documentFitsViewportWidth(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
}

/**
 * Asserts a rendered box lies inside the viewport: flush to both edges
 * horizontally (a dock region spans the width it is given) and ending within
 * it vertically.
 */
export async function expectBoxWithinViewport(
  page: Page,
  locator: Locator,
  what: string,
): Promise<void> {
  const viewport = page.viewportSize();
  expect(
    viewport,
    'the containment assertion needs a viewport to compare against',
  ).not.toBeNull();
  const bounds = await locator.boundingBox();
  expect(bounds, `${what} must have a rendered box`).not.toBeNull();
  expect(
    [bounds?.x, (bounds?.x ?? 0) + (bounds?.width ?? 0)],
    `${what} must sit within the viewport horizontally`,
  ).toEqual([0, viewport?.width]);
  expect(
    (bounds?.y ?? 0) + (bounds?.height ?? 0),
    `${what} must end within the viewport vertically`,
  ).toBeLessThanOrEqual(viewport?.height ?? 0);
}
