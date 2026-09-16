/**
 * Epic #2144 slice 2. The module carries compile-time completeness
 * assertions; these are the runtime companions — the alias map is data a
 * caller reads at run time, and an alias that points at a field the project
 * record does not carry would typecheck against `keyof ProjectConfig` while
 * reading `undefined` forever.
 */

import { describe, expect, test } from 'vitest';
import type { ProjectConfig } from '../project.js';
import {
  PROJECT_OVERRIDABLE_APP_SETTING_KEYS,
  PROJECT_OVERRIDE_FIELD_ALIASES,
  type ProjectSettingsOverrides,
  readProjectOverrides,
} from '../project-settings-overrides.js';
import { APP_SETTINGS_REGISTRY } from '../settings-registry.js';

const project = (over: Partial<ProjectConfig>): ProjectConfig => ({
  id: 'p1',
  name: 'Project',
  slug: 'project',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('project settings overrides', () => {
  test('the overridable list is exactly the three keys decided for day one', () => {
    expect([...PROJECT_OVERRIDABLE_APP_SETTING_KEYS]).toEqual([
      'defaultModel',
      'defaultLLMProvider',
      'defaultWorkspaceIsolation',
    ]);
  });

  /**
   * The list and the type are kept in lockstep by two compile-time
   * assertions in the module. This is the third leg they cannot cover: an
   * overridable key must name a REGISTERED setting. A key that is an
   * `AppConfig` field but not in the registry has no label, no descriptor
   * and no provenance — a project could override a setting no surface can
   * name and no write path validates.
   */
  test('every overridable key is a registered setting', () => {
    const registered = new Set(
      APP_SETTINGS_REGISTRY.map((definition) => definition.key as string),
    );
    for (const key of PROJECT_OVERRIDABLE_APP_SETTING_KEYS) {
      expect(registered.has(key), key).toBe(true);
    }
  });

  /**
   * `buildAppConfigProvenance` applies a project override LAST, over whatever
   * the Station file, the environment, or a registry default reported. That
   * is right for the three keys as they stand, and it is only obviously
   * right because none of them consults an env var. The day one declares an
   * `envFallback`, the precedence between "the operator set this in the
   * environment" and "this project overrode it" is a decision somebody has
   * to make — this test is what makes them make it instead of inheriting an
   * accident.
   */
  test('no overridable key declares an envFallback', () => {
    for (const key of PROJECT_OVERRIDABLE_APP_SETTING_KEYS) {
      const definition = APP_SETTINGS_REGISTRY.find((d) => d.key === key);
      expect(definition?.envFallback, key).toBeUndefined();
    }
  });

  test('the alias map covers the list and names project-record fields', () => {
    expect(Object.keys(PROJECT_OVERRIDE_FIELD_ALIASES).sort()).toEqual(
      [...PROJECT_OVERRIDABLE_APP_SETTING_KEYS].sort(),
    );
    expect(PROJECT_OVERRIDE_FIELD_ALIASES.defaultLLMProvider).toBe(
      'defaultProviderId',
    );
    expect(PROJECT_OVERRIDE_FIELD_ALIASES.defaultModel).toBe('defaultModel');
    expect(PROJECT_OVERRIDE_FIELD_ALIASES.defaultWorkspaceIsolation).toBe(
      'defaultWorkspaceIsolation',
    );
  });

  test('readProjectOverrides resolves the alias rather than the setting name', () => {
    const overrides = readProjectOverrides(
      project({
        defaultProviderId: 'anthropic-local',
        defaultModel: 'claude-sonnet',
        defaultWorkspaceIsolation: 'worktree',
      }),
    );
    expect(overrides).toEqual({
      defaultLLMProvider: 'anthropic-local',
      defaultModel: 'claude-sonnet',
      defaultWorkspaceIsolation: 'worktree',
    } satisfies ProjectSettingsOverrides);
  });

  /**
   * A project that happens to carry a field named for the SETTING rather
   * than the record is not an override. Without this, an alias regression
   * would be invisible: the reader would find the value under either name
   * and the map would be decorative.
   */
  test('a setting-named field on the record is not read as an override', () => {
    const overrides = readProjectOverrides({
      defaultLLMProvider: 'anthropic-local',
    } as unknown as ProjectConfig);
    expect(overrides).toEqual({});
  });

  test('absent, null, and blank fields are not overrides', () => {
    expect(readProjectOverrides(project({}))).toEqual({});
    expect(readProjectOverrides(undefined)).toEqual({});
    expect(
      readProjectOverrides(
        project({ defaultProviderId: '   ', defaultModel: '' }),
      ),
    ).toEqual({});
  });

  /**
   * `ProviderService.resolveProviderAndModel` takes the project branch only
   * for `project?.defaultProviderId && project.defaultModel`
   * (`src-server/services/connections/provider-service.ts:283`): a project
   * carrying one half falls through to the Station pair ENTIRE. A half-pair
   * is therefore not a half-override, it is no override, and emitting either
   * half would name the project as the source of a value nothing reads.
   */
  test('a half model pair is not an override, by any of the ways a half arises', () => {
    const halves: Partial<ProjectConfig>[] = [
      { defaultProviderId: 'anthropic-local' },
      { defaultModel: 'claude-sonnet' },
      { defaultProviderId: 'anthropic-local', defaultModel: '' },
      {
        defaultProviderId: null as unknown as string,
        defaultModel: 'claude-sonnet',
      },
    ];
    for (const half of halves) {
      expect(readProjectOverrides(project(half)), JSON.stringify(half)).toEqual(
        {},
      );
    }
  });

  test('the pair rule does not take an independent override down with it', () => {
    expect(
      readProjectOverrides(
        project({
          defaultModel: 'claude-sonnet',
          defaultWorkspaceIsolation: 'worktree',
        }),
      ),
    ).toEqual({ defaultWorkspaceIsolation: 'worktree' });
  });

  test('non-overridable project fields are never reported', () => {
    const overrides = readProjectOverrides(
      project({ defaultEmbeddingModel: 'embed-1', topK: 5 }),
    );
    expect(overrides).toEqual({});
  });
});
