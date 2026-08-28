// @vitest-environment node

import type { AppConfig } from '@kontourai/station-contracts/config';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildAppConfigProvenance,
  sanitizeAppConfigUpdate,
} from '../settings-registry-server.js';

describe('sanitizeAppConfigUpdate', () => {
  test('passes a valid partial update through untouched', () => {
    const result = sanitizeAppConfigUpdate({
      logLevel: 'debug',
      defaultChatFontSize: 16,
    });
    expect(result.accepted).toEqual({
      logLevel: 'debug',
      defaultChatFontSize: 16,
    });
    expect(result.ignored).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  test('strips and reports unknown keys without rejecting the request', () => {
    const result = sanitizeAppConfigUpdate({
      logLevel: 'info',
      apiEndpoint: 'http://example.com',
    });
    expect(result.accepted).toEqual({ logLevel: 'info' });
    expect(result.ignored).toEqual([{ key: 'apiEndpoint', reason: 'unknown' }]);
    expect(result.violations).toEqual([]);
  });

  test('strips and reports runtime-derived (internal) keys', () => {
    const result = sanitizeAppConfigUpdate({
      managedChatOrchestration: true,
      mcpUiFrameOrigin: 'http://127.0.0.1:4555',
    });
    expect(result.accepted).toEqual({});
    expect(result.ignored).toEqual(
      expect.arrayContaining([
        { key: 'managedChatOrchestration', reason: 'runtime-derived' },
        { key: 'mcpUiFrameOrigin', reason: 'runtime-derived' },
      ]),
    );
  });

  test('reports an enum violation naming the allowed values', () => {
    const result = sanitizeAppConfigUpdate({ logLevel: 'nope' });
    expect(result.accepted).toEqual({});
    expect(result.violations).toEqual([
      {
        key: 'logLevel',
        message: 'logLevel: expected one of trace|debug|info|warn|error',
      },
    ]);
  });

  test('reports a number constraint violation', () => {
    const result = sanitizeAppConfigUpdate({ defaultChatFontSize: 4 });
    expect(result.violations).toEqual([
      {
        key: 'defaultChatFontSize',
        message: 'defaultChatFontSize: expected at least 10',
      },
    ]);
  });

  test('reports an integer violation for a whole-number-only field', () => {
    const result = sanitizeAppConfigUpdate({ defaultMaxTurns: 2.5 });
    expect(result.violations).toEqual([
      {
        key: 'defaultMaxTurns',
        message: 'defaultMaxTurns: expected an integer',
      },
    ]);
  });

  test('accepts a composite value as-is (AJV validates structure at save time)', () => {
    const guardian = { enabled: true, mode: 'review' as const };
    const result = sanitizeAppConfigUpdate({ approvalGuardian: guardian });
    expect(result.accepted).toEqual({ approvalGuardian: guardian });
    expect(result.violations).toEqual([]);
  });

  test('accepts null/undefined on a registered key as an explicit clear', () => {
    const result = sanitizeAppConfigUpdate({
      region: null,
      gitRemote: undefined,
    });
    expect(result.accepted).toEqual({ region: null, gitRemote: undefined });
    expect(result.violations).toEqual([]);
  });

  test('rejects a value with the wrong primitive type', () => {
    const result = sanitizeAppConfigUpdate({ mcpUiHost: 'yes' });
    expect(result.violations).toEqual([
      { key: 'mcpUiHost', message: 'mcpUiHost: expected a boolean' },
    ]);
  });

  // station#settings-revamp slice-1 review finding 2: null/undefined on a
  // REQUIRED key (the file schema's `required` list, mirrored via the
  // registry's `required` flag) is a violation, not an accepted clear —
  // clearing it would leave the persisted config failing AJV's `required`
  // check the next time it's loaded.
  test('rejects clearing a required key, naming it in the violation', () => {
    const result = sanitizeAppConfigUpdate({ defaultModel: null });
    expect(result.accepted).toEqual({});
    expect(result.violations).toEqual([
      {
        key: 'defaultModel',
        message: 'defaultModel: required — cannot be cleared',
      },
    ]);
  });

  test('rejects clearing every required key (defaultModel, invokeModel, structureModel)', () => {
    const result = sanitizeAppConfigUpdate({
      defaultModel: null,
      invokeModel: undefined,
      structureModel: null,
    });
    expect(result.accepted).toEqual({});
    expect(result.violations.map((v) => v.key).sort()).toEqual(
      ['defaultModel', 'invokeModel', 'structureModel'].sort(),
    );
  });

  test('a required key with a valid value still passes through normally', () => {
    const result = sanitizeAppConfigUpdate({ defaultModel: 'claude-3' });
    expect(result.accepted).toEqual({ defaultModel: 'claude-3' });
    expect(result.violations).toEqual([]);
  });
});

describe('buildAppConfigProvenance', () => {
  const ORIGINAL_AWS_REGION = process.env.AWS_REGION;

  beforeEach(() => {
    delete process.env.AWS_REGION;
  });

  afterEach(() => {
    if (ORIGINAL_AWS_REGION === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = ORIGINAL_AWS_REGION;
    }
  });

  test('marks every key present in the loaded config as source "file"', () => {
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
        logLevel: 'info',
      },
      { injected: {} },
    );
    expect(provenance.defaultModel).toEqual({ source: 'file' });
    expect(provenance.logLevel).toEqual({ source: 'file' });
  });

  test('marks injected keys as source "env" with their env var', () => {
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
      },
      {
        injected: {
          mcpUiFrameOrigin: 'MCP_UI_FRAME_PORT',
          managedChatOrchestration: 'STATION_FEATURES',
        },
      },
    );
    expect(provenance.mcpUiFrameOrigin).toEqual({
      source: 'env',
      envVar: 'MCP_UI_FRAME_PORT',
    });
    expect(provenance.managedChatOrchestration).toEqual({
      source: 'env',
      envVar: 'STATION_FEATURES',
    });
  });

  test.each(['0', 'false', 'off', 'disabled', '1', 'true', 'on', 'enabled'])(
    'USAGE TELEMETRY PROVENANCE DEFECT: STATION_TELEMETRY_ENABLED=%s is recognized',
    (value) => {
      process.env.STATION_TELEMETRY_ENABLED = value;
      const provenance = buildAppConfigProvenance({} as AppConfig, {
        injected: {},
      });
      expect(
        provenance.telemetryEnabled,
        `telemetry env spelling ${value} was not reported as its effective source`,
      ).toEqual({ source: 'env', envVar: 'STATION_TELEMETRY_ENABLED' });
      delete process.env.STATION_TELEMETRY_ENABLED;
    },
  );

  // archive#1557. Provenance reports where the effective value comes from.
  // A set AWS_REGION does not make a stored region inert — `resolveBedrockRegion`
  // reads the stored value first — so the entry stays a plain 'file'.
  test('a stored value is source "file" even when the declared env fallback is set', () => {
    process.env.AWS_REGION = 'us-west-2';
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
        region: 'eu-west-1',
      },
      { injected: {} },
    );
    expect(provenance.region).toEqual({ source: 'file' });
  });

  test('an absent key whose env fallback is set is source "env", naming the var', () => {
    process.env.AWS_REGION = 'us-west-2';
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
      },
      { injected: {} },
    );
    expect(provenance.region).toEqual({
      source: 'env',
      envVar: 'AWS_REGION',
    });
  });

  // archive#1557 review fix (M4). `resolveBedrockRegion` trims and treats a
  // whitespace-only value as absent. Provenance used a bare truthiness test,
  // so these two cases had Settings naming a source the resolver discards —
  // the surface re-deriving "absent" for itself, which is exactly what the
  // shared resolver exists to stop.
  test('a whitespace-only env fallback is not a source', () => {
    process.env.AWS_REGION = '   ';
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
      },
      { injected: {} },
    );
    expect('region' in provenance).toBe(false);
  });

  test('a whitespace-only stored value is not reported as "file"', () => {
    process.env.AWS_REGION = 'us-west-2';
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
        region: '   ',
      },
      { injected: {} },
    );
    // The resolver discards the stored blank and falls through to the env, so
    // that is what provenance must name.
    expect(provenance.region).toEqual({
      source: 'env',
      envVar: 'AWS_REGION',
    });
  });

  // Found by the round-2 LIVE boot check, not by any unit test: Station booted
  // fine with AWS_REGION=US-EAST-1 (the resolver discards it) while
  // `GET /config/app` still reported `{source: 'env', envVar: 'AWS_REGION'}`,
  // so Settings rendered "Set by operator: AWS_REGION" over a value nothing
  // used. Naming a source is a claim about what applies.
  test('a malformed env fallback is not named as the source', () => {
    process.env.AWS_REGION = 'US-EAST-1';
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
      },
      { injected: {} },
    );
    expect('region' in provenance).toBe(false);
  });

  test('an absent key with no env fallback set reports nothing about region', () => {
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
      },
      { injected: {} },
    );
    expect('region' in provenance).toBe(false);
  });

  test('skips undefined config values', () => {
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
        gitRemote: undefined,
      },
      { injected: {} },
    );
    expect('gitRemote' in provenance).toBe(false);
  });

  // station#settings-revamp slice-1 review finding 3: the design contract
  // (docs/design/settings-architecture.md §4) promises default|file|env.
  test('marks a registered key absent from the config as source "default" when it declares a defaultValue', () => {
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
        // mcpUiHost intentionally absent.
      },
      { injected: {} },
    );
    expect(provenance.mcpUiHost).toEqual({ source: 'default' });
  });

  test('a present key reports source "file" even though the registry declares a defaultValue for it', () => {
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
        mcpUiHost: false,
      },
      { injected: {} },
    );
    expect(provenance.mcpUiHost).toEqual({ source: 'file' });
  });

  test('a registered key with no defaultValue and absent from the config gets no provenance entry', () => {
    const provenance = buildAppConfigProvenance(
      {
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
        // gitRemote absent, and it declares no defaultValue.
      },
      { injected: {} },
    );
    expect('gitRemote' in provenance).toBe(false);
  });
});
