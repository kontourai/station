import { SkeletonBlock } from '../components/state';

/** Placeholder; the Device pane's surface lands in the next commit (#1969). */
export function DeviceWorkspacePane() {
  return <SkeletonBlock count={3} label="Loading Device" />;
}
