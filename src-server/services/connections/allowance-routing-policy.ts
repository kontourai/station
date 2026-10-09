import type { ConnectionQuotaSnapshot } from '@kontourai/station-contracts/connection-quota';
import type { AllowanceRoutingPreference } from '@kontourai/station-contracts/connection-recovery';

const ALLOWANCE_OBSERVATION_MAX_AGE_MS = 60_000;

/** Ranks already-authorized candidates; it neither enrolls nor applies one. */
export function selectExpiringAllowance(input: {
  candidates: readonly {
    profileRef: string;
    snapshot?: ConnectionQuotaSnapshot;
  }[];
  preference: AllowanceRoutingPreference;
  connectionId: string;
  provider: ConnectionQuotaSnapshot['provider'];
  now: number;
}): { preferredProfileRef?: string; excludedProfileRefs: string[] } {
  const fresh = (observedAt: string) => {
    const age = input.now - Date.parse(observedAt);
    return (
      Number.isFinite(age) &&
      age >= 0 &&
      age <= ALLOWANCE_OBSERVATION_MAX_AGE_MS
    );
  };
  const excludedProfileRefs: string[] = [];
  let selected: { ref: string; deadline: number } | undefined;
  for (const candidate of input.candidates) {
    const snapshot = candidate.snapshot;
    if (
      !snapshot ||
      snapshot.source !== 'provider-reported' ||
      snapshot.connectionId !== input.connectionId ||
      snapshot.provider !== input.provider ||
      snapshot.accountScope !== 'profile'
    )
      continue;
    const window = snapshot.windows.find(
      (item) => item.id === input.preference.windowId,
    );
    if (
      !window ||
      !fresh(window.observedAt) ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100
    )
      continue;
    if (
      100 - window.usedPercent < input.preference.minimumRemainingPercent ||
      snapshot.windows.some(
        (item) => fresh(item.observedAt) && item.usedPercent >= 100,
      )
    ) {
      excludedProfileRefs.push(candidate.profileRef);
      continue;
    }
    const qualifiedDeadline = (value: string | undefined) =>
      value && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        ? Date.parse(value)
        : Number.NaN;
    const resetDeadline = qualifiedDeadline(window.resetDeadlineAt);
    const subscription = snapshot.subscriptionEnd;
    const endDeadline =
      subscription?.value.renewal === 'non-renewing' &&
      fresh(subscription.observedAt)
        ? qualifiedDeadline(subscription.value.endsAt)
        : Number.NaN;
    const deadline =
      Number.isFinite(endDeadline) && endDeadline > input.now
        ? Number.isFinite(resetDeadline) && resetDeadline > input.now
          ? Math.min(endDeadline, resetDeadline)
          : endDeadline
        : resetDeadline;
    if (!Number.isFinite(deadline) || deadline <= input.now) continue;
    if (!selected || deadline < selected.deadline)
      selected = { ref: candidate.profileRef, deadline };
  }
  return {
    ...(selected ? { preferredProfileRef: selected.ref } : {}),
    excludedProfileRefs,
  };
}
