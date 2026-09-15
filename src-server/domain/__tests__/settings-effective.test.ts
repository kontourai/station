/**
 * Epic #2144 slice 2. One test per source, plus the two cases where a naive
 * resolver reports the wrong one: a seeded value that nobody chose, and an
 * env var the field's own validator rejects.
 */

import type { AppConfig } from '@kontourai/station-contracts/config';
import { afterEach, describe, expect, test } from 'vitest';
import { APP_CONFIG_SEED } from '../app-config-seed.js';
import { resolveEffectiveAppSetting } from '../settings-effective.js';

const config = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    defaultModel: 'claude-3',
    invokeModel: 'claude-3',
    structureModel: 'claude-3',
    ...over,
  }) as AppConfig;

const ORIGINAL_AWS_REGION = process.env.AWS_REGION;

afterEach(() => {
  if (ORIGINAL_AWS_REGION === undefined) delete process.env.AWS_REGION;
  else process.env.AWS_REGION = ORIGINAL_AWS_REGION;
});

describe('resolveEffectiveAppSetting', () => {
  test('a project override outranks the Station file', () => {
    expect(
      resolveEffectiveAppSetting('defaultModel', {
        config: config({ defaultModel: 'station-model' }),
        projectOverrides: { defaultModel: 'project-model' },
      }),
    ).toEqual({ value: 'project-model', source: 'project' });
  });

  test('a stored Station value is the Station’s decision', () => {
    expect(
      resolveEffectiveAppSetting('terminalShell', {
        config: config({ terminalShell: '/bin/zsh' }),
      }),
    ).toEqual({ value: '/bin/zsh', source: 'station' });
  });

  test('a registered key with nothing stored resolves to its declared default', () => {
    expect(
      resolveEffectiveAppSetting('defaultWorkspaceIsolation', {
        config: config(),
      }),
    ).toEqual({ value: 'shared', source: 'default' });
  });

  test('a declared envFallback supplies the value when nothing is stored', () => {
    process.env.AWS_REGION = 'eu-west-1';
    expect(resolveEffectiveAppSetting('region', { config: config() })).toEqual({
      value: 'eu-west-1',
      source: 'env',
      envVar: 'AWS_REGION',
    });
  });

  /**
   * archive#1557's live defect, in this seam: naming the environment is a
   * claim that its value APPLIES, and the Bedrock resolver discards
   * `US-EAST-1` as malformed.
   */
  test('an envFallback the field’s validator rejects is not a source', () => {
    process.env.AWS_REGION = 'US-EAST-1';
    expect(resolveEffectiveAppSetting('region', { config: config() })).toEqual({
      value: undefined,
      source: 'default',
    });
  });

  test('a stored value outranks a valid envFallback', () => {
    process.env.AWS_REGION = 'eu-west-1';
    expect(
      resolveEffectiveAppSetting('region', {
        config: config({ region: 'ap-south-1' }),
      }),
    ).toEqual({ value: 'ap-south-1', source: 'station' });
  });

  /**
   * The loader writes `systemPrompt` into `config/app.json` itself and the
   * file keeps no record that it did. Reporting it as a Station decision is
   * what made "Reset Station settings" offer to clear values nobody set.
   */
  test('a value byte-equal to its loader-written seed is a default, not a decision', () => {
    // The literal the loader writes, read from the seed itself: a test that
    // derived this value from the resolver's own answer would pass under a
    // resolver that never consulted the seed at all.
    const seeded = APP_CONFIG_SEED.systemPrompt;
    expect(typeof seeded).toBe('string');
    expect(seeded.length).toBeGreaterThan(0);
    expect(
      resolveEffectiveAppSetting('systemPrompt', {
        config: config({ systemPrompt: seeded }),
      }),
    ).toEqual({ value: seeded, source: 'default' });
    expect(
      resolveEffectiveAppSetting('systemPrompt', {
        config: config({ systemPrompt: `${seeded} And one line of mine.` }),
      })?.source,
    ).toBe('station');
    expect(
      resolveEffectiveAppSetting('systemPrompt', {
        config: config({ systemPrompt: 'Something the operator wrote.' }),
      }),
    ).toEqual({ value: 'Something the operator wrote.', source: 'station' });
  });

  /**
   * Whitespace is the absence of a decision, not one — the same test
   * `buildAppConfigProvenance` applies. Re-deriving it here would be how the
   * two drift.
   */
  test('a whitespace-only stored value is not a decision', () => {
    expect(
      resolveEffectiveAppSetting('terminalShell', {
        config: config({ terminalShell: '   ' }),
      })?.source,
    ).toBe('default');
    expect(
      resolveEffectiveAppSetting('defaultModel', {
        config: config({ defaultModel: 'station-model' }),
        projectOverrides: { defaultModel: '  ' },
      }),
    ).toEqual({ value: 'station-model', source: 'station' });
  });

  test('an unregistered key has no honest answer', () => {
    expect(
      resolveEffectiveAppSetting('somethingNobodyDeclared', {
        config: config(),
      }),
    ).toBeUndefined();
  });
});
