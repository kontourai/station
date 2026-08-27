import type { ModelImageSupport } from '@kontourai/station-contracts/engine-capability-matrix';
import { useModelCapabilitiesQuery } from '@kontourai/station-sdk';

export type ModelCapability = {
  modelId: string;
  modelName: string;
  provider: string;
  inputModalities: string[];
  outputModalities: string[];
  supportsStreaming?: boolean;
  supportsImages?: boolean;
  supportsVideo?: boolean;
  supportsAudio?: boolean;
  lifecycleStatus?: string;
};

export function useModelCapabilities(): ModelCapability[] {
  const { data = [] } = useModelCapabilitiesQuery();
  return data;
}

/**
 * What this catalog actually knows about `modelId`'s image input, kept as
 * three states (station#3344).
 *
 * The catalog is Bedrock-only (`GET /api/models/capabilities` projects
 * `ListFoundationModels`), so a Claude Code, Codex, ACP or Ollama model id has
 * no row here and the honest answer is `'unknown'` — the engine's declared
 * `imageInput` cell decides those. Only a matched row that positively reports
 * no image modality returns `'no'`.
 */
export function useModelImageSupport(
  modelId: string | undefined,
): ModelImageSupport {
  const capabilities = useModelCapabilities();

  if (!modelId) return 'unknown';

  // Model IDs may have cross-region inference prefixes (e.g. "us.anthropic.claude-...")
  // that don't appear in the capabilities list. Match by suffix.
  const capability = capabilities.find(
    (c) =>
      c.modelId === modelId ||
      modelId.endsWith(c.modelId) ||
      c.modelId.endsWith(modelId),
  );
  if (!capability) return 'unknown';
  if (
    capability.supportsImages ||
    capability.supportsVideo ||
    capability.supportsAudio
  ) {
    return 'yes';
  }
  // Only a row that actually LISTS its accepted modalities can say `no`.
  // `inputModalities` is typed as required but arrives over the wire, and a
  // producer that omits it is a real shape: an empty list, a missing field
  // and a non-array all mean the catalog declined to say. Reading `.length`
  // off that unchecked is not a wrong answer, it is a TypeError inside a
  // hook the composer calls on every render — it blanked the whole app in
  // the browser fixture, whose rows are `{modelId}` and nothing else.
  return Array.isArray(capability.inputModalities) &&
    capability.inputModalities.length > 0
    ? 'no'
    : 'unknown';
}
