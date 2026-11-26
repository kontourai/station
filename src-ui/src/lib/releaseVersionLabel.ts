import { hostNightlyAllocation } from '@kontourai/station-shared/release-version-order';

/** A presentation label only; ordering and update authority still use the full version. */
export function releaseVersionLabel(version: string): string {
  const dated = /^\d+\.\d+\.\d+-nightly\.[0-9]{8}$/.test(version);
  const allocation = hostNightlyAllocation(dated ? `${version}.0` : version);
  if (!allocation || allocation.build < 0 || allocation.build >= 100)
    return version;
  const day = Math.floor(
    (allocation.date.getTime() - Date.UTC(2020, 0, 1)) / 86_400_000,
  );
  if (day < 0) return version;
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(allocation.date);
  return `Nightly · ${date} (build ${day * 100 + allocation.build})`;
}
