/**
 * "Reset Station settings" used to send `updateConfig({})` — an empty body
 * that the route sanitizes to an empty accepted set, so the confirm dialog
 * promised a factory reset and nothing was written. These assertions are
 * about the delta the button now sends: it must clear what is stored, and it
 * must never name a key the write path would refuse or misread.
 */

import {
  DEVICE_SETTINGS_REGISTRY,
  DIRECT_MANIPULATION_DEVICE_KEYS,
} from '@kontourai/station-contracts/device-settings';
import type { SettingProvenanceEntry } from '@kontourai/station-contracts/settings-registry';
import { describe, expect, test } from 'vitest';
import {
  buildDeviceResetPlan,
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
    // Pinned literally, and this is the assertion #2182 turns on. The list is
    // derived from the settings CATALOG, which spans every card the page
    // draws; it used to be derived from one card's own key list, so moving a
    // row to a different card would have dropped it from the reset with
    // nothing red — the dialog names only the keys that are currently stored,
    // so a shorter list still reads as plausible. A literal expectation is
    // the only thing that can see that, because "derived" keeps reading as
    // derived while the thing it derives from shrinks.
    //
    // Order is render order, which is catalog order — so it moved when
    // #2182 redistributed the rows across six sections. The SET is asserted
    // separately below and is unchanged; that is the property a reset
    // depends on.
    expect([...RESETTABLE_STATION_SETTING_KEYS]).toEqual([
      // Station host
      'terminalShell',
      'mcpUiHost',
      'surfaceTrustFromVeritasEvidence',
      // Sources
      'registryUrl',
      'disableDefaultSkillRegistries',
      'distributionProfile',
      // Permissions
      'approvalGuardian',
      'defaultApprovalMode',
      // Agent runs
      'region',
      'systemPrompt',
      'templateVariables',
      'defaultMaxTurns',
      'defaultMaxOutputTokens',
      'defaultWorkspaceIsolation',
      'workspaceCheckpoints',
      // Chat
      'defaultChatFontSize',
    ]);
    // The SET is what a reset actually clears, and #2182 must not have
    // changed it. Sixteen keys before the split across six sections,
    // sixteen after; only the order follows the page.
    expect([...RESETTABLE_STATION_SETTING_KEYS].sort()).toEqual(
      [
        'approvalGuardian',
        'defaultApprovalMode',
        'defaultChatFontSize',
        'defaultMaxOutputTokens',
        'defaultMaxTurns',
        'defaultWorkspaceIsolation',
        'disableDefaultSkillRegistries',
        'distributionProfile',
        'mcpUiHost',
        'region',
        'registryUrl',
        'surfaceTrustFromVeritasEvidence',
        'systemPrompt',
        'templateVariables',
        'terminalShell',
        'workspaceCheckpoints',
      ].sort(),
    );
  });
});

/**
 * Epic #2144 slice 6 item F. "Restore device defaults" must name exactly
 * what it will change: a plan that over-reports would promise to undo
 * choices nobody made, and one that includes a direct-manipulation key
 * would rearrange the window out from under the person who pressed it.
 */
describe('buildDeviceResetPlan', () => {
  /** The resolved snapshot a pristine device store hands out. */
  function pristine(): Record<string, unknown> {
    return Object.fromEntries(
      DEVICE_SETTINGS_REGISTRY.map((definition) => [
        definition.key as string,
        definition.defaultValue,
      ]),
    );
  }

  /** Some value this key cannot already hold, whatever its shape. */
  function nonDefaultValue(value: unknown): unknown {
    if (typeof value === 'boolean') return !value;
    if (typeof value === 'number') return value + 7;
    if (typeof value === 'string') return `${value}-moved`;
    if (Array.isArray(value)) return [...value, 'moved'];
    if (value && typeof value === 'object')
      return { ...(value as object), movedByTheUser: true };
    return 'moved';
  }

  test('a pristine device has nothing to restore', () => {
    const plan = buildDeviceResetPlan(pristine() as never);
    expect(plan.keys).toEqual([]);
    expect(plan.labels).toEqual([]);
  });

  test('lists exactly the changed preferences, by their registry labels', () => {
    const plan = buildDeviceResetPlan({
      ...pristine(),
      theme: 'light',
      chatFontSize: 20,
    } as never);
    expect(plan.keys).toEqual(['theme', 'chatFontSize']);
    expect(plan.labels).toEqual(['Theme', 'Chat font size']);
  });

  test('a composite counts as changed by value, not by identity', () => {
    // Every snapshot is a fresh object, so an identity comparison would
    // report `featureSettings` as changed on every device, always.
    const untouched = buildDeviceResetPlan({
      ...pristine(),
      featureSettings: { ...(pristine().featureSettings as object) },
    } as never);
    expect(untouched.keys).not.toContain('featureSettings');

    const changed = buildDeviceResetPlan({
      ...pristine(),
      featureSettings: {
        ...(pristine().featureSettings as object),
        smoothReveal: true,
      },
    } as never);
    expect(changed.keys).toContain('featureSettings');
  });

  test('a direct-manipulation key that differs is neither listed nor restored', () => {
    // EVERY excluded key differs here, derived from the list itself so a new
    // member is covered the day it is added. Hand-picking four left six
    // pristine, and a candidate list that had gained `firstRunProgress`
    // stayed green because the fixture never moved it (round 2 AC6(b),
    // round 3 F3).
    const touchedEverything: Record<string, unknown> = {
      ...pristine(),
      ...Object.fromEntries(
        DIRECT_MANIPULATION_DEVICE_KEYS.map((key) => [
          key as string,
          nonDefaultValue(pristine()[key as string]),
        ]),
      ),
      theme: 'light',
    };
    const plan = buildDeviceResetPlan(touchedEverything as never);

    // The fixture's own power: all ten genuinely differ, so admitting any
    // one of them reddens this equality.
    for (const key of DIRECT_MANIPULATION_DEVICE_KEYS) {
      expect(touchedEverything[key as string]).not.toEqual(
        pristine()[key as string],
      );
    }
    expect(plan.keys).toEqual(['theme']);
    expect(plan.labels).toEqual(['Theme']);
  });

  test('an absent key reads as its default rather than as a change', () => {
    // The live store folds defaults in, so `undefined` only appears for a
    // partial snapshot; reporting it as stored would promise to restore
    // something that was never set.
    expect(buildDeviceResetPlan({}).keys).toEqual([]);
    expect(buildDeviceResetPlan(undefined).keys).toEqual([]);
  });
});
