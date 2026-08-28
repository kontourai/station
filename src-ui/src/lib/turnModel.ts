/**
 * What model this turn will actually ask for — the ONE derivation.
 *
 * The composer chip and the message dispatcher used to compute it separately, and
 * they disagreed: with `requestedModel === null` the dispatcher correctly
 * sent no override while the chip substituted the AGENT DEFAULT and named
 * it. So a session running on `zai-coding-plan/glm-5.3` displayed
 * "OpenCode Zen/DeepSeek V4 Flash" underneath a turn whose own header read
 * `Requested zai-coding-plan/glm-5.3` — the client held the right value and
 * rendered the other one (archive#3149).
 *
 * Both surfaces read this now, so they cannot drift apart again.
 *
 * It lives in its own leaf module rather than beside the dispatcher: the
 * composer is eager, the dispatcher is not, and importing the dispatcher for
 * this one function hoisted it into the entry chunk for +301 gzipped bytes.
 */
export type ResolvedTurnModel =
  | { kind: 'override'; modelId: string }
  /** No override goes on the wire; the engine keeps whatever it retained. */
  | { kind: 'engine-selected' };

export function resolveTurnModel(input: {
  requestedModel?: string | null;
  model?: string;
}): ResolvedTurnModel {
  // `null` is a deliberate "omit the override", distinct from `undefined`
  // ("nothing requested — fall back to the last runtime-reported model").
  if (input.requestedModel === null) return { kind: 'engine-selected' };
  const modelId = input.requestedModel ?? input.model;
  return modelId ? { kind: 'override', modelId } : { kind: 'engine-selected' };
}
