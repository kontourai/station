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

/** Chat's dock shell, wherever Chat currently is. */
export function chatDockShell(page: Page): Locator {
  return page.locator('#chat-dock');
}

/** The dock shell of a non-Chat surface, named by its registered title. */
export function surfaceDockShell(page: Page, title: string): Locator {
  return page.locator(`.chat-dock[aria-label="${title}"]`);
}

/**
 * Places a surface through the header's Layout picker — the shell's public
 * placement route on a fine pointer since #1552 D2 (`RegionToolbarControls`,
 * `useRegionSurfaceMenu`): one `role="group"` panel of per-surface
 * `radiogroup` rows, each row a segmented choice over the regions that
 * surface declares plus `Hidden`.
 *
 * The post-condition is read after REOPENING the panel, because choosing a
 * segment closes it: the assertion then sees a segment whose pressed state
 * was freshly derived from the arrangement, not the DOM it just clicked. A
 * segment's accessible name is just the region label — the displacement note
 * beside it is a `hidden` span reached through `aria-describedby`, which the
 * name computation excludes — so `exact` matching is safe.
 */
export async function placeSurfaceThroughLayoutPicker(
  page: Page,
  surfaceTitle: string,
  regionLabel: string,
): Promise<void> {
  const openPicker = async () => {
    await page
      .getByRole('button', { name: 'Layout regions', exact: true })
      .click();
    const picker = page.getByRole('group', { name: 'Layout regions' });
    await expect(picker).toBeVisible();
    return picker;
  };
  const segment = (picker: Locator) =>
    picker
      .getByRole('radiogroup', { name: `${surfaceTitle} placement` })
      .getByRole('radio', { name: regionLabel, exact: true });

  await segment(await openPicker()).click();
  const reopened = await openPicker();
  await expect(
    segment(reopened),
    `${surfaceTitle}'s ${regionLabel} segment is not pressed after choosing it, so the shell did not place it there`,
  ).toHaveAttribute('aria-checked', 'true');
  // Leave the shell as it was found: the panel is portalled over the app and
  // its dismiss backdrop covers the viewport.
  await page.keyboard.press('Escape');
  await expect(reopened).toBeHidden();
}

/**
 * The phone's region route (#917): a coarse pointer narrow enough to be
 * mobile renders no region control in the toolbar row at all — the width
 * budget could not hold one — so the Show/Hide rows live in the `⋯` overflow
 * menu, and `useRegionSurfaceMenu` decides that, not the toolbar.
 *
 * Asserting the row is absent before the menu opens is what keeps this a
 * drive of that route rather than of some other surface that happens to carry
 * the same label. That guard is also the reason this is only good for a SHOW
 * row: once a surface is docked, its own `ChatDockHeader` renders a
 * `Hide <surface>` button, so the hide label is legitimately ambiguous and
 * belongs to whichever control the journey means to press.
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
