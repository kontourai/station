import { describe, expect, test } from 'vitest';
import { assertNoRetiredLayoutKeys, RetiredLayoutKeyError } from '../layout.js';

/**
 * The Playbooks→Skills merge renamed two layout keys with NO alias window
 * (ADR-0016). The failure this guards is not a crash — it is the quiet one: a
 * parser reads the new key off a layout that declares the old one, finds
 * nothing, and resolves a layout that looks fine and has lost its quick
 * actions (review M1).
 */
describe('assertNoRetiredLayoutKeys', () => {
  test('a layout on the current keys is accepted', () => {
    expect(() =>
      assertNoRetiredLayoutKeys({
        slug: 'coding',
        globalSkills: [{ id: 'g1', label: 'Stand up', prompt: 'x' }],
        tabs: [
          {
            id: 'main',
            label: 'Main',
            skills: [{ type: 'prompt', label: 'Summarise', data: 'x' }],
          },
        ],
      }),
    ).not.toThrow();
  });

  test('the retired top-level key is refused, naming both sides of the rename', () => {
    expect(() =>
      assertNoRetiredLayoutKeys(
        { slug: 'coding', globalPrompts: [] },
        "Plugin 'sales' layout",
      ),
    ).toThrow(
      /Plugin 'sales' layout uses the retired layout key 'globalPrompts'; rename it to 'globalSkills'/,
    );
  });

  test('the retired tab key is refused, naming which tab', () => {
    expect(() =>
      assertNoRetiredLayoutKeys(
        {
          slug: 'coding',
          tabs: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B', prompts: [] },
          ],
        },
        'layout.json',
      ),
    ).toThrow(
      /layout\.json tab\[1\] uses the retired layout key 'prompts'; rename it to 'skills'/,
    );
  });

  // An EMPTY retired list is still a declaration of the retired key. A check
  // that looked at length would let `globalPrompts: []` through, and the
  // author would never learn their key is dead until they put something in it.
  test('an empty retired list is still a refusal', () => {
    expect(() => assertNoRetiredLayoutKeys({ globalPrompts: [] })).toThrow(
      /globalPrompts/,
    );
    expect(() =>
      assertNoRetiredLayoutKeys({ tabs: [{ prompts: [] }] }),
    ).toThrow(/prompts/);
  });

  // A layout has never had a top-level `prompts`, so calling one retired there
  // would be a refusal for a rename that never happened.
  test('a top-level prompts key is not claimed as a retired layout key', () => {
    expect(() =>
      assertNoRetiredLayoutKeys({ slug: 'coding', prompts: [] }),
    ).not.toThrow();
  });

  // The type is what lets a caller report this as the author's 400 rather
  // than as whatever its generic catch says.
  test('the refusal is its own error type, carrying both key names', () => {
    try {
      assertNoRetiredLayoutKeys({ globalPrompts: [] }, 'layout.json');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RetiredLayoutKeyError);
      const refusal = error as RetiredLayoutKeyError;
      expect(refusal.code).toBe('RETIRED_LAYOUT_KEY');
      expect(refusal.path).toBe('layout.json');
      expect(refusal.retiredKey).toBe('globalPrompts');
      expect(refusal.replacementKey).toBe('globalSkills');
    }
  });

  test('a non-object, or tabs that are not objects, is not a refusal', () => {
    expect(() => assertNoRetiredLayoutKeys(null)).not.toThrow();
    expect(() => assertNoRetiredLayoutKeys('layout')).not.toThrow();
    expect(() => assertNoRetiredLayoutKeys({ tabs: 'nope' })).not.toThrow();
    expect(() =>
      assertNoRetiredLayoutKeys({ tabs: [null, 'tab', 42] }),
    ).not.toThrow();
  });
});
