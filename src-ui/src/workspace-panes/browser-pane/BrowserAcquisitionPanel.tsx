import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import {
  type BrowserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from './browserPaneApi';

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/**
 * Chromium acquisition (D3). The download happens only on the operator's
 * explicit consent; nobody else can start it, so everyone else is told who
 * can.
 */
export function BrowserAcquisitionPanel({
  apiBase,
  api,
  operator,
  onReady,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  operator: boolean;
  onReady: () => void;
}) {
  const queryClient = useQueryClient();
  const acquisition = useQuery({
    queryKey: browserPaneKeys.acquisition(apiBase),
    queryFn: ({ signal }) => api.acquisition(signal),
    enabled: operator,
    refetchInterval: (query) =>
      query.state.data?.state === 'downloading' ? 1_000 : false,
  });
  const download = useMutation({
    mutationFn: () => api.download(),
    onSuccess: (status) =>
      queryClient.setQueryData(browserPaneKeys.acquisition(apiBase), status),
  });
  const state = acquisition.data?.state;
  const ready = state === 'found-system' || state === 'downloaded';
  useEffect(() => {
    if (ready) onReady();
  }, [ready, onReady]);

  if (!operator)
    return (
      <Empty
        variant="compact"
        label="The browser isn't set up yet"
        description="Ask the Station operator to set up the browser."
      />
    );
  if (acquisition.isPending)
    return <SkeletonBlock count={1} label="Checking for a browser" />;
  if (acquisition.isError)
    return (
      <ErrorState
        title="Station could not check for a browser"
        description={describeBrowserFailure(acquisition.error)}
        action={
          <Button
            className="browser-pane__control"
            onClick={() => void acquisition.refetch()}
          >
            Try again
          </Button>
        }
      />
    );
  const status = acquisition.data;
  if (status.state === 'downloading')
    return (
      <div className="browser-pane__acquisition" role="status">
        <p>
          Downloading Chromium {status.version}:{' '}
          {megabytes(status.receivedBytes)} of {megabytes(status.totalBytes)}.
        </p>
        <progress
          aria-label="Chromium download progress"
          max={status.totalBytes}
          value={status.receivedBytes}
        />
      </div>
    );
  if (status.state === 'failed' && status.reason === 'unsupported-platform')
    return (
      <Empty
        variant="compact"
        label="Station can't download Chromium for this computer"
        description="Install Google Chrome or Microsoft Edge on this computer, then try again."
        action={
          <Button
            className="browser-pane__control"
            onClick={() => void acquisition.refetch()}
          >
            Check again
          </Button>
        }
      />
    );
  if (status.state === 'needs-consent' || status.state === 'failed') {
    const size =
      status.state === 'needs-consent'
        ? ` (${megabytes(status.downloadBytes)})`
        : '';
    const canDownload = status.state === 'needs-consent' || status.retryable;
    return (
      <div className="browser-pane__acquisition">
        <p>
          No Google Chrome or Microsoft Edge was found on this computer. Station
          can download a pinned Chromium build into its own folder. Nothing is
          downloaded until you choose to.
        </p>
        {status.state === 'failed' ? (
          <p role="alert">The last download failed: {status.detail}</p>
        ) : null}
        {canDownload ? (
          <Button
            variant="primary"
            className="browser-pane__control"
            pending={download.isPending}
            pendingLabel="Starting download…"
            onClick={() => download.mutate()}
          >
            {`Download Chromium${size}`}
          </Button>
        ) : (
          <p>This download cannot be retried.</p>
        )}
        {download.isError ? (
          <p role="alert">{describeBrowserFailure(download.error)}</p>
        ) : null}
      </div>
    );
  }
  return <SkeletonBlock count={1} label="Starting the browser" />;
}
