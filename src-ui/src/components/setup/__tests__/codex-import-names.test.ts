import { describe, expect, test } from 'vitest';
import { importNameProblem, planImportNames } from '../codex-import-names';

// A composed "é" (U+00E9) and the same letter as "e" plus a combining acute
// accent (U+0065 U+0301) name the same folder on a Mac.
const composed = 'résumé';
const decomposed = 'résumé';

describe('Codex import names', () => {
  test('a name in another Unicode form clashes with an existing skill', () => {
    expect(composed).not.toBe(decomposed);
    expect(importNameProblem(decomposed, [composed], [])).toBe(
      `You already have a skill called “${composed}”.`,
    );
  });

  test('a prompt named in another Unicode form needs a new name', () => {
    const plan = planImportNames(
      [{ id: 'a', skillName: decomposed, collision: false }],
      [composed],
    );
    expect(plan.get('a')).toEqual({
      suggested: `${decomposed}-codex`,
      clash: 'existing',
    });
  });

  test('two selected prompts in different Unicode forms clash', () => {
    expect(importNameProblem(composed, [], [decomposed])).toBe(
      'Another selected prompt uses this name.',
    );
  });
});
