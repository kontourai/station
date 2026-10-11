import { expect, type Page } from '@playwright/test';

/**
 * The Coding layout lands on its Chat page; every pane is a drill-in picked
 * from the icon rail on its trailing edge (#928 coding stack). These are the
 * user's own moves, as ordinary Playwright actions.
 */
export function codingNavigation(page: Page) {
  return page.getByRole('navigation', { name: 'Coding navigation' });
}

export function codingViewRail(page: Page) {
  return page.getByRole('navigation', { name: 'Views' });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A rail item by its pane's name. An item's accessible name may carry a
 * count after a comma ("Diff, 2 changed files").
 */
export function codingViewItem(page: Page, name: string | RegExp) {
  return codingViewRail(page).getByRole('button', {
    name:
      typeof name === 'string'
        ? new RegExp(`^${escapeRegExp(name)}(,|$)`)
        : name,
  });
}

/** Drill into a pane from the rail. */
export async function openCodingView(page: Page, name: string | RegExp) {
  await codingViewItem(page, name).first().click();
}

/**
 * The Coding rail's mode, derived from the device the way the product derives
 * it, not from the rail's own attributes, so a rail that renders the wrong
 * mode's state fails rather than being believed. `ProjectLayoutRenderer`
 * runs `panels` only when `useCodingWide()` (the `codingPanels.ts` query
 * below) AND Chat is in the centre; Chat leaves the centre whenever the dock
 * folds to one region, which `availablePlacements` (`useIsMobile.ts`) decides
 * as a coarse pointer or a viewport of 768px or less. So a touch screen past
 * 1280px still runs `stack`.
 */
const CODING_WIDE_MEDIA_QUERY = '(min-width: 1280px)';
const DOCK_SLOT_COARSE_POINTER_QUERY = '(pointer: coarse)';
const DOCK_ONE_REGION_MAX_WIDTH = 768;

export async function codingRailMode(page: Page): Promise<'panels' | 'stack'> {
  const derived = await page.evaluate(
    ({ wideQuery, coarseQuery, oneRegionMaxWidth }) => {
      const wide = window.matchMedia(wideQuery).matches;
      const bottomOnly =
        window.matchMedia(coarseQuery).matches ||
        window.innerWidth <= oneRegionMaxWidth;
      return wide && !bottomOnly ? 'panels' : 'stack';
    },
    {
      wideQuery: CODING_WIDE_MEDIA_QUERY,
      coarseQuery: DOCK_SLOT_COARSE_POINTER_QUERY,
      oneRegionMaxWidth: DOCK_ONE_REGION_MAX_WIDTH,
    },
  );
  // The workbench names the mode it chose; a disagreement means this
  // derivation and the product's have drifted apart, which is the thing to
  // fix — not a reason to trust either attribute set.
  await expect(
    page.locator('.coding-workbench'),
    `Coding rail mode: the device says "${derived}" but the workbench disagrees`,
  ).toHaveAttribute('data-mode', derived);
  return derived;
}

/**
 * Show a pane of the Coding host and wait until it is the one on screen. In
 * `stack` mode that is the drill-in page: the rail item is the current page
 * (`aria-current="page"`) and is not a toggle. In `panels` mode the pane opens
 * beside Chat: the item is a pressed toggle (`aria-pressed="true"`) naming the
 * panel it controls, and is not a page.
 */
export async function selectCodingPane(page: Page, name: string | RegExp) {
  const item = codingViewItem(page, name).first();
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.click();
  if ((await codingRailMode(page)) === 'panels') {
    await expect(item).toHaveAttribute('aria-pressed', 'true');
    await expect(item).toHaveAttribute('aria-controls', /\S/);
    await expect(item).not.toHaveAttribute('aria-current', /.*/);
  } else {
    await expect(item).toHaveAttribute('aria-current', 'page');
    await expect(item).not.toHaveAttribute('aria-pressed', /.*/);
  }
}
