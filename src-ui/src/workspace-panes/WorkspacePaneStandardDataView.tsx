import type { LayoutCatalogContribution } from '@kontourai/station-contracts/layout';
import type {
  WorkspacePaneInstance,
  WorkspacePaneStandardDataRendererRef,
} from '@kontourai/station-contracts/workspace-pane';
import { Empty } from '../components/state';

function sameContribution(
  left: LayoutCatalogContribution,
  right: LayoutCatalogContribution,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
    !sameContribution(contribution, renderer.view.contribution)
  ) {
    return (
      <Empty
        variant="prominent"
        label="Standard data view unavailable"
        description="The placed contribution identity does not match this declared read-only view."
      />
    );
  }

  return (
    <section aria-label="Read-only standard data view">
      <Empty
        variant="prominent"
        label={renderer.view.projection}
        description="Station shows this view as read-only information. Nothing here can be changed."
      />
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
    </section>
  );
}
