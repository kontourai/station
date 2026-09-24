import { Button } from '../components/Button';
import { PageCallout } from '../components/PageCallout';

/**
 * The quiet "this is the cached pane catalog" marker (#2345). Shown when a
 * background refresh failed and the catalog kept its previous answer
 * (#2319), so what is on screen still works but may be out of date.
 */
export function WorkspacePaneCatalogRefreshNotice({
  onRetry,
  retrying = false,
}: {
  onRetry: () => void;
  /** A refetch is in flight: Retry refuses a second click. */
  retrying?: boolean;
}) {
  return (
    <PageCallout
      calloutId="workspace-pane-catalog-refresh-failed"
      tone="info"
      role="status"
      ariaLabel="Pane list not refreshed"
      action={
        <Button onClick={onRetry} pending={retrying}>
          Retry
        </Button>
      }
    >
      Couldn’t refresh the pane list. It may be out of date.
    </PageCallout>
  );
}
