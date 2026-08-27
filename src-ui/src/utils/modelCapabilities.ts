import type { ModelOption } from '@kontourai/station-contracts/tool';

export type SelectableModel = Pick<
  ModelOption,
  'id' | 'name' | 'capabilities'
> &
  Partial<Pick<ModelOption, 'originalId' | 'resolvedModel'>> & {
    providerId?: string;
    providerName?: string;
    providerType?: string;
    available?: boolean;
    unavailableReason?: string;
    description?: string;
    supportsVision?: boolean;
    toolSurface?: string[] | null;
  };

export type ModelProviderOption = {
  id: string;
  name: string;
  available: boolean;
  detail?: string;
};

/**
 * A model id made readable WITHOUT claiming a name the catalog never gave:
 * 'claude-opus-5[1m]' → 'Opus 5 (1M)'. Reached only when no catalog entry
 * exists for the id; an entry's own `name` always wins.
 *
 * Only hyphenated slugs are transformed. A provider-qualified id carries dots,
 * colons or slashes — `us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
 * `openai/gpt-5` — and splitting those on '-' produces
 * "Us.anthropic.claude Sonnet 4 5 20250929 V1:0", which is not a prettier name
 * but a fabricated one. For those the id itself is the most honest thing we
 * have, so it is returned unchanged (station#3391 review B-3).
 */
export function prettifyModelId(modelId: string): string {
  const id = modelId.trim();
  if (!id || /[.:/]/.test(id)) return id;
  const oneM = /\[1m\]$/i.test(id);
  const base = id
    .replace(/\[1m\]$/i, '')
    .replace(/^claude-/i, '')
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
  const label = oneM ? `${base} (1M)` : base;
  // 'claude-' prettifies to '' — a stripped prefix and nothing else. A blank
  // Home card is worse than the raw id (station#3391 review B-2).
  return label.trim() || id;
}

/**
 * The one derivation of "what do we call this model id" (station#3391).
 *
 * Home rendered two answers for one session: the start card resolved the id
 * against the catalog and read "Selected Test Model" while the continue card
 * printed the stored `model-selected` — the same fact, computed twice, and one
 * of the two showing a user an internal id. Every surface that turns an id
 * into something a person reads goes through here, so the two cannot disagree.
 *
 * The no-catalog-entry case is deliberately NOT the bare id and deliberately
 * NOT "Model not reported": the model WAS reported, we simply have no name for
 * it, and saying "not reported" would be a claim about the session rather than
 * about our catalog. The prettified id says exactly what is known.
 */
export function modelDisplayLabel(
  modelId: string | null | undefined,
  catalog: readonly SelectableModel[] = [],
): string {
  const id = modelId?.trim();
  if (!id) return 'Model not reported';
  const known = catalog.find(
    (model) => model.id === id || model.originalId === id,
  );
  // `|| id` is the last guard: a catalog entry with an empty `name` would
  // otherwise render blank, and an entry that exists is not a reason to show
  // nothing.
  return known?.name || prettifyModelId(id) || id;
}

/**
 * Human label for what an alias/default entry concretely resolves to (#1012):
 * prefer the catalog's own display name for the resolved id; otherwise
 * prettify the raw id ('claude-opus-5[1m]' → 'Opus 5 (1M)'). Undefined when
 * the entry is already concrete.
 */
export function resolvedModelLabel(
  entry: SelectableModel | undefined,
  models: SelectableModel[],
): string | undefined {
  const resolved = entry?.resolvedModel;
  if (!resolved) return undefined;
  const match = models.find(
    (model) =>
      model.id !== entry.id &&
      (model.originalId === resolved || model.id === resolved) &&
      !model.resolvedModel,
  );
  if (match) return match.name;
  return prettifyModelId(resolved);
}

export type NewChatModelChoice = {
  modelId?: string;
  /** Exact Station model-connection instance selected before launch. */
  providerId?: string;
  providerType?: string;
  providerOptions: Record<string, unknown>;
};

export const MODEL_CONTROL_KEYS = [
  'effort',
  'reasoningEffort',
  'fastMode',
  'autoMode',
  'thinking',
  'contextWindow',
  'longContext',
  'serviceTier',
] as const;

export function replaceModelControlOptions(
  current: Record<string, unknown>,
  applied: Record<string, unknown> = {},
): Record<string, unknown> {
  const next = { ...current };
  for (const key of MODEL_CONTROL_KEYS) delete next[key];
  return { ...next, ...applied };
}

/**
 * A report can acknowledge picker-owned controls only when every meaningful
 * model control agrees. Non-model options (for example approval posture) are
 * deliberately excluded: they have their own confirmation path.
 */
export function modelControlOptionsMatch(
  requested: Record<string, unknown> | undefined,
  reported: Record<string, unknown> | undefined,
): boolean {
  return MODEL_CONTROL_KEYS.every(
    (key) => requested?.[key] === reported?.[key],
  );
}

export function acknowledgesModelRequest(
  requestedModel: string | null | undefined,
  defaultModel: string | undefined,
  reportedModel: string | undefined,
): boolean {
  if (!reportedModel || requestedModel === undefined) return false;
  return requestedModel === null
    ? reportedModel === defaultModel
    : reportedModel === requestedModel;
}

export function effortLabel(value: string): string {
  if (value === 'xhigh') return 'Highest';
  if (value === 'max') return 'Maximum';
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function selectedModelOption(
  models: SelectableModel[],
  currentModel?: string,
  defaultModel?: string,
): SelectableModel | undefined {
  const id = currentModel || defaultModel;
  return (
    models.find((model) => model.id === id || model.originalId === id) ??
    models[0]
  );
}

/**
 * Keep approval and other non-model state, but remove model controls the newly
 * selected descriptor does not report. This prevents an effort from a prior
 * model silently leaking into the next turn.
 */
export function sanitizeRuntimeOptionsForModel(
  model: SelectableModel | undefined,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const next = replaceModelControlOptions(current);
  const capabilities = model?.capabilities;
  const supportedEffort = capabilities?.supportedEffortLevels ?? [];
  const currentEffort =
    typeof current.effort === 'string'
      ? current.effort
      : typeof current.reasoningEffort === 'string'
        ? current.reasoningEffort
        : undefined;
  if (
    capabilities?.supportsEffort === true &&
    currentEffort &&
    supportedEffort.includes(currentEffort)
  ) {
    next.effort = currentEffort;
  }
  if (
    capabilities?.supportsFastMode === true &&
    typeof current.fastMode === 'boolean'
  ) {
    next.fastMode = current.fastMode;
  }
  if (
    capabilities?.supportsAutoMode === true &&
    typeof current.autoMode === 'boolean'
  ) {
    next.autoMode = current.autoMode;
  }
  if (
    capabilities?.supportsAdaptiveThinking === true &&
    typeof current.thinking === 'boolean'
  ) {
    next.thinking = current.thinking;
  }
  return next;
}
