/**
 * #4470: runs the Troubleshoot-with-an-agent flow on demand.
 *
 * Mounted from `DeferredAppOverlays` beside `ReportProblemHost`. It listens
 * for the open event the help menu, palette and Settings dispatch, runs the
 * start flow, and mounts the intro dialog through a further `LazyBoundary`
 * so its code loads only when someone troubleshoots.
 */

import { useEffect } from 'react';
import { OPEN_TROUBLESHOOT_EVENT } from '../../lib/troubleshootEvents';
import { LazyBoundary } from '../LazyBoundary';
import { useStartTroubleshoot } from './useStartTroubleshoot';

const loadTroubleshootDialog = () => import('./TroubleshootDialog');

export function TroubleshootHost() {
  const { start, prepared, launch, cancel } = useStartTroubleshoot();

  useEffect(() => {
    const handleOpen = () => void start();
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
