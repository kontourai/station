import { WORKSPACE_BROWSER_PANE_STATE_VERSION } from '@kontourai/station-contracts/workspace-browser-pane';
import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../components/Button';
import { LazyBoundary } from '../components/LazyBoundary';
import { SkeletonBlock } from '../components/state';
import { useApiBase } from '../contexts/ApiBaseContext';
import {
  BrowserApiError,
  type BrowserFetch,
  browserPaneApi,
  describeBrowserFailure,
} from './browser-pane/browserPaneApi';
import { createBrowserPreviewPaneInstance } from './browserPreviewPaneInstance';
import { createBrowserPreviewPaneStatePreparation } from './browserPreviewPaneStateStorage';
import type { WorkspacePaneHostOpenAction } from './WorkspacePaneHostOpenContext';
import { presentWorkspacePaneAvailability } from './workspacePaneAvailabilityPresentation';
import { describeWorkspacePaneOpenRefusal } from './workspacePaneHostOpenOutcome';

import './BrowserPreviewPaneLauncher.css';

const loadBrowserSetup = () => import('./browser-pane/BrowserSetup');

/**
 * Opens a Browser pane: the server opens a session for the address (it
 * normalizes and may refuse it), and the new pane is attached to it.
 */
export function BrowserPreviewPaneLauncher({
  projectId,
  projectSlug,
  host,
  availability,
  transport = authenticatedFetch,
}: {
  projectId: string;
  projectSlug: string;
  host: WorkspacePaneHostOpenAction | null;
  availability: WorkspacePaneAvailability;
  transport?: BrowserFetch;
}) {
  const { apiBase } = useApiBase();
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsBrowser, setNeedsBrowser] = useState(false);
  const availabilityPresentation =
    presentWorkspacePaneAvailability(availability);
  const enabled = availability.state === 'available' && host !== null;
  const unavailableReason =
    availability.state !== 'available'
      ? availabilityPresentation.reasonLabel
      : host === null
        ? 'The browser is unavailable until the workspace pane host is ready.'
        : null;
  const api = browserPaneApi(apiBase, transport);
  /**
   * A session was opened but no pane will show it: close it again, so an
   * orphaned server browser is not left running unseen (S8).
   */
  const abandon = (browserSessionId: string) => {
    void api.close(browserSessionId).catch(() => {});
  };
  const open = useMutation({
    mutationFn: (url: string) => api.create({ projectSlug, url }),
    onSuccess: (session) => {
      if (!host) {
        abandon(session.browserSessionId);
        setError(
          'The browser is unavailable until the workspace pane host is ready.',
        );
        return;
      }
      const state = {
        version: WORKSPACE_BROWSER_PANE_STATE_VERSION,
        projectId,
        browserSessionId: session.browserSessionId,
        updatedAt: new Date().toISOString(),
      };
      const instance = createBrowserPreviewPaneInstance(state, projectId);
      if (!instance) {
        abandon(session.browserSessionId);
        setError('Station could not open this Browser pane.');
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
      // The host's own reason, rather than one sentence for four
      // situations (#1596).
      if (!outcome.ok) abandon(session.browserSessionId);
      setError(
        outcome.ok ? null : describeWorkspacePaneOpenRefusal(outcome.reason),
      );
    },
    onError: (failure, url) => {
      if (
        failure instanceof BrowserApiError &&
        failure.code === 'browser-unavailable'
      ) {
        setNeedsBrowser(true);
        setError(null);
        return;
      }
      if (failure instanceof BrowserApiError && !failure.code) {
        // No typed answer at all: the route is not mounted here.
        if (failure.status === 404) {
          setError("The browser isn't available on this Station.");
          return;
        }
      }
      if (
        failure instanceof BrowserApiError &&
        failure.status === 403 &&
        failure.code === 'access-denied'
      ) {
        setError(
          "Only the Station operator and this Project's admins can open a browser here.",
        );
        return;
      }
      setError(describeBrowserFailure(failure, url));
    },
  });
  return (
    <form
      className="browser-launcher"
      onSubmit={(event) => {
        event.preventDefault();
        if (!enabled) return;
        open.mutate(address.trim() || 'about:blank');
      }}
    >
      <label className="browser-launcher__label">
        Browser address
        <input
          className="browser-launcher__address"
          aria-label="Browser address"
          placeholder="https://example.com"
          value={address}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setAddress(event.target.value)}
        />
      </label>
      <Button
        type="submit"
        variant="primary"
        className="browser-launcher__open"
        disabled={!enabled}
        pending={open.isPending}
      >
        Open Browser
      </Button>
      {unavailableReason ? (
        <p className="browser-launcher__note" role="status">
          {unavailableReason}
        </p>
      ) : null}
      {error ? (
        <p className="browser-launcher__note" role="alert">
          {error}
        </p>
      ) : null}
      {needsBrowser ? (
        <LazyBoundary
          load={loadBrowserSetup}
          componentProps={{
            projectSlug,
            onReady: () => setNeedsBrowser(false),
            transport,
          }}
          pending={<SkeletonBlock count={1} label="Checking the browser" />}
        />
      ) : null}
    </form>
  );
}
