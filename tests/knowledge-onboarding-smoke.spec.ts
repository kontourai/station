import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';

/**
 * K4 smoke coverage (`smoke-live` bucket) — real temp-home backend, no route
 * mocking. Browser interactions use the UI session while direct assertions
 * use the request-only authenticated fixture against the isolated E2E API.
 * Exercises both the
 * AC1-coldstart-root single-click personal store creation, and the
 * AC2-adoption-walk Obsidian-vault
 * connect slice (real filesystem vault fixture, real validate+create routes,
 * never a route mock) — including the honest validation failure path (an
 * empty directory with no `.obsidian/` marker) rendering the adapter's own
 * `reason` string.
 *
 * `test.describe.serial` is deliberate: this instance's `KnowledgeStoreProvider`
 * allows exactly one personal root at a time, and the "connect an existing
 * Obsidian vault instead" affordance only renders while no personal root
 * exists yet (see `KnowledgeStoreSection.tsx`) — so the default-store test
 * runs first, cleans its own root up via the real `DELETE` route, and only
 * then does the Obsidian slice see the empty state it needs.
 */
const API = resolveE2EApiBase();

async function fetchRoots(request: AuthenticatedE2ERequest) {
  return (await request.get(`${API}/api/knowledge/roots`)).json();
}

async function deleteRoot(request: AuthenticatedE2ERequest, id: string) {
  return (await request.delete(`${API}/api/knowledge/roots/${id}`)).json();
}

test.describe
  .serial('Knowledge onboarding smoke (K4)', () => {
    let vaultDir: string;
    let emptyDir: string;

    test.beforeAll(() => {
      vaultDir = mkdtempSync(join(tmpdir(), 'knowledge-onboarding-vault-'));
      mkdirSync(join(vaultDir, '.obsidian'));
      writeFileSync(
        join(vaultDir, 'welcome.md'),
        '# Welcome\n\nA sample smoke-test note.\n',
      );
      emptyDir = mkdtempSync(join(tmpdir(), 'knowledge-onboarding-empty-'));
    });

    test.afterAll(() => {
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(emptyDir, { recursive: true, force: true });
    });

    test('a cold-start user reaches a working personal knowledge store with one click', async ({
      page,
      authenticatedRequest,
    }) => {
      await page.goto('/settings');
      await page.waitForSelector('#section-knowledge', { timeout: 15_000 });
      const section = page.locator('#section-knowledge');

      await expect(section.getByText('Personal knowledge is off')).toBeVisible({
        timeout: 10_000,
      });

      await section
        .getByRole('button', { name: 'Create recommended store' })
        .click();

      // (a) the Settings UI shows the new store.
      const createdCard = section.locator('.knowledge-store-section__card');
      await expect(createdCard).toBeVisible({ timeout: 10_000 });
      await expect(
        createdCard.getByText('Personal knowledge store', { exact: true }),
      ).toBeVisible();
      await expect(createdCard.getByText('Default File Store')).toBeVisible();

      // (b) a direct fetch to /api/knowledge/roots confirms the real root.
      const roots = await fetchRoots(authenticatedRequest);
      expect(roots.success).toBe(true);
      const personalRoot = roots.data.find(
        (root: { scope?: { kind?: string } }) =>
          root.scope?.kind === 'personal',
      );
      expect(personalRoot).toBeTruthy();
      expect(personalRoot.id).toBe('root:personal');
      expect(personalRoot.adapterId).toBe('kit-default-store');

      // Reset to an empty personal-root state for the Obsidian slice below —
      // `removeRoot` only deregisters (never deletes store files, per K2's own
      // guarantee), so this is a safe real-API cleanup call, not a mock.
      const deletion = await deleteRoot(authenticatedRequest, 'root:personal');
      expect(deletion.success).toBe(true);
    });

    test('connecting an existing Obsidian vault is honest about a bad path and real about a good one', async ({
      page,
      authenticatedRequest,
    }) => {
      await page.goto('/settings');
      await page.waitForSelector('#section-knowledge', { timeout: 15_000 });
      const section = page.locator('#section-knowledge');

      await expect(section.getByText('Personal knowledge is off')).toBeVisible({
        timeout: 10_000,
      });

      await section
        .getByRole('button', {
          name: 'Connect an existing Obsidian vault instead',
        })
        .click();

      const vaultInput = section.getByPlaceholder('/path/to/vault');

      // Honest failure: an empty directory with no .obsidian/ marker.
      await vaultInput.fill(emptyDir);
      await page.keyboard.press('Escape');
      await section.getByRole('button', { name: 'Validate' }).click();
      await expect(
        section.getByText(
          'storeRoot is an empty directory with no .obsidian/ vault marker',
        ),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        section.getByRole('button', { name: 'Connect' }),
      ).toBeDisabled();

      // Real success: a minimal Obsidian-shaped vault (.obsidian/ + one note).
      await vaultInput.fill(vaultDir);
      await page.keyboard.press('Escape');
      await section.getByRole('button', { name: 'Validate' }).click();
      await expect(
        section.getByText(
          'storeRoot is an empty directory with no .obsidian/ vault marker',
        ),
      ).toHaveCount(0);
      await expect(
        section.getByRole('button', { name: 'Connect' }),
      ).toBeEnabled({ timeout: 10_000 });
      await section.getByRole('button', { name: 'Connect' }).click();

      const connectedCard = section.locator('.knowledge-store-section__card');
      await expect(connectedCard).toBeVisible({ timeout: 10_000 });
      await expect(
        connectedCard.getByText('Personal knowledge store', { exact: true }),
      ).toBeVisible();
      await expect(
        connectedCard.getByText('Obsidian Vault Store'),
      ).toBeVisible();

      const roots = await fetchRoots(authenticatedRequest);
      expect(roots.success).toBe(true);
      const personalRoot = roots.data.find(
        (root: { scope?: { kind?: string } }) =>
          root.scope?.kind === 'personal',
      );
      expect(personalRoot).toBeTruthy();
      expect(personalRoot.id).toBe('root:personal');
      expect(personalRoot.adapterId).toBe('kit-obsidian-store');
      expect(personalRoot.storeRoot).toBe(vaultDir);

      // Leave the instance clean for any later smoke-live runs in this suite.
      const deletion = await deleteRoot(authenticatedRequest, 'root:personal');
      expect(deletion.success).toBe(true);
    });
  });
