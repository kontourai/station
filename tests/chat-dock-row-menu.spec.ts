import { expect } from '@playwright/test';
import { mockChatShell } from './helpers/chat-shell-fixture';
import { test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  installMockOrchestrationSse,
} from './helpers/orchestration';
import { storeConversation } from './helpers/stored-conversation-fixture';

// The row's ⋯ menu is the only way to act on a row: Mark done with its
// Undo, then the snooze list and Wake now, in the running app.
test('a Chats row menu marks done with Undo, and snoozes and wakes', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockChatShell(page);
  await installMockOrchestrationSse(page);
  await storeConversation(page);

  await page.goto('/?dock=open&maximize=true');
  await dismissSetupLauncher(page);
  const list = page.locator('#chat-dock').getByRole('complementary', {
    name: 'Chats',
    exact: true,
  });
  const row = list.getByRole('button', { name: /^Station session\b/i });
  const actions = list.getByRole('button', { name: /^Actions for / });
  const openMenu = async () => {
    await row.hover();
    await actions.click();
    await expect(page.getByRole('menu')).toBeVisible();
  };

  await openMenu();
  await expect(
    page
      .getByRole('menuitem')
      .evaluateAll((items) =>
        items.map((item) => item.firstChild?.textContent),
      ),
  ).resolves.toEqual(
    expect.arrayContaining(['Open chat', 'Mark done', 'In 1 hour']),
  );
  await page.getByRole('menuitem', { name: 'Mark done', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row).toBeVisible();

  await openMenu();
  await page.getByRole('menuitem', { name: /^In 1 hour\b/ }).click();
  const snoozed = list.getByRole('button', { name: /^Snoozed/ });
  await expect(snoozed).toBeVisible();
  if ((await snoozed.getAttribute('aria-expanded')) === 'false')
    await snoozed.click();
  await openMenu();
  await page.getByRole('menuitem', { name: 'Wake now', exact: true }).click();
  await expect(list.getByRole('button', { name: /^Snoozed/ })).toHaveCount(0);
  await expect(row).toBeVisible();
});
