/** Server-backed browser proof for the rejected-manifest repair journey. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { expect, test } from './helpers/authenticated-request';

const REJECTED_DIRECTORY = 'Legacy_Plugin';

function runnerOwnedPluginDirectory(): string {
  const home = process.env.STATION_E2E_HOME;
  if (process.env.STATION_E2E_RUNNER !== '1' || !home || !isAbsolute(home)) {
    throw new Error(
      'Plugin rejection proof requires the managed runner-owned Station home.',
    );
  }
  const pluginsDirectory = join(home, 'plugins');
  const pluginDirectory = join(pluginsDirectory, REJECTED_DIRECTORY);
  const containment = relative(pluginsDirectory, pluginDirectory);
  if (
    containment === '' ||
    containment === '..' ||
    containment.startsWith(`..${sep}`) ||
    isAbsolute(containment)
  ) {
    throw new Error('Plugin rejection fixture escaped the runner-owned home.');
  }
  return pluginDirectory;
}

test('keeps a real rejected installed plugin visible and recovers after repair', async ({
  authenticatedRequest,
  page,
}) => {
  const pluginDirectory = runnerOwnedPluginDirectory();
  mkdirSync(pluginDirectory, { recursive: true });
  writeFileSync(
    join(pluginDirectory, 'plugin.json'),
    JSON.stringify({ name: REJECTED_DIRECTORY, version: '1.0.0' }),
  );

  try {
    await page.goto('/plugins');

    await page.getByRole('button', { name: /Legacy_Plugin Rejected/ }).click();
    await expect(page.getByText('Rejected', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(
      'not a canonical plugin id',
    );
    await expect(
      page.getByText(/Use 1–64 lowercase letters, digits, hyphens, or periods/),
    ).toBeVisible();
    await expect(
      page.locator('.detail-panel').getByRole('button', { name: 'Remove' }),
    ).toHaveCount(0);

    writeFileSync(
      join(pluginDirectory, 'plugin.json'),
      JSON.stringify({
        name: 'legacy-plugin',
        displayName: 'Legacy Plugin',
        version: '2.0.0',
      }),
    );
    await page.getByRole('button', { name: 'Reload plugins' }).click();

    await expect(
      page.getByText('Legacy Plugin', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/v2\.0\.0/)).toBeVisible();
    await expect(page.getByText('Rejected', { exact: true })).toHaveCount(0);
  } finally {
    rmSync(pluginDirectory, { recursive: true, force: true });
    const response = await authenticatedRequest.post('/api/plugins/reload');
    expect(response.ok()).toBe(true);
  }
});
