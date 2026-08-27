import type { CodingFileCompositionReceipt } from '@kontourai/station-contracts/workspace-coding-file-composition';

export type CodingFileCompositionTrack = (
  event: string,
  properties: Record<string, string | number>,
) => void;

export function trackCodingFileCompositionReceipt(
  receipt: CodingFileCompositionReceipt,
  track: CodingFileCompositionTrack,
): void {
  const properties: Record<string, string | number> = {
    control: receipt.control,
    outcome: receipt.outcome,
    restoration_identity_matched: receipt.restorationIdentityMatched ? 1 : 0,
    fallback_used: receipt.fallbackUsed ? 1 : 0,
  };
  if (receipt.reason) properties.reason = receipt.reason;
  track('ui.workspace_composition.coding_file_path', properties);
}
