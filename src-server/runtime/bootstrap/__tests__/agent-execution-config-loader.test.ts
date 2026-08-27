import { describe, expect, test } from 'vitest';
import { AgentConfigNotFoundError } from '../../../domain/config-loader-agents.js';
import { composeAgentExecutionConfigLoader } from '../agent-execution-config-loader.js';

/**
 * station#3549. This composition was got wrong twice in opposite directions
 * while it was an inline closure in `runtime-initialize.ts` that nothing could
 * exercise. The previous attempt at coverage asserted on the file's SOURCE
 * TEXT, which an independent reviewer correctly called a smell: it passed
 * while ordinary registry agents were broken, and `.then(ok, () => undefined)`
 * would have evaded it entirely.
 *
 * These test the behaviour instead, on the two cases the two regressions hit.
 */
describe('the agent-execution-config seam', () => {
  test('an agent with no on-disk spec resolves to no pin, and does NOT reject', async () => {
    // The normal state of every registry default — `station`, `claude`,
    // `codex` are deliberately never written to `agents/`. Rejecting here
    // broke session starts for the default agent.
    const load = composeAgentExecutionConfigLoader({
      loadAgent: async (slug) => {
        throw new AgentConfigNotFoundError(
          slug,
          `/home/agents/${slug}/agent.json`,
        );
      },
    });
    await expect(load('station')).resolves.toBeUndefined();
  });

  test('an unreadable spec REJECTS rather than reporting "no preference"', async () => {
    // Anything that is not absence means we cannot tell whether a credential
    // pin exists. Reporting `undefined` here ran a pinned agent on whatever
    // account the connection selected, silently.
    for (const error of [
      new SyntaxError('Unexpected token } in JSON'),
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      new Error('agent spec failed schema validation'),
    ]) {
      const load = composeAgentExecutionConfigLoader({
        loadAgent: async () => {
          throw error;
        },
      });
      await expect(load('work-agent')).rejects.toThrow(error.message);
    }
  });

  test('a readable spec yields its execution config', async () => {
    const execution = {
      agentConnectionId: 'claude',
      credentialProfileRef: 'w',
    };
    const load = composeAgentExecutionConfigLoader({
      loadAgent: async () => ({ execution }),
    });
    await expect(load('work-agent')).resolves.toEqual(execution);
  });

  test('a spec with no execution block is no pin, not a failure', async () => {
    const load = composeAgentExecutionConfigLoader({
      loadAgent: async () => ({}),
    });
    await expect(load('plain-agent')).resolves.toBeUndefined();
  });

  // The predicate is duck-typed as well as instanceof, so a not-found error
  // that crossed a module or realm boundary still reads as absence.
  test('recognizes a not-found error by code, not only by identity', async () => {
    const load = composeAgentExecutionConfigLoader({
      loadAgent: async () => {
        throw Object.assign(new Error('missing'), {
          code: 'AGENT_CONFIG_NOT_FOUND',
        });
      },
    });
    await expect(load('station')).resolves.toBeUndefined();
  });
});
