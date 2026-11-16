import type { Page } from '@playwright/test';

/**
 * How a phone reaches Chat inventory since #4199: the dock header's ⋯ "Chat
 * actions" button opens the actions sheet, whose "Chat inventory" row opens
 * the reader. Desktop: see `openDesktopChatInventory`.
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

/**
 * Desktop: the This chat card's footer link while the card is beside the
 * transcript; otherwise the More dock actions row (the menu carries it only
 * while the card is not shown).
 */
export async function openDesktopChatInventory(page: Page) {
  const card = page.locator('#chat-dock aside.session-context-card');
  if (await card.isVisible()) {
    await card
      .getByRole('button', { name: 'Chat inventory', exact: true })
      .click();
    return;
  }
  await page
    .locator('#chat-dock')
    .getByRole('button', { name: /^More dock actions/ })
    .click();
  await page
    .getByRole('menuitem', { name: 'Chat inventory', exact: true })
    .click();
}

/**
 * Desktop Background tasks: the This chat card's Activity row while the card
 * is beside the transcript, else the More dock actions row.
 */
export async function openDesktopBackgroundTasks(page: Page) {
  const card = page.locator('#chat-dock aside.session-context-card');
  if (await card.isVisible()) {
    await card.getByRole('button', { name: /Background tasks/ }).click();
    return;
  }
  await page.getByRole('button', { name: /^More dock actions/ }).click();
  await page.getByRole('menuitem', { name: /Background tasks/ }).click();
}
