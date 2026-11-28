import {
  type AccountPreferences,
  type AccountPreferencesPatch,
  INTERACTIVE_APPROVAL_ENGINES,
  type InteractiveApprovalEngine,
} from '@kontourai/station-contracts/account-preferences';

export function interactiveApprovalEngine(
  engine?: string | null,
): InteractiveApprovalEngine | undefined {
  return INTERACTIVE_APPROVAL_ENGINES.find((candidate) => candidate === engine);
}

export function personalApprovalMode(
  values?: AccountPreferences,
  engine?: string | null,
) {
  const override = interactiveApprovalEngine(engine);
  return (
    (override ? values?.interactiveApprovalModes?.[override] : undefined) ??
    values?.interactiveApprovalDefault
  );
}

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
      for (const engine of INTERACTIVE_APPROVAL_ENGINES) {
        const pick = patch.interactiveApprovalModes[engine];
        if (pick === null) delete modes[engine];
        else if (pick !== undefined) modes[engine] = pick;
      }
      values.interactiveApprovalModes = modes;
    } else Object.assign(values, { [key]: patch[key] });
  }
  return values;
}
