import type { CodingDiffCompositionReceipt } from '@kontourai/station-contracts/workspace-coding-diff-composition';

export type CodingDiffCompositionTrack = (
  event: string,
  properties: Record<string, string | number>,
) => void;

export function trackCodingDiffCompositionReceipt(
  receipt: CodingDiffCompositionReceipt,
  track: CodingDiffCompositionTrack,
): void {
  const properties: Record<string, string | number> = {
    category: 'git-diff',
    control: receipt.control,
    outcome: receipt.outcome,
    restoration_identity_matched: receipt.restorationIdentityMatched ? 1 : 0,
    fallback_used: receipt.fallbackUsed ? 1 : 0,
  };
  if (receipt.reason) properties.reason = receipt.reason;
  track('ui.workspace_composition.coding_diff_path', properties);
}
