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
 * Shows a surface in an EMPTY region through that region's toolbar control
 * (#2143): an empty region's button is a menu of the shell surfaces that
 * declare it, and choosing one is the model's `placeSurface`. The
 * post-condition is the control turning into a pressed toggle — which only
 * a region that now holds a visible pane produces.
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
    `${regionLabel} region is not empty, so it offers no menu; move a tab instead`,
  ).toHaveAttribute('aria-haspopup', 'menu');
  await control.click();
  const menu = page.getByRole('menu', {
    name: `Show in ${regionLabel} region`,
  });
  await expect(menu).toBeVisible();
  await menu
    .getByRole('menuitem', { name: `Show ${surfaceTitle} here`, exact: true })
    .click();
  await expect(menu).toBeHidden();
  await expect(
    control,
    `${regionLabel} region did not become a pressed toggle, so ${surfaceTitle} was not placed there`,
  ).toHaveAttribute('aria-pressed', 'true');
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
  await expect(
    page.getByRole('tablist', { name: 'Region panes' }),
    `${surfaceTitle} must be alone in its region, or this is not the lone pane's route`,
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
