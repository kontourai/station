import { authenticatedFetch } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { BrowserAcquisitionPanel } from './BrowserAcquisitionPanel';
import {
  type BrowserFetch,
  browserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from './browserPaneApi';

/**
 * The acquisition step on its own, for the launcher: shown when opening a
 * session was refused because no browser is set up yet. Lazily loaded.
 */
export default function BrowserSetup({
  projectSlug,
  onReady,
  transport = authenticatedFetch,
}: {
  projectSlug: string;
  onReady: () => void;
  transport?: BrowserFetch;
}) {
  const { apiBase } = useApiBase();
  const api = browserPaneApi(apiBase, transport);
  const access = useQuery({
    queryKey: browserPaneKeys.access(apiBase, projectSlug),
    queryFn: ({ signal }) => api.access(projectSlug, signal),
    retry: false,
  });
  if (access.isPending)
    return <SkeletonBlock count={1} label="Checking the browser" />;
  if (access.isError)
    return (
      <ErrorState
        title="Station could not check the browser"
        description={describeBrowserFailure(access.error)}
      />
    );
  if (access.data.browser === 'ready')
    return <Empty variant="compact" label="The browser is ready" />;
  return (
    <BrowserAcquisitionPanel
      apiBase={apiBase}
      api={api}
      operator={access.data.operator}
      onReady={onReady}
    />
  );
}
