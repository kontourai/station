import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';
import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import { layoutCatalogErrorReason, telemetry } from '@kontourai/station-sdk';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import { Empty, ErrorState, SkeletonList } from '../state';
import './ProjectLayoutCatalog.css';

export function mergeAvailableProjectLayouts(
  available: LayoutCatalogItem[],
): LayoutCatalogItem[] {
  const merged = new Map<string, LayoutCatalogItem>();
  for (const item of available) {
    // A profile/catalog response, not the client, decides whether a starter
    // exists and is safe to create.
    if (item.visible && item.enabled && item.lifecycle.state === 'installed') {
      merged.set(item.id, item);
    }
  }
  return [...merged.values()];
}

function sourceLabel(item: LayoutCatalogItem): string {
  if (item.source === 'builtin') {
    return 'Built in';
  }

  return item.plugin ? `Plugin: ${item.plugin}` : item.sourceIdentity.id;
}

function tabCountLabel(tabCount: number): string {
  return `${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'}`;
}

export function isProjectLayoutCatalogItemApplied(
  item: LayoutCatalogItem,
  layouts: LayoutMetadata[],
): boolean {
  if (item.source === 'plugin' && item.plugin) {
    return layouts.some((layout) => layout.plugin === item.plugin);
  }
  return layouts.some(
    (layout) => layout.plugin === undefined && layout.type === item.type,
  );
}

interface CatalogListProps {
  items: LayoutCatalogItem[];
  appliedLayouts: LayoutMetadata[];
  selectedId?: string | null;
  adding: string | null;
  onSelect: (item: LayoutCatalogItem) => void;
}

function CatalogList({
  items,
  appliedLayouts,
  selectedId,
  adding,
  onSelect,
}: CatalogListProps) {
  return (
    <div className="project-layout-catalog__list">
      {items.map((item) => {
        const isSelected = selectedId === item.id;
        const isPending = adding === item.id || adding === item.slug;
        const isApplied = isProjectLayoutCatalogItemApplied(
          item,
          appliedLayouts,
        );
        return (
          <button
            key={item.id}
            type="button"
            className={`project-layout-catalog__item${isSelected ? ' project-layout-catalog__item--selected' : ''}`}
            aria-pressed={selectedId === undefined ? undefined : isSelected}
            aria-busy={isPending || undefined}
            disabled={isPending}
            onClick={() => onSelect(item)}
          >
            {item.icon && (
              <span className="project-layout-catalog__icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="project-layout-catalog__info">
              <strong>{item.name}</strong>
              {item.description && <small>{item.description}</small>}
            </span>
            <span className="project-layout-catalog__metadata">
              <span className="project-layout-catalog__badge">
                {sourceLabel(item)}
              </span>
              <span className="project-layout-catalog__badge">{item.type}</span>
              {item.tabCount !== undefined && (
                <span className="project-layout-catalog__badge">
                  {tabCountLabel(item.tabCount)}
                </span>
              )}
              {isApplied && (
                <span className="project-layout-catalog__badge project-layout-catalog__badge--added">
                  Added
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CatalogError({
  error,
  hasItems,
  onRetry,
}: {
  error: unknown;
  hasItems: boolean;
  onRetry: () => void;
}) {
  const reason = layoutCatalogErrorReason(error);
  const isAuthenticationError = reason === 'authentication';

  function retry() {
    telemetry.track('ui.layout_catalog.state', {
      outcome: 'manual_retry',
      reason,
      cached: hasItems ? 1 : 0,
    });
    onRetry();
  }

  return (
    <ErrorState
      variant="compact"
      title={
        isAuthenticationError
          ? 'Station needs review'
          : hasItems
            ? "Some layouts couldn't be refreshed"
            : "Couldn't load layouts"
      }
      description={
        isAuthenticationError
          ? 'Your saved Station needs review before layouts can load.'
          : hasItems
            ? 'Showing installed layouts. Retry when your connection is available.'
            : 'Layouts are unavailable right now. Check your connection, then retry.'
      }
      action={
        isAuthenticationError ? (
          <button
            type="button"
            className="button"
            onClick={() => openConnectionsModal()}
          >
            Review Stations
          </button>
        ) : (
          <button type="button" className="button" onClick={retry}>
            Retry now
          </button>
        )
      }
    />
  );
}

/**
 * 4-HOME-014. Applying a layout used to fail into an empty `catch` in both
 * hosts of this picker — the dialog simply stayed open with nothing said.
 * The apply failure belongs next to the list the user just clicked, so it is
 * rendered here once rather than by each host.
 */
function ApplyError({ error }: { error: unknown }) {
  return (
    <ErrorState
      variant="compact"
      title="Couldn't add that layout"
      description={
        error instanceof Error && error.message
          ? error.message
          : 'Station could not add this layout to the project. Try again.'
      }
    />
  );
}

export function ProjectLayoutCatalog({
  available,
  adding,
  applyError,
  loading,
  catalogError,
  onRetry,
  onSelect,
  selectedId,
  appliedLayouts = [],
}: {
  available: LayoutCatalogItem[];
  /**
   * A stable catalog ID for selection-only callers such as New Project.
   * Omit it to retain the immediate-apply behavior used by existing callers.
   */
  selectedId?: string | null;
  /** Existing project layouts, used to distinguish adding another copy. */
  appliedLayouts?: LayoutMetadata[];
  adding: string | null;
  /** The most recent apply failure, if the last selection was refused. */
  applyError?: unknown;
  loading: boolean;
  catalogError: unknown;
  onRetry: () => void;
  onSelect: (item: LayoutCatalogItem) => void;
}) {
  const items = mergeAvailableProjectLayouts(available);
  const hasCatalogError = Boolean(catalogError);

  return (
    <div className="project-layout-catalog">
      <CatalogList
        items={items}
        appliedLayouts={appliedLayouts}
        selectedId={selectedId}
        adding={adding}
        onSelect={onSelect}
      />

      {loading && (
        <SkeletonList count={2} label="Loading more layouts" withIcon />
      )}

      {!loading && !hasCatalogError && items.length === 0 && (
        /* empty-state action: layouts are installed in Registry */
        <Empty
          variant="compact"
          label="Install a layout to continue"
          description="Installed layouts will appear here when this distribution makes them available."
        />
      )}

      {hasCatalogError && (
        <CatalogError
          error={catalogError}
          hasItems={items.length > 0}
          onRetry={onRetry}
        />
      )}

      {applyError ? <ApplyError error={applyError} /> : null}
    </div>
  );
}
