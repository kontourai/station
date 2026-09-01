import { describe, expect, test } from 'vitest';
import { requiresAgentPromptForRuntime } from '../agent-validation.js';

/**
 * Station#1003 (unification slice 6) §A5/A6 classification contract, updated
 * by station#1055's provider separation.
 *
 * These expected values began as the frozen pre-slice-6 semantics: the literal
 * classification `resolveAgentTypeFromRuntimeConnection(id) === 'managed'`
 * produced (via the retired `requiresAgentPromptForRuntime`) for each id,
 * verified against that old resolver before it was deleted from
 * `agent-capability-profile.ts`. They are pinned here as independent
 * literals — NOT derived from `resolveEngineCapabilityMatrix` or any other
 * current expression — so this test stays discriminating against future
 * matrix drift (a change that silently altered
 * `resolveEngineCapabilityMatrix`'s prompt-requirement branch for any of these
 * ids would fail here, where comparing the current implementation against
 * itself never could). Station#1055 deliberately changed Bedrock and Ollama
 * from managed Agent-runtime identities into provider-model identities; they
 * now take the same conservative external branch as any unbound connection id.
 */
describe('requiresAgentPromptForRuntime — independent classification literals (station#1003, #1055)', () => {
  test.each([
    [undefined, true, 'no execution binding'],
    ['bedrock-runtime', false, 'provider-model id, not an Agent runtime'],
    ['ollama-runtime', false, 'provider-model id, not an Agent runtime'],
    ['acp', false, 'acp'],
    ['claude', false, 'unbound connected id (no live connection lookup)'],
    ['anything-else', false, 'unknown/unbound id'],
  ] as const)(
    'id=%s -> requiresAgentPromptForRuntime === %s (%s)',
    (id, expected, _description) => {
      expect(requiresAgentPromptForRuntime(id)).toBe(expected);
    },
  );
});
