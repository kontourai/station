import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveTelemetryTier } from '@kontourai/station-contracts/product-telemetry';
import { FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION } from '@kontourai/station-shared/product-telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  loadAppConfigFile,
  mergeAppConfigUpdate,
  saveAppConfigFile,
} from '../config-loader-app.js';
import { resolveTelemetryConfiguration } from '../telemetry-configuration.js';

const makeTempDir = trackTempDirs();
afterEach(() => vi.unstubAllEnvs());
const base = { defaultModel: 'test', invokeModel: '', structureModel: '' };
describe('telemetry policy', () => {
  it.each(['1', 'false', 'yes', ' '])(
    'DNT %j overrides an acknowledged explicit Full choice',
    (doNotTrack) => {
      expect(
        resolveTelemetryTier({
          userChoice: 'full',
          hasFullDisclosure: true,
          doNotTrack,
        }),
      ).toEqual({ tier: 'off', reason: 'DNT' });
    },
  );
  it.each([undefined, '', '0'])(
    'DNT %j leaves explicit consent intact',
    (doNotTrack) => {
      expect(
        resolveTelemetryTier({
          userChoice: 'full',
          hasFullDisclosure: true,
          doNotTrack,
        }),
      ).toEqual({ tier: 'full', reason: 'user' });
    },
  );
  it.each(['distributionDefault', 'operatorPolicy'] as const)(
    '%s may lower but never raise the default',
    (key) => {
      expect(
        resolveTelemetryTier({ [key]: 'full', hasFullDisclosure: true }),
      ).toEqual({ tier: 'lite', reason: 'default' });
      expect(
        resolveTelemetryTier({ [key]: 'off', hasFullDisclosure: true }),
      ).toEqual({ tier: 'off', reason: 'policy' });
      expect(
        resolveTelemetryTier({
          [key]: 'off',
          userChoice: 'full',
          hasFullDisclosure: true,
        }),
      ).toEqual({ tier: 'full', reason: 'user' });
    },
  );
  it('requires disclosure even for an explicit Full choice', () => {
    expect(
      resolveTelemetryTier({ userChoice: 'full', hasFullDisclosure: false }),
    ).toEqual({ tier: 'lite', reason: 'disclosure' });
  });
  it('resolves real process environment, aliases and per-publisher choices', () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    vi.stubEnv('STATION_TELEMETRY_TIER', 'full');
    vi.stubEnv('STATION_PRODUCT_TELEMETRY_ENABLED', 'false');
    expect(
      resolveTelemetryConfiguration(base, process.env, {
        kontour: true,
        operator: true,
      }).publishers,
    ).toMatchObject({
      kontour: { tier: 'off', reason: 'DNT' },
      operator: { tier: 'off', reason: 'DNT' },
    });
    vi.stubEnv('DO_NOT_TRACK', '0');
    expect(
      resolveTelemetryConfiguration(base, process.env, { operator: true })
        .publishers.operator,
    ).toMatchObject({ tier: 'lite', reason: 'environment', source: 'env' });
    vi.stubEnv('STATION_TELEMETRY_TIER', '');
    expect(
      resolveTelemetryConfiguration(base, process.env, { operator: true })
        .publishers.operator.tier,
    ).toBe('off');
    expect(
      resolveTelemetryConfiguration(
        { ...base, telemetryTier: { operator: 'full', kontour: 'off' } },
        process.env,
        { operator: true },
      ).publishers,
    ).toMatchObject({
      kontour: { tier: 'off', reason: 'user' },
      operator: { tier: 'full', reason: 'user' },
    });
    expect(
      resolveTelemetryConfiguration(base, {
        STATION_AUTHOR_TELEMETRY_ENDPOINT: 'https://example.invalid',
      }).authorEndpoint,
    ).toBeUndefined();
  });
});
it('environment defaults never grant Full and provenance is publisher-specific', () => {
  for (const env of [
    { STATION_TELEMETRY_TIER: 'full' },
    { STATION_PRODUCT_TELEMETRY_ENABLED: 'true' },
  ]) {
    expect(
      resolveTelemetryConfiguration(base, env, { operator: true }).publishers
        .operator,
    ).toMatchObject({ tier: 'lite', reason: 'environment', source: 'env' });
  }
  expect(
    resolveTelemetryConfiguration(
      { ...base, telemetryTier: { operator: 'full' } },
      { STATION_TELEMETRY_TIER: 'off' },
      { operator: true },
    ).publishers,
  ).toMatchObject({
    operator: { tier: 'full', reason: 'user', source: 'config' },
    kontour: { tier: 'off', reason: 'environment', source: 'env' },
  });
});

it('existing tier choices win over a stale persisted legacy alias', async () => {
  const home = makeTempDir('station-tier-alias-');
  await saveAppConfigFile(home, {
    ...base,
    telemetryTier: { operator: 'off', kontour: 'off' },
    telemetryEnabled: true,
  });
  expect((await loadAppConfigFile(home)).telemetryTier).toEqual({
    operator: 'off',
    kontour: 'off',
  });
  expect(
    JSON.parse(await readFile(join(home, 'config', 'app.json'), 'utf8')),
  ).not.toHaveProperty('telemetryEnabled');
  expect(
    mergeAppConfigUpdate(
      { ...base, telemetryTier: { operator: 'off' } },
      { telemetryEnabled: true },
    ),
  ).toMatchObject({ telemetryTier: { operator: 'full' } });
  expect(
    mergeAppConfigUpdate(
      { ...base, telemetryTier: { operator: 'off' } },
      { telemetryEnabled: true },
    ),
  ).not.toHaveProperty('telemetryEnabled');
});

describe('persisted telemetry migration', () => {
  it.each([
    { enabled: false, receipt: 'current', operator: 'off', kontour: 'off' },
    { enabled: true, receipt: 'current', operator: 'full', kontour: 'lite' },
    { enabled: true, receipt: 'stale', operator: 'lite', kontour: 'lite' },
    { enabled: true, receipt: 'absent', operator: 'lite', kontour: 'lite' },
    { enabled: true, receipt: 'invalid', operator: 'lite', kontour: 'lite' },
  ])(
    'migrates $enabled with $receipt receipt through the real app.json loader',
    async ({ enabled, receipt, operator, kontour }) => {
      const home = makeTempDir('station-tiers-');
      await saveAppConfigFile(home, { ...base, telemetryEnabled: enabled });
      if (receipt !== 'absent')
        await writeFile(
          join(home, 'config', 'usage-telemetry-disclosure.json'),
          receipt === 'invalid'
            ? 'not-json'
            : JSON.stringify({
                acknowledgedAt: '2026-10-17T00:00:00.000Z',
                inventoryRevision:
                  receipt === 'current'
                    ? FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION
                    : 'old',
              }),
        );
      const loaded = await loadAppConfigFile(home);
      expect(loaded.telemetryTier).toEqual({ operator, kontour });
      const persisted = JSON.parse(
        await readFile(join(home, 'config', 'app.json'), 'utf8'),
      );
      expect(persisted.telemetryTier).toEqual({ operator, kontour });
      expect(persisted).not.toHaveProperty('telemetryEnabled');
      expect((await loadAppConfigFile(home)).telemetryTier).toEqual({
        operator,
        kontour,
      });
    },
  );
  it('merges one publisher without changing another and supports legacy withdrawal', () => {
    const config = {
      ...base,
      telemetryTier: { kontour: 'off', operator: 'full' },
    } as const;
    expect(
      mergeAppConfigUpdate(config, { telemetryTier: { operator: 'lite' } })
        .telemetryTier,
    ).toEqual({ kontour: 'off', operator: 'lite' });
    expect(
      mergeAppConfigUpdate(config, { telemetryEnabled: false }).telemetryTier,
    ).toEqual({ kontour: 'off', operator: 'off' });
    for (const update of [
      { telemetryTier: config.telemetryTier, telemetryEnabled: false },
      { telemetryEnabled: false, telemetryTier: config.telemetryTier },
    ])
      expect(mergeAppConfigUpdate(config, update).telemetryTier).toEqual({
        kontour: 'off',
        operator: 'off',
      });
    expect(
      mergeAppConfigUpdate(
        { ...base, telemetryTier: { kontour: 'lite', operator: 'full' } },
        { telemetryEnabled: false },
      ).telemetryTier,
    ).toEqual({ kontour: 'off', operator: 'off' });
  });
});
