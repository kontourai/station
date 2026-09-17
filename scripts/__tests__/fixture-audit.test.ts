import type { Route } from '@playwright/test';
import { expect, test, vi } from 'vitest';

vi.mock('@playwright/test', async () => {
  const { expect } = await import('vitest');
  return { expect, test: { extend: (fixtures: unknown) => fixtures } };
});
const { rejectUnexpectedFixtureRequest, test: audited } = await import(
  '../../tests/helpers/fixture-audit'
);
const runAudit = (
  audited as unknown as {
    fixtureAudit: [
      (context: { page: object }, use: () => Promise<void>) => Promise<void>,
    ];
  }
).fixtureAudit[0];

test('an unexpected request fails teardown without exposing its query credentials', async () => {
  const page = {};
  const fulfill = vi.fn().mockResolvedValue(undefined);
  const route = {
    request: () => ({
      method: () => 'GET',
      url: () => 'https://fixture.test/api/missing?token=private-value',
      frame: () => ({ page: () => page }),
    }),
    fulfill,
  } as unknown as Route;
  let failure: Error | undefined;
  try {
    await runAudit({ page }, async () => {
      await rejectUnexpectedFixtureRequest(route);
    });
  } catch (error) {
    failure = error as Error;
  }
  expect(failure?.message).toContain('GET /api/missing');
  expect(failure?.message).not.toContain('private-value');
  expect(fulfill).toHaveBeenCalledWith(
    expect.objectContaining({ status: 501 }),
  );
  await expect(runAudit({ page }, async () => {})).resolves.toBeUndefined();
});

test('a declared fixture with no unexpected reads completes normally', async () => {
  await expect(runAudit({ page: {} }, async () => {})).resolves.toBeUndefined();
});
