import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTelemetryTier } from '@kontourai/station-contracts/product-telemetry';
import { USAGE_TELEMETRY_INVENTORY_REVISION } from '@kontourai/station-shared/product-telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadAppConfigFile,
  mergeAppConfigUpdate,
} from '../config-loader-app.js';
import { resolveTelemetryConfiguration } from '../telemetry-configuration.js';

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
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
    ).toEqual({
      kontour: { tier: 'off', reason: 'DNT' },
      operator: { tier: 'off', reason: 'DNT' },
    });
    vi.stubEnv('DO_NOT_TRACK', '0');
    expect(
      resolveTelemetryConfiguration(base, process.env, { operator: true })
        .publishers.operator.tier,
    ).toBe('full');
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
    ).toEqual({
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
      const home = await mkdtemp(join(tmpdir(), 'station-tiers-'));
      homes.push(home);
      await mkdir(join(home, 'config'));
      await writeFile(
        join(home, 'config', 'app.json'),
        JSON.stringify({ ...base, telemetryEnabled: enabled }),
      );
      if (receipt !== 'absent')
        await writeFile(
          join(home, 'config', 'usage-telemetry-disclosure.json'),
          receipt === 'invalid'
            ? 'not-json'
            : JSON.stringify({
                acknowledgedAt: '2026-10-17T00:00:00.000Z',
                inventoryRevision:
                  receipt === 'current'
                    ? USAGE_TELEMETRY_INVENTORY_REVISION
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
