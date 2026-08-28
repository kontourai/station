/**
 * @vitest-environment jsdom
 */
import { describe, expect, test } from 'vitest';
import { resolveTurnModel } from '../lib/turnModel';

/**
 * archive#3149. The composer chip and the message dispatcher computed the
 * requested model separately and disagreed: with `requestedModel === null`
 * the dispatcher correctly sent no override, while the chip substituted the
 * AGENT DEFAULT and displayed it as though it were running.
 *
 * Live symptom: a session on `zai-coding-plan/glm-5.3` showed
 * "OpenCode Zen/DeepSeek V4 Flash" in the composer, directly beneath a turn
 * whose own header read `Requested zai-coding-plan/glm-5.3`. The client held
 * the correct value and rendered the other one.
 *
 * Both surfaces now read this resolver, so the seam is one function. These
 * cases are the contract that function owes them.
 */
describe('the model a turn asks for is derived once', () => {
  test.each([
    [
      'an explicit override is what gets sent',
      { requestedModel: 'zai-coding-plan/glm-5.3', model: 'other' },
      { kind: 'override', modelId: 'zai-coding-plan/glm-5.3' },
    ],
    [
      'null means omit the override — the engine keeps what it has',
      { requestedModel: null, model: 'zai-coding-plan/glm-5.3' },
      { kind: 'engine-selected' },
    ],
    [
      'undefined falls back to the last reported model, which IS an override',
      { requestedModel: undefined, model: 'zai-coding-plan/glm-5.3' },
      { kind: 'override', modelId: 'zai-coding-plan/glm-5.3' },
    ],
    [
      'nothing requested and nothing reported names nothing',
      { requestedModel: undefined, model: undefined },
      { kind: 'engine-selected' },
    ],
    [
      'an empty reported model is not a model',
      { requestedModel: undefined, model: '' },
      { kind: 'engine-selected' },
    ],
  ])('%s', (_name, input, expected) => {
    expect(resolveTurnModel(input)).toEqual(expected);
  });

  test('null is not the same request as undefined', () => {
    // The distinction the whole defect turned on. `null` is a deliberate
    // "omit"; `undefined` is "nothing chosen, use what was last reported".
    // Collapsing them either strands the override or sends one nobody asked
    // for.
    expect(resolveTurnModel({ requestedModel: null, model: 'a' })).toEqual({
      kind: 'engine-selected',
    });
    expect(resolveTurnModel({ requestedModel: undefined, model: 'a' })).toEqual(
      { kind: 'override', modelId: 'a' },
    );
  });

  test('clearing an override never names the agent default', () => {
    // The exact substitution that produced the divergence: on `null` the chip
    // used to fall through to the agent default and display it. The resolver
    // has no access to an agent default at all, which is the point — it
    // cannot reintroduce one.
    const cleared = resolveTurnModel({
      requestedModel: null,
      model: 'zai-coding-plan/glm-5.3',
    });
    expect(cleared).toEqual({ kind: 'engine-selected' });
    expect(JSON.stringify(cleared)).not.toContain('deepseek');
  });
});
