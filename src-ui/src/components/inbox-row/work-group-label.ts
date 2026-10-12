/**
 * A work group's heading text: "Needs you · 2", or just "Earlier" when the
 * host shows no count. The one format for every group heading on Home, the
 * chat dock inbox and Activity (lanes, Snoozed, Drafts, From other apps).
 */
export function workGroupLabelText(label: string, count?: number): string {
  return count === undefined ? label : `${label} · ${count}`;
}
