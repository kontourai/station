/**
 * The legacy `prompts` → `agent.skills` mapping, on its own.
 *
 * It has exactly one caller left — `station doctor --migrate-playbooks` — and
 * the migration suite exercises it end to end against a fixture home. That
 * suite proves the OUTCOME; these prove the derivation's edges directly, so a
 * regression in the mapping reads as a mapping failure rather than as a
 * confusing migration-report diff.
 */
import { describe, expect, test } from 'vitest';

import { translateAgentPromptBindings } from '../agent-skill-binding.js';

const LEGACY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resolveLegacyId = (id: string) =>
  id === LEGACY_ID ? 'daily-standup' : undefined;

describe('translateAgentPromptBindings', () => {
  test('appends resolved skills after the ones already bound, once', () => {
    const result = translateAgentPromptBindings({
      currentSkills: ['existing', 'daily-standup'],
      declaredPrompts: [LEGACY_ID, LEGACY_ID, 'unknown-id'],
      extraSkillNames: ['pinned'],
      resolveLegacyId,
    });

    // `daily-standup` is already bound, so it is not appended twice — this is
    // what makes a migration retry a no-op rather than a growing list.
    expect(result.skills).toEqual(['existing', 'daily-standup', 'pinned']);
    expect(result.addedSkills).toEqual(['pinned']);
    expect(result.resolvedPromptIds).toEqual([LEGACY_ID, LEGACY_ID]);
    expect(result.unresolvedPromptIds).toEqual(['unknown-id']);
  });

  test('an id nothing claims is REPORTED, never quietly dropped', () => {
    const result = translateAgentPromptBindings({
      currentSkills: [],
      declaredPrompts: ['no-skill-claims-this'],
      resolveLegacyId,
    });

    // The caller decides the disposition; the derivation's job is to make the
    // unresolved ids nameable, so the migration report can print them.
    expect(result.skills).toEqual([]);
    expect(result.unresolvedPromptIds).toEqual(['no-skill-claims-this']);
    expect(result.resolvedPromptIds).toEqual([]);
  });

  test('an empty prompts list still counts as carrying the key, so it can be deleted', () => {
    const carried = translateAgentPromptBindings({
      currentSkills: ['existing'],
      declaredPrompts: [],
      resolveLegacyId,
      hadPromptsKey: true,
    });
    const absent = translateAgentPromptBindings({
      currentSkills: ['existing'],
      declaredPrompts: undefined,
      resolveLegacyId,
    });

    // A record whose `prompts` is `[]` has the field on disk and must have it
    // removed; a record that never had one must not be rewritten at all.
    expect(carried.hadPromptsKey).toBe(true);
    expect(absent.hadPromptsKey).toBe(false);
    expect(carried.skills).toEqual(['existing']);
    expect(absent.skills).toEqual(['existing']);
  });
});
