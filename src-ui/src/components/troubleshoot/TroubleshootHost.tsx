/**
 * #4470: runs the Troubleshoot-with-an-agent flow on demand.
 *
 * Mounted from `DeferredAppOverlays` beside `ReportProblemHost`. It listens
 * for the open event the help menu, palette, Settings and error surfaces
 * dispatch, runs the start flow, and mounts the intro dialog through a
 * further `LazyBoundary` so its code loads only when someone troubleshoots.
 *
 * An event from an error surface carries that surface's facts. They become
 * the prepare seed here, with the route read at dispatch time; an event with
 * no facts (help menu, palette, Settings) sends no seed.
 */

import { useEffect } from 'react';
import { OPEN_TROUBLESHOOT_EVENT } from '../../lib/troubleshootEvents';
import { LazyBoundary } from '../LazyBoundary';
import { troubleshootSeedFromEvent } from './troubleshootSeed';
import { useStartTroubleshoot } from './useStartTroubleshoot';

const loadTroubleshootDialog = () => import('./TroubleshootDialog');

export function TroubleshootHost() {
  const { start, prepared, launch, cancel } = useStartTroubleshoot();

  useEffect(() => {
    const handleOpen = (event: Event) =>
      void start(troubleshootSeedFromEvent(event));
    window.addEventListener(OPEN_TROUBLESHOOT_EVENT, handleOpen);
    return () =>
      window.removeEventListener(OPEN_TROUBLESHOOT_EVENT, handleOpen);
  }, [start]);

  if (!prepared) return null;
  return (
    <LazyBoundary
      load={loadTroubleshootDialog}
      componentProps={{ prepared, onStart: launch, onClose: cancel }}
      pending={null}
    />
  );
}
