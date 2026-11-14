import { expect, type Locator, type Page } from '@playwright/test';

type Scope = Page | Locator;
function owningPage(scope: Scope): Page {
  return 'page' in scope ? scope.page() : scope;
}

/** Open the real, portaled setup using its trigger; never interact with inert choices. */
async function openRunSetup(scope: Scope): Promise<Locator> {
  const page = owningPage(scope);
  const panel = page.getByRole('dialog', { name: 'Run setup', exact: true });
  if (!(await panel.isVisible())) {
    // Both composer owners place setup in the bottom toolbar next to Send/Start.
    await scope
      .locator('.chat-controls-row, .start-composer__bar')
      .getByTestId('run-setup-trigger')
      .last()
      .click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

export async function runSetupControl(
  scope: Scope,
  select: (panel: Locator) => Locator,
): Promise<Locator> {
  return select(await openRunSetup(scope));
}

/** Call after the child picker settles, before returning to the draft. */
export async function closeRunSetup(scope: Scope): Promise<void> {
  const panel = owningPage(scope).getByRole('dialog', {
    name: 'Run setup',
    exact: true,
  });
  if (await panel.isVisible())
    await panel
      .getByRole('button', { name: 'Close run setup', exact: true })
      .click();
}
