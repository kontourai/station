import { expect, type Page } from '@playwright/test';

/**
 * The Coding layout lands on its Chat page; every pane is a drill-in reached
 * from the stack bar's Views list (#928 coding stack). These are the user's
 * own two moves, as ordinary Playwright actions.
 */
export function codingNavigation(page: Page) {
  return page.getByRole('navigation', { name: 'Coding navigation' });
}

/** Drill into a pane from the stack bar's Views list. */
export async function openCodingView(page: Page, name: string | RegExp) {
  const nav = codingNavigation(page);
  await nav.getByRole('button', { name: 'Views', exact: true }).click();
  await nav
    .getByRole('region', { name: 'Views' })
    .getByRole('button', { name, exact: typeof name === 'string' })
    .click();
}

/**
 * Show a pane of the Coding host: its tab when a drill-in is already on
 * screen, the Views list otherwise. Ends with the pane's tab selected.
 */
export async function selectCodingPane(page: Page, name: string) {
  const tab = page
    .getByRole('region', { name: 'Workspace panes', exact: true })
    .getByRole('tab', { name, exact: true });
  await expect(codingNavigation(page)).toBeVisible({ timeout: 20_000 });
  if (await tab.isVisible()) await tab.click();
  else await openCodingView(page, name);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}
