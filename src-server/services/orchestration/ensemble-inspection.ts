// UNWIRED(#91): the composed inspector supplies its current caller binding.

import { loadEnsemblePreset } from './ensemble-presets.js';

interface EnsemblePresetInspectionInput {
  readonly path: string;
  readonly contextKey: string;
  readonly expectedPresetHash?: string;
}

class EnsembleInspectionRefusal extends Error {
  constructor(
    readonly code:
      | 'ensemble_inspection_authority_required'
      | 'ensemble_inspection_invalid'
      | 'ensemble_inspection_stale'
      | 'ensemble_inspection_unavailable',
  ) {
    super(code);
    this.name = 'EnsembleInspectionRefusal';
  }
}

function label(value: string): string {
  return Array.from(value)
    .slice(0, 256)
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ? ' '
        : character,
    )
    .join('');
}

/** Project the authored declarations from one retained, authorized preset. */
export async function inspectEnsemblePreset(
  input: EnsemblePresetInspectionInput,
  isCurrent: (binding: EnsemblePresetInspectionInput) => boolean,
) {
  const { path, contextKey, expectedPresetHash } = input;
  const binding = Object.freeze({ path, contextKey, expectedPresetHash });
  const current = () =>
    typeof contextKey === 'string' &&
    contextKey.trim().length > 0 &&
    isCurrent?.(binding) === true;
  const assertAuthority = () => {
    if (!current())
      throw new EnsembleInspectionRefusal(
        'ensemble_inspection_authority_required',
      );
  };
  assertAuthority();
  if (
    expectedPresetHash !== undefined &&
    !/^sha256:[0-9a-f]{64}$/.test(expectedPresetHash)
  )
    throw new EnsembleInspectionRefusal('ensemble_inspection_invalid');

  const source = await loadEnsemblePreset(path, current).catch(() => {
    assertAuthority();
    throw new EnsembleInspectionRefusal('ensemble_inspection_unavailable');
  });
  assertAuthority();
  if (expectedPresetHash !== undefined && source.sha256 !== expectedPresetHash)
    throw new EnsembleInspectionRefusal('ensemble_inspection_stale');

  const preset = source.preset;
  const inspection = Object.freeze({
    source: Object.freeze({
      version: preset.version,
      sha256: source.sha256,
      presetId: preset.id,
      name: label(preset.name),
      stationmaster: preset.stationmaster,
    }),
    members: Object.freeze(
      preset.members.map((member) =>
        Object.freeze({
          id: member.id,
          codename: member.codename,
          color: member.color,
          role: label(member.role),
          engine: member.engine,
          model: label(member.model),
          reasoning: member.reasoning,
          options: member.options,
        }),
      ),
    ),
  });

  try {
    source.assertCurrent();
  } catch {
    assertAuthority();
    throw new EnsembleInspectionRefusal('ensemble_inspection_stale');
  }
  return inspection;
}
