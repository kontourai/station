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

test('the ambient focus report is modeled as its real 204, not recorded as unexpected', async () => {
  const page = {};
  const fulfill = vi.fn().mockResolvedValue(undefined);
  const route = {
    request: () => ({
      method: () => 'POST',
      url: () => 'https://fixture.test/api/presence/focus',
      frame: () => ({ page: () => page }),
    }),
    fulfill,
  } as unknown as Route;
  await expect(
    runAudit({ page }, async () => {
      await rejectUnexpectedFixtureRequest(route);
    }),
  ).resolves.toBeUndefined();
  expect(fulfill).toHaveBeenCalledWith({ status: 204 });

  // Only the exact POST is ambient: a read of the same path is still a gap.
  const read = {
    request: () => ({
      method: () => 'GET',
      url: () => 'https://fixture.test/api/presence/focus',
      frame: () => ({ page: () => page }),
    }),
    fulfill: vi.fn().mockResolvedValue(undefined),
  } as unknown as Route;
  await expect(
    runAudit({ page }, async () => {
      await rejectUnexpectedFixtureRequest(read);
    }),
  ).rejects.toThrow('GET /api/presence/focus');
});

test('the ambient managed-policy status read is modeled as its real no-policy body, not recorded as unexpected', async () => {
  const page = {};
  const fulfill = vi.fn().mockResolvedValue(undefined);
  const route = {
    request: () => ({
      method: () => 'GET',
      url: () => 'https://fixture.test/api/settings/managed-policy',
      frame: () => ({ page: () => page }),
    }),
    fulfill,
  } as unknown as Route;
  await expect(
    runAudit({ page }, async () => {
      await rejectUnexpectedFixtureRequest(route);
    }),
  ).resolves.toBeUndefined();
  // The route's own envelope with no policy installed (#4518).
  expect(fulfill).toHaveBeenCalledWith({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { state: 'none' } }),
  });

  // Only the exact GET is ambient: a write to the same path is still a gap.
  const write = {
    request: () => ({
      method: () => 'POST',
      url: () => 'https://fixture.test/api/settings/managed-policy',
      frame: () => ({ page: () => page }),
    }),
    fulfill: vi.fn().mockResolvedValue(undefined),
  } as unknown as Route;
  await expect(
    runAudit({ page }, async () => {
      await rejectUnexpectedFixtureRequest(write);
    }),
  ).rejects.toThrow('POST /api/settings/managed-policy');
});
