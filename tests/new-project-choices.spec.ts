import { expect } from '@playwright/test';
import { test } from './helpers/fixture-audit';

test('new project icon choices and Home scope render at desktop and phone widths', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const scope = page.getByRole('combobox', { name: 'Inbox scope' });
  await expect(scope).toHaveValue('current-project');
  await scope.selectOption('all');
  await expect(scope).toHaveValue('all');
  for (const theme of ['dark', 'light']) {
    for (const width of [390, 412, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 915 });
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      await page.screenshot({
        path: testInfo.outputPath(`home-scope-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.locator('[data-new-project-trigger]').click();
  await page.getByRole('button', { name: 'Choose project icon' }).click();
  const none = page.getByRole('button', { name: 'No icon', exact: true });
  await expect(none).toHaveAttribute('aria-pressed', 'false');
  await none.click();
  await expect(none).toHaveAttribute('aria-pressed', 'true');
  for (const theme of ['dark', 'light']) {
    for (const width of [390, 412, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 915 });
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      await expect(none).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`new-project-icon-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
});
