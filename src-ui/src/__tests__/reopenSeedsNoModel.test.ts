/**
 * @vitest-environment jsdom
 */
import { describe, expect, test } from 'vitest';
import { reopenedSessionExecution } from '../hooks/reopenedSessionExecution';
import { resolveTurnModel } from '../lib/turnModel';

/**
 * station#3165. Reopening a conversation with no known model used to seed
 * the chat from the AGENT DEFAULT, so a send in the window before the
 * orchestration snapshot landed dispatched `override: <agent default>` — a
 * model the user never chose for that conversation.
 *
 * On an engine that cannot take a per-turn override that is an error for
 * someone else's choice; on one that can, it silently switches the model
 * mid-conversation, and the per-turn provenance then faithfully records a
 * switch the user never made.
 *
 * The seed is now left unset, and this is the contract that makes that
 * safe: an unknown model produces no override at all.
 */
describe('a reopened conversation asks for nothing until it knows', () => {
  test('an unset model sends no override', () => {
    expect(
      resolveTurnModel({ requestedModel: undefined, model: undefined }),
    ).toEqual({ kind: 'engine-selected' });
  });

  test('a known session model is still sent', () => {
    // The negative control: withholding the override must not also withhold
    // a model the session genuinely has.
    expect(
      resolveTurnModel({ requestedModel: undefined, model: 'glm-5.3' }),
    ).toEqual({ kind: 'override', modelId: 'glm-5.3' });
  });
});

describe('the reopen decision withholds the model', () => {
  // NOT the caller — the extracted callee. An adversarial review showed the
  // caller (useChatDockActions) can still be reverted to its pre-fix line
  // with every test here green, because nothing asserts it calls this at
  // all. The caller assertion lives in useChatDockActions.test.tsx, where a
  // harness already renders the hook (station#3165 review).
  const agentExecution = {
    executionMode: 'external',
    model: 'opencode/deepseek-v4-flash-free',
    modelSource: 'agent default',
  } as never;

  test('an unknown model is seeded unset, not as the agent default', () => {
    const seeded = reopenedSessionExecution(agentExecution, undefined);
    expect(seeded.model).toBeUndefined();
    expect(seeded.modelSource).toBe('unknown');
    // And end to end: what that seed asks for on the wire is nothing.
    expect(
      resolveTurnModel({ requestedModel: undefined, model: seeded.model }),
    ).toEqual({ kind: 'engine-selected' });
  });

  test('a known model is still seeded and still sent', () => {
    const seeded = reopenedSessionExecution(agentExecution, 'glm-5.3');
    expect(seeded.model).toBe('glm-5.3');
    expect(
      resolveTurnModel({ requestedModel: undefined, model: seeded.model }),
    ).toEqual({ kind: 'override', modelId: 'glm-5.3' });
  });

  test('an accepted conversation model is restored as its own override', () => {
    const seeded = reopenedSessionExecution(
      agentExecution,
      'claude-sonnet',
      'session override',
    );
    expect(seeded.modelSource).toBe('session override');
    expect(
      resolveTurnModel({ requestedModel: undefined, model: seeded.model }),
    ).toEqual({ kind: 'override', modelId: 'claude-sonnet' });
  });
});
