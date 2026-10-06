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
 * The Coding workbench's wide fold (#3229): the same viewport query
 * `codingPanels.ts` (`CODING_WIDE_MEDIA_QUERY`) asks. Past it the rail runs in
 * `panels` mode, below it in `stack` mode. Read from the viewport, not from
 * the rail's own attributes, so a rail that renders the wrong mode's state
 * fails rather than being believed.
 */
const CODING_WIDE_MEDIA_QUERY = '(min-width: 1280px)';

export async function codingRailMode(page: Page): Promise<'panels' | 'stack'> {
  const wide = await page.evaluate(
    (query) => window.matchMedia(query).matches,
    CODING_WIDE_MEDIA_QUERY,
  );
  return wide ? 'panels' : 'stack';
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
