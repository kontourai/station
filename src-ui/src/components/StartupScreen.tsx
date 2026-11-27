import { useLayoutEffect, useState } from 'react';
import {
  initialStartupIsActive,
  preparingStationTitle,
  retainInitialStartup,
} from '../lib/startup-presentation';
import { StationPreparingSurface } from './StationPreparingSurface';
import { SkeletonBlock } from './state';

/**
 * A stage of preparing Station before the app can show it. During a cold
 * launch the splash covers it and shows `message`. After launch (switching
 * Stations), the splash is gone, so this draws the same surface with the
 * Station being prepared as its title and this stage as its status line.
 */
export function StartupScreen({ message }: { message?: string }) {
  const text = message ?? 'Preparing Station';
  // Read once: whether this wait began under the launch splash.
  const [covered] = useState(initialStartupIsActive);
  useLayoutEffect(() => retainInitialStartup(text), [text]);
  if (covered) return <SkeletonBlock label={text} />;
  return (
    <StationPreparingSurface title={preparingStationTitle()} message={text} />
  );
}
