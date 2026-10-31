import type { AuthRef } from '@kontourai/station-contracts/datum-secret-reference';
export function materializeRepairCredential(
  reference: AuthRef,
  options?: { assertCurrent?: () => Promise<void>; signal?: AbortSignal },
): Promise<string>;
