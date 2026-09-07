import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { afterEach, expect, test, vi } from 'vitest';
import { runCloudCommand } from '../commands/cloud.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setClientCredentialResolver(undefined);
});
test('cloud verify-target uses the SDK observation and prints no enrollment credential', async () => {
  vi.stubEnv('STATION_API_CREDENTIAL', 'synthetic-cloud-target-secret');
  const identity = {
    instanceId: 'fixture',
    bootId: 'fixture-boot',
    sha: 'a'.repeat(40),
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(identity)))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ environmentId: 'fixture-environment' })),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify(identity)));
  vi.stubGlobal('fetch', fetch);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runCloudCommand([
    'verify-target',
    '--api-base=http://127.0.0.1:29876',
    '--json',
  ]);
  const output = JSON.parse(log.mock.calls[0][0]);
  expect(output).toMatchObject({
    ...identity,
    environmentId: 'fixture-environment',
    executionAuthorityTransferred: false,
  });
  expect(log.mock.calls[0][0]).not.toContain('synthetic-cloud-target-secret');
  expect(fetch).toHaveBeenCalledTimes(3);
});
test.each([
  { args: [] },
  { args: ['--station'] },
  { args: ['--station=one', '--api-base=https://station.example.test'] },
])('requires an explicit unambiguous target $args', async ({ args }) => {
  await expect(runCloudCommand(['verify-target', ...args])).rejects.toThrow(
    'Select one enrolled target',
  );
});
