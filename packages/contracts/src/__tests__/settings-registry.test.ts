/**
 * Registry-completeness tests for `settings-registry.ts`
 * (docs/design/settings-architecture.md §4). The module itself carries a
 * compile-time completeness assertion (`_assertRegistryCoversAppConfig`) —
 * these are the runtime companions: they check the registry against the
 * shipped file schema so the two never drift independently of the type
 * system (e.g. a field renamed on `AppConfig` and the registry together,
 * but the schema left stale).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DEVICE_SETTINGS_REGISTRY } from '../device-settings.js';
import type {
  SettingDefinition,
  SettingValueDescriptor,
} from '../settings-registry.js';
import {
  APP_SETTINGS_REGISTRY,
  acceptsSettingValue,
  INTERNAL_APP_CONFIG_FIELDS,
} from '../settings-registry.js';

/**
 * Schema properties that are intentionally NOT in the registry and NOT
 * `AppConfig` fields at all — grandfathered legacy keys the file layer
 * still tolerates (`additionalProperties: true` already covers untyped
 * stray keys; this list is for keys the schema still explicitly types).
 * Empty today: the two dead legacy properties this slice found
 * (`apiEndpoint`, `meetingNotifications`) had zero consumers and were
 * removed from the schema outright rather than grandfathered.
 */
const LEGACY_SCHEMA_ONLY: readonly string[] = [];

function readAppSchema(): { properties: Record<string, unknown> } {
  const schemaPath = path.resolve(
    __dirname,
    '../../../../schemas/app.schema.json',
  );
  return JSON.parse(readFileSync(schemaPath, 'utf-8'));
}

describe('APP_SETTINGS_REGISTRY completeness', () => {
  test('registry keys are unique', () => {
    const keys = APP_SETTINGS_REGISTRY.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('registry keys and internal fields do not overlap', () => {
    const registryKeys = new Set<string>(
      APP_SETTINGS_REGISTRY.map((definition) => definition.key as string),
    );
    for (const internalKey of INTERNAL_APP_CONFIG_FIELDS) {
      expect(registryKeys.has(internalKey as string)).toBe(false);
    }
  });

  test('every registered key exists in schemas/app.schema.json', () => {
    const schema = readAppSchema();
    const missing = APP_SETTINGS_REGISTRY.filter(
      (definition) => !(definition.key in schema.properties),
    ).map((definition) => definition.key);
    expect(missing).toEqual([]);
  });

  test('every schema property is registered or explicitly grandfathered', () => {
    const schema = readAppSchema();
    const registryKeys = new Set(
      APP_SETTINGS_REGISTRY.map((definition) => definition.key as string),
    );
    const legacy = new Set(LEGACY_SCHEMA_ONLY);
    const undeclared = Object.keys(schema.properties).filter(
      (key) => !registryKeys.has(key) && !legacy.has(key),
    );
    expect(undeclared).toEqual([]);
  });

  test('internal (runtime-derived) fields are never in the schema', () => {
    const schema = readAppSchema();
    const leaked = INTERNAL_APP_CONFIG_FIELDS.filter(
      (key) => key in schema.properties,
    );
    expect(leaked).toEqual([]);
  });

  test('composite-scoped keys match the design doc list', () => {
    const compositeKeys = APP_SETTINGS_REGISTRY.filter(
      (definition) => definition.descriptor.kind === 'composite',
    )
      .map((definition) => definition.key as string)
      .sort();
    expect(compositeKeys).toEqual(
      [
        'agentConnections',
        'approvalGuardian',
        // station#1500 slice 2.5 — the scoped contribution map.
        'contribution',
        'distributionProfile',
        // UX audit RT-02 — the durable first-run record for this home.
        'firstRun',
        'fleetContribution',
        'templateVariables',
        // station#2652 — the first-run "About you" answers.
        'userProfile',
      ].sort(),
    );
  });

  test('every "defaults"-scope setting is one of the six documented fields', () => {
    const defaultsKeys = APP_SETTINGS_REGISTRY.filter(
      (definition) => definition.scope === 'defaults',
    )
      .map((definition) => definition.key as string)
      .sort();
    expect(defaultsKeys).toEqual(
      [
        'defaultModel',
        'invokeModel',
        'region',
        'structureModel',
        'systemPrompt',
        'templateVariables',
      ].sort(),
    );
  });

  // Round-3 review (M10). `acceptsSettingValue` is a public export used to
  // decide whether a surface may NAME a source, so "cannot tell" must answer
  // no. `composite` defers structure to AJV at save time and would otherwise
  // accept any string — a future `envFallback` on a composite key would let a
  // badge name an env var holding arbitrary garbage, which is precisely the
  // defect the live boot check found for `region`.
  test('acceptsSettingValue fails closed for descriptors a raw string cannot satisfy', () => {
    const kinds: SettingValueDescriptor[] = [
      { kind: 'composite' },
      { kind: 'number' },
      { kind: 'boolean' },
    ];
    for (const descriptor of kinds) {
      expect(
        acceptsSettingValue(
          {
            key: 'templateVariables',
            scope: 'defaults',
            descriptor,
            label: 'x',
            description: 'x',
          } as SettingDefinition,
          'anything at all',
        ),
        descriptor.kind,
      ).toBe(false);
    }
  });

  test('acceptsSettingValue judges string and enum descriptors', () => {
    const region = APP_SETTINGS_REGISTRY.find((d) => d.key === 'region');
    expect(acceptsSettingValue(region as SettingDefinition, 'us-east-1')).toBe(
      true,
    );
    expect(acceptsSettingValue(region as SettingDefinition, 'US-EAST-1')).toBe(
      false,
    );
    const logLevel = APP_SETTINGS_REGISTRY.find((d) => d.key === 'logLevel');
    expect(acceptsSettingValue(logLevel as SettingDefinition, 'debug')).toBe(
      true,
    );
    expect(acceptsSettingValue(logLevel as SettingDefinition, 'shout')).toBe(
      false,
    );
  });

  // station#1557: a FALLBACK, not an override. The resolver reads the stored
  // value first, so a declaration that claimed precedence over it was the
  // source of the "doomed edit" badge on the value that actually applied.
  test('region declares AWS_REGION as its env fallback', () => {
    const region = APP_SETTINGS_REGISTRY.find((d) => d.key === 'region');
    expect(region?.envFallback).toBe('AWS_REGION');
    expect('envOverride' in (region ?? {})).toBe(false);
  });

  // station#settings-revamp slice-1 review finding (ALSO section): key
  // presence alone lets a descriptor and its schema property drift apart in
  // shape (an enum that gained a value on one side, a min/max that only
  // moved on one side). Composite fields are exempt — AJV's nested `oneOf`/
  // `additionalProperties` shapes for those have no scalar analogue to check.
  test('scalar descriptors semantically agree with their schema property (enum values, number min/max, string/boolean type)', () => {
    const schema = readAppSchema();
    const properties = schema.properties as Record<
      string,
      {
        type?: string | readonly string[];
        enum?: readonly string[];
        minimum?: number;
        maximum?: number;
      }
    >;

    for (const definition of APP_SETTINGS_REGISTRY) {
      const descriptor = definition.descriptor;
      if (descriptor.kind === 'composite') continue;
      const property = properties[definition.key as string];
      expect(property).toBeDefined();
      if (!property) continue;

      if (descriptor.kind === 'string') {
        // A registry-nullable string key declares JSON-schema type
        // ["string", "null"]; a plain string key declares "string".
        if (definition.nullable) {
          expect(property.type).toEqual(['string', 'null']);
        } else {
          expect(property.type).toBe('string');
        }
      } else if (descriptor.kind === 'boolean') {
        expect(property.type).toBe('boolean');
      } else if (descriptor.kind === 'number') {
        expect(['number', 'integer']).toContain(property.type);
        if (descriptor.min !== undefined) {
          expect(property.minimum).toBe(descriptor.min);
        }
        if (descriptor.max !== undefined) {
          expect(property.maximum).toBe(descriptor.max);
        }
      } else if (descriptor.kind === 'enum') {
        expect(property.type).toBe('string');
        expect([...(property.enum ?? [])].sort()).toEqual(
          [...descriptor.values].sort(),
        );
      }
    }
  });

  test('required-key flags mirror the schema\'s top-level "required" list exactly', () => {
    const schema = readAppSchema() as unknown as { required?: string[] };
    const schemaRequired = new Set(schema.required ?? []);
    const registryRequired = new Set(
      APP_SETTINGS_REGISTRY.filter((d) => d.required).map(
        (d) => d.key as string,
      ),
    );
    expect(registryRequired).toEqual(schemaRequired);
  });

  test('defaultValue is set only for settings with a confirmed code-level absent-value behavior', () => {
    const withDefaults = APP_SETTINGS_REGISTRY.filter(
      (d) => d.defaultValue !== undefined,
    )
      .map((d) => d.key as string)
      .sort();
    expect(withDefaults).toEqual(
      [
        'defaultChatFontSize',
        'defaultMaxTurns',
        'knowledgeStores',
        'mcpUiHost',
        'runtime',
        'surfaceTrustFromVeritasEvidence',
        'telemetryEnabled',
        'workspaceCheckpoints',
      ].sort(),
    );
  });

  // station#1840 item 4: three `station#NNNN` references rendered to users
  // (the issue counted seven, but four were already confined to code
  // comments), and one description narrated its storage encoding ("Absent:
  // re-derived each boot. null: explicitly Station, sticky.") instead of its
  // effect.
  // Labels, descriptions, and placeholders are user-facing copy; issue
  // references belong in code comments beside the definition.
  describe('user-facing copy (station#1840)', () => {
    const definitions = [...APP_SETTINGS_REGISTRY, ...DEVICE_SETTINGS_REGISTRY];

    test('no user-facing string contains an internal issue reference', () => {
      for (const definition of definitions) {
        for (const text of [
          definition.label,
          definition.description,
          ('placeholder' in definition && definition.placeholder) || '',
        ]) {
          expect(text, `${String(definition.key)}: ${text}`).not.toMatch(
            /(?:station|flow|veritas|survey)?#\d+/i,
          );
        }
      }
    });

    test('descriptions describe effect, not storage encoding', () => {
      // The vocabulary of serialized-state narration: "Absent: X. null: Y" and
      // friends. A description explaining how a value is stored rather than
      // what the setting does fails this pin.
      for (const definition of definitions) {
        expect(
          definition.description,
          `${String(definition.key)}: ${definition.description}`,
        ).not.toMatch(/\babsent:|\bnull:|\bsticky\b|keyed by|\bseam\b/i);
      }
    });
  });

  // station#1398 slice 1: the opt-in must stay an absent-means-off composite.
  // A `defaultValue` here would make `GET /config/app` report a fabricated
  // "default" contribution state for a Station that never configured one.
  test('fleetContribution is a station-scoped composite with no synthesized default', () => {
    const definition = APP_SETTINGS_REGISTRY.find(
      (d) => d.key === 'fleetContribution',
    );
    expect(definition).toBeDefined();
    expect(definition?.scope).toBe('station');
    expect(definition?.descriptor).toEqual({ kind: 'composite' });
    expect(definition?.defaultValue).toBeUndefined();
    expect(definition?.required).toBeUndefined();
    expect(definition?.nullable).toBeUndefined();
  });
});
