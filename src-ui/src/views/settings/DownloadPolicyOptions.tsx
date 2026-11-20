import {
  UPDATE_DOWNLOAD_POLICIES,
  type UpdateDownloadPolicy,
} from '@kontourai/station-contracts/system-status';

const policyLabels: Record<UpdateDownloadPolicy, string> = {
  never: 'Never',
  'after-24h': 'After 24 hours',
  immediately: 'Immediately',
};

export function DownloadPolicyOptions() {
  return UPDATE_DOWNLOAD_POLICIES.map((policy) => (
    <option key={policy} value={policy}>
      {policyLabels[policy]}
    </option>
  ));
}
