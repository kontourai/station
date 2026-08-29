/**
 * DeferredAppOverlays — the app-level overlays that are always mounted but
 * never needed for first paint, behind ONE lazy boundary.
 *
 * Members are unconditionally mounted global chrome that installs a window
 * listener/query at startup and renders nothing until asked: the command
 * palette (`open-command-palette` + ⌘K), the guided first run
 * (`station-start-first-run-tour`, plus its own chapter state), and (archive#3089)
 * the resource-posture banner source, which renders nothing at all in the
 * common (healthy) case, and native tray navigation. The palette and first-run
 * flow already share a
 * module edge — the palette's "Take the tour" action calls
 * `requestFirstRunTour` from the first-run store — so they were resolving
 * together in practice anyway.
 *
 * WHY ONE BOUNDARY AND NOT MORE (archive#2652). Each `lazy( =>
 * import(...))` in the entry graph costs the entry chunk a chunk-registration
 * record — filename plus preload metadata — whether or not the chunk is ever
 * fetched. Measured on this tree: adding a second boundary for `FirstRunFlow`
 * cost **131 gzip bytes of the entry chunk**, roughly six times what all of the
 * feature's actual eager strings cost together (3 bytes), and pushed the entry
 * past its budget; a dedicated boundary for `ResourcePostureBannerSource`
 * measured the same way (archive#3089, ~176 gzip bytes against a ceiling with
 * ~0 bytes of headroom). Folding a member into this existing boundary keeps
 * the entry flat and keeps it out of the first-paint graph, which is what the
 * split was for. Do not re-split these without re-measuring `npm run build:ui`.
 */

import { useEffect } from 'react';
import { useNavigation } from '../contexts/NavigationContext';
import { OPEN_CONNECTIONS_MODAL_EVENT } from '../lib/connectionModalEvents';
import { subscribeToTrayNavigation } from '../lib/trayNavigation';
import { CommandPalette } from './CommandPalette';
import { FirstRunFlow } from './first-run/FirstRunFlow';
import { ResourcePostureBannerSource } from './notifications/ResourcePostureBannerSource';
import { ReportProblemHost } from './report-problem/ReportProblemHost';

function TrayNavigationListener() {
  const { navigate } = useNavigation();
  useEffect(
    () =>
      subscribeToTrayNavigation(navigate, () =>
        window.dispatchEvent(
          new CustomEvent(OPEN_CONNECTIONS_MODAL_EVENT, {
            detail: { mode: 'devices' },
          }),
        ),
      ),
    [navigate],
  );
  return null;
}

export default function DeferredAppOverlays() {
  return (
    <>
      <CommandPalette />
      <FirstRunFlow />
      <ResourcePostureBannerSource />
      <ReportProblemHost />
      <TrayNavigationListener />
    </>
  );
}
