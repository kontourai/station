import { fireEvent, screen, within } from '@testing-library/react';

/**
 * #3045 review M3: an action folded behind `⋯` is one a test has to go and
 * look for. These open a row's overflow menu and read back EVERY row in it by
 * role and name, in order, so removing a folded action — or its danger tone —
 * fails the row's own test rather than nothing at all.
 */
export function openOverflow(name: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.getByRole('menu', { name });
}

export function overflowItems(menu: HTMLElement) {
  return within(menu)
    .getAllByRole('menuitem')
    .map((row) => ({
      name: row.getAttribute('aria-label') ?? row.textContent ?? '',
      danger: row.className.includes('action-overflow__row--danger'),
    }));
}

/** Opens the menu named `menuName` and activates the row named `item`. */
export function chooseOverflow(menuName: string, item: string) {
  const menu = openOverflow(menuName);
  fireEvent.click(within(menu).getByRole('menuitem', { name: item }));
}
