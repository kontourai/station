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
 * Show a pane of the Coding host as a drill-in, and wait until it is the one
 * on screen (the rail's current item).
 */
export async function selectCodingPane(page: Page, name: string | RegExp) {
  const item = codingViewItem(page, name).first();
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.click();
  await expect(item).toHaveAttribute('aria-current', 'page');
}
