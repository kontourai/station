import type { Page } from '@playwright/test';

/**
 * How a phone reaches Chat inventory since #4199: the dock header's ⋯ "Chat
 * actions" button opens the actions sheet, whose "Chat inventory" row opens
 * the reader. Desktop reaches the same row through More dock actions.
 */
export function phoneChatInventoryControls(page: Page) {
  const header = page
    .locator('#chat-dock')
    .getByTestId('chat-dock-mobile-header');
  return {
    header,
    chatActions: header.getByRole('button', {
      name: 'Chat actions',
      exact: true,
    }),
    inventoryRow: page.getByRole('menuitem', {
      name: 'Chat inventory',
      exact: true,
    }),
  };
}
