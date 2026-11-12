import type {
  WorkspacePaneInstance,
  WorkspacePaneStandardDataRendererRef,
} from '@kontourai/station-contracts/workspace-pane';
import { Empty } from '../components/state';
import { sameLayoutContribution } from './layoutContributionIdentity';

/**
 * Host-neutral standard-data presentation. It deliberately renders only the
 * declared read-only projection and exact contribution identity; it has no
 * tool, action, iframe, or plugin-code path.
 */
export function WorkspacePaneStandardDataView({
  renderer,
  instance,
}: {
  renderer: WorkspacePaneStandardDataRendererRef;
  instance: WorkspacePaneInstance;
}) {
  const contribution = instance.boundContext?.contribution;
  if (
    !contribution ||
    !sameLayoutContribution(contribution, renderer.view.contribution)
  ) {
    return (
      <Empty
        variant="prominent"
        label="View unavailable"
        description="This view no longer matches its plugin. Close the tab and reopen it."
      />
    );
  }

  return (
    <section aria-label="Read-only standard data view">
      <Empty variant="prominent" label="Data view" description="Read-only" />
      <details>
        <summary>Details</summary>
        <pre className="workspace-default__description">
          {JSON.stringify(
            {
              contribution,
              incarnation: renderer.view.incarnation,
              projection: renderer.view.projection,
              schemaRef: renderer.view.schemaRef,
              readOnly: true,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
