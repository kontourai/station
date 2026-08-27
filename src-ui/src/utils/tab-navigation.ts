/**
 * Roving-tabindex arrow-key navigation shared by every ARIA `tablist` in the
 * app (station#4463 slice 2). Originally lived only in
 * `workspace-panes/WorkspacePaneHostTabs.tsx`; `components/Tabs.tsx` (the
 * page-level tab strip primitive) needed the identical Left/Right/Up/Down/
 * Home/End behavior, and two hand-rolled copies of the same keyboard
 * contract is exactly the drift this primitive extraction exists to remove.
 * `WorkspacePaneHostTabs` re-exports this under its original name so its own
 * test file's import keeps working unchanged.
 */
export function nextTabIndex(
  index: number,
  length: number,
  key: string,
): number | null {
  if (length === 0) return null;
  const last = length - 1;
  if (key === 'ArrowRight' || key === 'ArrowDown')
    return index === last ? 0 : index + 1;
  if (key === 'ArrowLeft' || key === 'ArrowUp')
    return index === 0 ? last : index - 1;
  if (key === 'Home') return 0;
  return key === 'End' ? last : null;
}
