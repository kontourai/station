import { describe, expect, test } from 'vitest';
import { requiresAgentPromptForRuntime } from '../agent-validation.js';

/**
 * Station#1003 (unification slice 6) §A5/A6 equivalence proof.
 *
 * These expected values are the FROZEN pre-slice-6 semantics: the literal
 * classification `resolveAgentTypeFromRuntimeConnection(id) === 'managed'`
 * produced (via the retired `requiresAgentPromptForRuntime`) for each id,
 * verified against that old resolver before it was deleted from
 * `agent-capability-profile.ts`. They are pinned here as independent
 * literals — NOT derived from `resolveEngineCapabilityMatrix` or any other
 * current expression — so this test stays discriminating against future
 * matrix drift (a change that silently altered
 * `resolveEngineCapabilityMatrix`'s prompt-requirement branch for any of
 * these ids would fail here, where comparing the current implementation
 * against itself never could).
 */
describe('requiresAgentPromptForRuntime — frozen pre-slice-6 classification (station#1003 §A5/A6)', () => {
  test.each([
    [undefined, true, 'no execution binding'],
    ['bedrock-runtime', true, 'known managed runtime id'],
    ['ollama-runtime', true, 'known managed runtime id'],
    ['acp', false, 'acp'],
    [
      'claude-runtime',
      false,
      'unbound connected id (no live connection lookup)',
    ],
    ['anything-else', false, 'unknown/unbound id'],
  ] as const)(
    'id=%s -> requiresAgentPromptForRuntime === %s (%s)',
    (id, expected, _description) => {
      expect(requiresAgentPromptForRuntime(id)).toBe(expected);
    },
  );
});
