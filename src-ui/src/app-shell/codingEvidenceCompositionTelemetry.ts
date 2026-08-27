import type { CodingEvidenceCompositionReceipt } from '@kontourai/station-contracts/workspace-coding-evidence-composition';

export type CodingEvidenceCompositionTrack = (
  event: string,
  properties: Record<string, string | number>,
) => void;

export function trackCodingEvidenceCompositionReceipt(
  receipt: CodingEvidenceCompositionReceipt,
  track: CodingEvidenceCompositionTrack,
): void {
  const properties: Record<string, string | number> = {
    category: receipt.category,
    control: receipt.control,
    outcome: receipt.outcome,
    restoration_identity_matched: receipt.restorationIdentityMatched ? 1 : 0,
    fallback_used: receipt.fallbackUsed ? 1 : 0,
  };
  if (receipt.reason) properties.reason = receipt.reason;
  track('ui.workspace_composition.coding_evidence_path', properties);
}
