import type { CodingEvidencePaneUnavailableReason } from '@kontourai/station-contracts/workspace-coding-evidence-composition';

/**
 * One sentence per reason the composition actually computed. It used to be a
 * single sentence naming both ("unavailable under its current capability or
 * grant") while the selection had the two inputs in hand, so a user could not
 * tell a capability this Station cannot reach — nothing they can grant their
 * way out of — from a Pane that simply is not granted one it can (#3158).
 */
export const CODING_EVIDENCE_UNAVAILABLE_DESCRIPTIONS: Record<
  CodingEvidencePaneUnavailableReason,
  string
> = {
  'capability-unavailable':
    'Station cannot reach the capability this evidence Pane reads from.',
  'grant-denied':
    'This evidence Pane is not granted the capability it reads from.',
  'capability-unavailable-and-grant-denied':
    'Station cannot reach the capability this evidence Pane reads from, and the Pane is not granted it either.',
};

/**
 * The rendered label and description for one unavailable Pane.
 *
 * Extracted because the map alone proves nothing about the LOOKUP. An
 * adversarial review showed that hardcoding `[entry.reason]` to
 * `['capability-unavailable']` in the renderer restored the exact pre-fix
 * defect — every unavailable Pane described as an unreachable capability —
 * with all 28 tests still green: one test proved the map's three strings
 * differ, another proved the composition emits the right reason, and nothing
 * connected them (station#3158 review).
 *
 * The renderer's JSX is a 1200-line component with no composition fixture, so
 * the honest seam is here, where a test can drive it directly.
 */
export function codingEvidenceUnavailableCopy(entry: {
  category: string;
  reason: CodingEvidencePaneUnavailableReason;
}): { label: string; description: string } {
  return {
    label: `${entry.category[0].toUpperCase()}${entry.category.slice(1)} evidence unavailable`,
    description: `${CODING_EVIDENCE_UNAVAILABLE_DESCRIPTIONS[entry.reason]} Healthy evidence Panes remain active.`,
  };
}
