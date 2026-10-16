import type {
  AccountPreferences,
  AccountPreferencesPatch,
} from '@kontourai/station-contracts/account-preferences';

export function applyAccountPreferencePatch(
  current: AccountPreferences,
  patch: AccountPreferencesPatch,
  onlyMissing = false,
): AccountPreferences {
  const values = { ...current };
  for (const key of Object.keys(patch) as (keyof AccountPreferencesPatch)[]) {
    if (onlyMissing && Object.hasOwn(current, key)) continue;
    if (patch[key] === null) delete values[key];
    else if (
      key === 'interactiveApprovalModes' &&
      patch.interactiveApprovalModes
    ) {
      const modes = { ...values.interactiveApprovalModes };
      for (const engine of ['codex', 'claude', 'muse'] as const) {
        const pick = patch.interactiveApprovalModes[engine];
        if (pick === null) delete modes[engine];
        else if (pick !== undefined) modes[engine] = pick;
      }
      values.interactiveApprovalModes = modes;
    } else Object.assign(values, { [key]: patch[key] });
  }
  return values;
}
