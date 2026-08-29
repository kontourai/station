/**
 * Mounts the Report-a-problem dialog on demand (#766 item 4).
 *
 * Lives in the `DeferredAppOverlays` chunk beside the command palette: it
 * installs the console capture as soon as that chunk resolves (so the dialog
 * has history to show), listens for the open event the palette and help menu
 * dispatch, and mounts the dialog itself through a further `LazyBoundary` so
 * its code is fetched only when someone actually reports a problem.
 */

import { useEffect, useState } from 'react';
import { OPEN_REPORT_PROBLEM_EVENT } from '../../lib/reportProblemEvents';
import { LazyBoundary } from '../LazyBoundary';
import {
  type CapturedConsoleEntry,
  installConsoleCapture,
  readCapturedConsoleEntries,
} from './console-capture';

const loadReportProblemDialog = () => import('./ReportProblemDialog');

export function ReportProblemHost() {
  // The console snapshot is taken HERE, at open, and handed to the dialog as
  // a prop — deliberately not read inside the dialog. The dialog's promise is
  // "this is what the report contains", so the preview must not drift under
  // the user while new console entries land mid-review; and a value import of
  // `console-capture` from the dialog chunk would force this (overlays) chunk
  // to grow a named export, which costs the ENTRY chunk a `.then(e=>e.D)`
  // facade on its dynamic import (+13 raw bytes, measured — see the
  // entry-budget comment atop DeferredAppOverlays).
  const [openEntries, setOpenEntries] = useState<CapturedConsoleEntry[] | null>(
    null,
  );

  useEffect(() => {
    installConsoleCapture();
  }, []);

  useEffect(() => {
    const handleOpen = () => setOpenEntries(readCapturedConsoleEntries());
    window.addEventListener(OPEN_REPORT_PROBLEM_EVENT, handleOpen);
    return () =>
      window.removeEventListener(OPEN_REPORT_PROBLEM_EVENT, handleOpen);
  }, []);

  if (openEntries === null) return null;
  return (
    <LazyBoundary
      load={loadReportProblemDialog}
      componentProps={{
        consoleEntries: openEntries,
        onClose: () => setOpenEntries(null),
      }}
      pending={null}
    />
  );
}
