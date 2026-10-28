import { expect, type Page } from '@playwright/test';

/**
 * The Coding layout lands on its Chat page; every pane is a drill-in picked
 * from its desktop rail or phone tool picker. These are the
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

/** Open the picker on phones, then select the pane. */
export async function openCodingView(page: Page, name: string | RegExp) {
  const picker = page.getByRole('button', { name: /^Switch tool, current:/ });
  if (
    await page.evaluate(
      (query) => window.matchMedia(query).matches,
      MOBILE_MEDIA_QUERY,
    )
  )
    await picker.click();
  await codingViewItem(page, name).first().click();
}

/** Derive the expected presentation independently from the workbench's attributes. */
const CODING_WIDE_MEDIA_QUERY = '(min-width: 1280px)';
const MOBILE_MEDIA_QUERY =
  '(max-width: 768px), (max-height: 540px) and (pointer: coarse)';

export async function codingRailMode(page: Page): Promise<'panels' | 'stack'> {
  const derived = await page.evaluate(
    ({ wideQuery, mobileQuery }) =>
      window.matchMedia(wideQuery).matches &&
      !window.matchMedia(mobileQuery).matches
        ? 'panels'
        : 'stack',
    { wideQuery: CODING_WIDE_MEDIA_QUERY, mobileQuery: MOBILE_MEDIA_QUERY },
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
  const picker = page.getByRole('button', { name: /^Switch tool, current:/ });
  const mobile = await page.evaluate(
    (query) => window.matchMedia(query).matches,
    MOBILE_MEDIA_QUERY,
  );
  if (mobile) await picker.click();
  const item = codingViewItem(page, name).first();
  await expect(item).toBeVisible({ timeout: 20_000 });
  const label = mobile ? await item.locator('span').first().innerText() : '';
  await item.click();
  if (mobile) {
    await expect(page.getByRole('dialog', { name: 'Tools' })).toBeHidden();
    await expect(picker).toContainText(label.split('\n')[0]);
    await expect(
      page.locator('.coding-workbench__page--drill-in'),
    ).toHaveAttribute('data-active', 'true');
  } else if ((await codingRailMode(page)) === 'panels') {
    await expect(item).toHaveAttribute('aria-pressed', 'true');
    await expect(item).toHaveAttribute('aria-controls', /\S/);
    await expect(item).not.toHaveAttribute('aria-current', /.*/);
  } else {
    await expect(item).toHaveAttribute('aria-current', 'page');
    await expect(item).not.toHaveAttribute('aria-pressed', /.*/);
  }
}
