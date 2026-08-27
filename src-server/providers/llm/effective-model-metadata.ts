const MODEL_OPTION_KEYS = [
  'effort',
  'reasoningEffort',
  'fastMode',
  'autoMode',
  'thinking',
  'contextWindow',
  'longContext',
  'serviceTier',
] as const;

type EffectiveModelOptionKey = (typeof MODEL_OPTION_KEYS)[number];
type EffectiveModelOptionValue = string | number | boolean;

function boundedOptionValue(
  value: unknown,
): EffectiveModelOptionValue | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 128 ? trimmed : undefined;
}

/** Shared bound/trim rule for a single model-id-shaped string field. */
function boundedModelId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim().length <= 256
    ? value.trim()
    : undefined;
}

/**
 * Durable, provider-neutral snapshot of the model controls Station sent to
 * the runtime for a session/turn.
 *
 * station#1182: despite the name, `effectiveModel`/`effectiveModelOptions`
 * are NOT a runtime-confirmed observation — every call site passes in the
 * model/options Station itself resolved and requested (a connection's
 * configured model id, a turn's `modelId` override). The name predates the
 * distinction this ticket introduces; kept as-is for wire back-compat with
 * every already-persisted session, but the meaning is "requested," never
 * "observed." Where an adapter can independently confirm what the runtime
 * actually ran (the Claude Agent SDK's per-turn `assistant` message, Codex's
 * `thread/start`/`thread/resume` response, an ACP agent's own `model`-category
 * config-option `currentValue`, an OpenAI-compatible response's `model`
 * field), it additionally calls `reportedModelMetadata` with that
 * independently-sourced value — see each adapter's own survey notes for
 * which ones can and which honestly cannot. A caller that only has the
 * requested value must never synthesize a `reportedModel` from it.
 *
 * Arbitrary modelOptions are deliberately not persisted here: prompts,
 * credentials, tool policy, and provider-private bags are outside the
 * explainable model-selection contract.
 */
export function effectiveModelMetadata(
  model: unknown,
  modelOptions?: object,
): {
  effectiveModel?: string;
  effectiveModelOptions?: Partial<
    Record<EffectiveModelOptionKey, EffectiveModelOptionValue>
  >;
} {
  const effectiveModel = boundedModelId(model);
  const effectiveModelOptions: Partial<
    Record<EffectiveModelOptionKey, EffectiveModelOptionValue>
  > = {};
  const options = modelOptions as Record<string, unknown> | undefined;
  for (const key of MODEL_OPTION_KEYS) {
    const value = boundedOptionValue(options?.[key]);
    if (value !== undefined) effectiveModelOptions[key] = value;
  }
  return {
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(effectiveModel ? { effectiveModelOptions } : {}),
  };
}

/**
 * The model identity a runtime independently reported for a session/turn —
 * distinct from, and never derived from, `effectiveModelMetadata`'s
 * requested value. Absent whenever the adapter has no such signal; callers
 * must not fall back to the requested model to fill this in (that would
 * recreate the exact "requested presented as observed" bug station#1182
 * fixes). Never populate this from parsing the model's own generated text —
 * only from a structured protocol/API field (see the docblock above for the
 * concrete per-adapter sources).
 */
export function reportedModelMetadata(reportedModel: unknown): {
  reportedModel?: string;
} {
  const bounded = boundedModelId(reportedModel);
  return bounded ? { reportedModel: bounded } : {};
}
