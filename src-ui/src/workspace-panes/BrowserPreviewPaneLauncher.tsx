import {
  normalizeLocalBrowserPreviewUrl,
  WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
} from '@kontourai/station-contracts/workspace-browser-preview';
import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import { useState } from 'react';
import { createBrowserPreviewPaneInstance } from './browserPreviewPaneInstance';
import { createBrowserPreviewPaneStatePreparation } from './browserPreviewPaneStateStorage';
import type { WorkspacePaneHostOpenAction } from './WorkspacePaneHostOpenContext';
import { presentWorkspacePaneAvailability } from './workspacePaneAvailabilityPresentation';
import { describeWorkspacePaneOpenRefusal } from './workspacePaneHostOpenOutcome';

export function BrowserPreviewPaneLauncher({
  projectId,
  host,
  availability,
}: {
  projectId: string;
  host: WorkspacePaneHostOpenAction | null;
  availability: WorkspacePaneAvailability;
}) {
  const [address, setAddress] = useState('http://127.0.0.1:5173/');
  const [error, setError] = useState<string | null>(null);
  const availabilityPresentation =
    presentWorkspacePaneAvailability(availability);
  const enabled = availability.state === 'available' && host !== null;
  const unavailableReason =
    availability.state !== 'available'
      ? availabilityPresentation.reasonLabel
      : host === null
        ? 'Browser Preview is unavailable until the workspace pane host is ready.'
        : null;
  return (
    <form
      className="coding-layout__browser-preview-launcher"
      onSubmit={(event) => {
        event.preventDefault();
        if (!host || availability.state !== 'available') return;
        let requestedUrl: string;
        try {
          requestedUrl = normalizeLocalBrowserPreviewUrl(address);
        } catch {
          setError('Enter an allowed local HTTP(S) address.');
          return;
        }
        const state = {
          version: WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
          projectId,
          requestedUrl,
          viewportPreference: 'responsive' as const,
          updatedAt: new Date().toISOString(),
        };
        const instance = createBrowserPreviewPaneInstance(state, projectId);
        if (!instance) {
          setError('Station could not open this Browser Preview pane.');
          return;
        }
        const outcome = host.open(
          instance,
          createBrowserPreviewPaneStatePreparation(
            window.localStorage,
            instance.stateKey,
            state,
          ),
        );
        if (!outcome.ok) {
          // The host's own reason, rather than one sentence for four
          // situations (#1596).
          setError(describeWorkspacePaneOpenRefusal(outcome.reason));
          return;
        }
        setError(null);
      }}
    >
      <label>
        Local preview address
        <input
          aria-label="Local preview address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </label>
      <button type="submit" disabled={!enabled}>
        Open Browser Preview
      </button>
      {unavailableReason ? <p role="status">{unavailableReason}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
