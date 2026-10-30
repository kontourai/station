import { fireEvent, screen, within } from '@testing-library/react';

/**
 * Opens an inbox row's ⋯ menu ("More actions") and returns the named item.
 * Rows keep their secondary actions (snooze, dismiss) there, so a test that
 * dismisses or snoozes goes through the same two clicks a person does.
 */
export function openRowAction(
  name: string,
  { index = 0, within: scope }: { index?: number; within?: HTMLElement } = {},
): HTMLButtonElement {
  const root = scope ? within(scope) : screen;
  const trigger = root.getAllByRole('button', { name: 'More actions' })[index];
  if (!trigger) throw new Error(`No row menu at index ${index}`);
  fireEvent.click(trigger);
  // An item's accessible name is its label, then any hint ("1 hour, 8:01 PM").
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return screen.getByRole('menuitem', {
    name: new RegExp(`^${escaped}(,|$)`),
  }) as HTMLButtonElement;
}

export function chooseRowAction(
  name: string,
  options?: { index?: number; within?: HTMLElement },
) {
  fireEvent.click(openRowAction(name, options));
}
