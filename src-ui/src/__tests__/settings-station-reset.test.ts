/**
 * "Reset Station settings" used to send `updateConfig({})` — an empty body
 * that the route sanitizes to an empty accepted set, so the confirm dialog
 * promised a factory reset and nothing was written. These assertions are
 * about the delta the button now sends: it must clear what is stored, and it
 * must never name a key the write path would refuse or misread.
 */
import type { SettingProvenanceEntry } from '@kontourai/station-contracts/settings-registry';
import { describe, expect, test } from 'vitest';
import {
  buildStationResetPlan,
  RESETTABLE_STATION_SETTING_KEYS,
} from '../views/settings/station-reset';

function fileProvenance(
  ...keys: string[]
): Record<string, SettingProvenanceEntry> {
  return Object.fromEntries(keys.map((key) => [key, { source: 'file' }]));
}

describe('buildStationResetPlan', () => {
  test('clears a rendered, non-required key that holds a stored value', () => {
    const plan = buildStationResetPlan(
      fileProvenance('terminalShell', 'systemPrompt'),
    );

    expect(plan.delta).toEqual({ terminalShell: null, systemPrompt: null });
    expect(plan.keys).toEqual(['terminalShell', 'systemPrompt']);
    // The dialog names LABELS, not keys — a person reading the confirm has to
    // recognise the rows they are about to lose.
    expect(plan.labels).toEqual([
      'Terminal shell',
      'Default agent instructions',
    ]);
  });

  test('never names a key the write path would refuse or misread', () => {
    // Every excluded key claimed as stored: an inclusion bug would surface
    // here rather than as a 400 (required), a silent re-store (nullable), or
    // a route refusal (logLevel, firstRun).
    const plan = buildStationResetPlan(
      fileProvenance(
        'defaultModel',
        'invokeModel',
        'structureModel',
        'builtinAgentEngineConnectionId',
        'firstRun',
        'logLevel',
        'runtime',
        'terminalShell',
      ),
    );

    expect(Object.keys(plan.delta)).toEqual(['terminalShell']);
    for (const excluded of [
      'defaultModel',
      'invokeModel',
      'structureModel',
      'builtinAgentEngineConnectionId',
      'firstRun',
      'logLevel',
    ]) {
      expect(RESETTABLE_STATION_SETTING_KEYS).not.toContain(excluded);
      expect(plan.delta).not.toHaveProperty(excluded);
    }
  });

  test('never clears usage telemetry, whose default is the permissive state', () => {
    // A stored `telemetryEnabled` is almost always `false` — the artifact of
    // someone opting out — and the registry default is `true`. Clearing it
    // would turn telemetry back on under the word "reset".
    const plan = buildStationResetPlan(
      fileProvenance('telemetryEnabled', 'registryUrl'),
    );

    expect(plan.delta).toEqual({ registryUrl: null });
    expect(plan.delta).not.toHaveProperty('telemetryEnabled');
    expect(RESETTABLE_STATION_SETTING_KEYS).not.toContain('telemetryEnabled');
    expect(plan.labels).not.toContain('Usage telemetry');
  });

  test('a default- or env-sourced value is not stored, so it is not cleared', () => {
    const plan = buildStationResetPlan({
      mcpUiHost: { source: 'default' },
      region: { source: 'env', envVar: 'AWS_REGION' },
    });

    expect(plan.keys).toEqual([]);
    expect(plan.delta).toEqual({});
    expect(plan.labels).toEqual([]);
  });

  test('a seeded system prompt, which the server reports as "default", is not cleared', () => {
    // Same predicate as the case above — this names the key the server-side
    // seed comparison exists for (src-server/domain/app-config-seed.ts).
    // `loadAppConfigFile` writes the factory prompt into app.json itself, so
    // before that comparison it arrived here as `source: 'file'`, was listed
    // in every reset plan, was cleared, and came straight back on the next
    // read — a plan that could never reach empty.
    const plan = buildStationResetPlan({
      systemPrompt: { source: 'default' },
      templateVariables: { source: 'default' },
      terminalShell: { source: 'file' },
    });

    expect(plan.delta).toEqual({ terminalShell: null });
    expect(plan.keys).not.toContain('systemPrompt');
    expect(plan.keys).not.toContain('templateVariables');
  });

  test('missing provenance yields an empty plan rather than a blanket clear', () => {
    expect(buildStationResetPlan(undefined).delta).toEqual({});
  });

  test('the candidate list covers the rows the page actually renders', () => {
    // Pinned literally: derived-from-the-registry is what keeps this list
    // honest, but a filter that silently stopped matching would still read
    // "derived". These are the rows Station and Defaults render today.
    expect([...RESETTABLE_STATION_SETTING_KEYS]).toEqual([
      'approvalGuardian',
      'defaultMaxTurns',
      'defaultMaxOutputTokens',
      'defaultChatFontSize',
      'terminalShell',
      'mcpUiHost',
      'surfaceTrustFromVeritasEvidence',
      'disableDefaultSkillRegistries',
      'workspaceCheckpoints',
      'registryUrl',
      'distributionProfile',
      'systemPrompt',
      'region',
      'templateVariables',
    ]);
  });
});
