import type { RegistryCatalogTab } from '@kontourai/station-sdk';
import { type ReactNode, useMemo } from 'react';
import { describeStationFailure } from '../../utils/stationFailure';
import {
  PageEyebrowTrail,
  PageFrameActions,
  usePageHeader,
} from '../page-frame';
import { Empty, ErrorState, FilteredEmpty, SkeletonList } from '../state';
import {
  RegistryCatalogCard,
  RegistryCatalogDetail,
} from './RegistryCatalogItems';
import type { RegistryLayoutAction } from './RegistryLayoutActions';
import {
  getRegistryItemId,
  getRegistryTabCopy,
  type RegistryItem,
} from './registryCatalogModel';
// Side-effect import: this module applies the `page` root class below, and
// page-layout.css reached the bundle only because its single parent view
// happens to import it — the load-order dependency archive#3306 removes.
import '../../views/page-layout.css';
import { Button } from '../Button';

export type { RegistryItem } from './registryCatalogModel';
export { getRegistryItemId } from './registryCatalogModel';

export interface RegistryCatalogModel {
  activeTab: RegistryCatalogTab;
  search: string;
  message: string | null;
  isLoading: boolean;
  loadError: Error | null;
  isCheckingInstalled: boolean;
  installedStatusError: Error | null;
  available: RegistryItem[];
  filtered: RegistryItem[];
  installedIds: Set<string>;
  installationOverrides: Map<string, boolean>;
  selectedItem: RegistryItem | null;
  selectedItemId: string | null;
  selectedInstalled: boolean;
  selectedActionPending: boolean;
  layoutPendingId?: string;
  layoutPending: boolean;
}

export interface RegistryCatalogActions {
  setSearch: (value: string) => void;
  clearMessage: () => void;
  select: (id: string) => void;
  runAction: (item: RegistryItem, id: string, installed: boolean) => void;
  runLayoutAction: (
    item: RegistryItem,
    id: string,
    action: RegistryLayoutAction,
  ) => void;
  onUseLayout: (id: string) => void;
  manageSkills: () => void;
  openSkill?: (name: string) => void;
  retryInstalled: () => void;
  retryCatalog: () => void;
  renderKits?: () => ReactNode;
  /** Opens the place this catalogue is entered from (its eyebrow link). */
  openOwner?: (path: string) => void;
}

export function RegistryCatalog({
  model,
  actions,
}: {
  model: RegistryCatalogModel;
  actions: RegistryCatalogActions;
}) {
  const {
    activeTab,
    search,
    message,
    isLoading,
    loadError,
    isCheckingInstalled,
    installedStatusError,
    available,
    filtered,
    installedIds,
    installationOverrides,
    selectedItem,
    selectedItemId,
    selectedInstalled,
    selectedActionPending,
    layoutPendingId,
    layoutPending,
  } = model;
  const itemActions = {
    clearMessage: actions.clearMessage,
    select: actions.select,
    runAction: actions.runAction,
    runLayoutAction: actions.runLayoutAction,
    onUseLayout: actions.onUseLayout,
    openSkill: actions.openSkill,
  };
  // Each catalogue is a page of its own: the tab decides its title,
  // description and the place its eyebrow climbs back to.
  const copy = getRegistryTabCopy(activeTab);
  const { openOwner } = actions;
  const eyebrow = useMemo(() => {
    const owner = getRegistryTabCopy(activeTab).owner;
    return owner && openOwner ? (
      <PageEyebrowTrail
        segments={[
          { label: owner.label, onClick: () => openOwner(owner.path) },
        ]}
      />
    ) : undefined;
  }, [activeTab, openOwner]);
  usePageHeader({ eyebrow, title: copy.title, subtitle: copy.description });
  const isInstalled = (item: RegistryItem, id: string) => {
    const override = installationOverrides.get(`${activeTab}:${id}`);
    return override ?? (installedIds.has(id) || !!item.installed);
  };
  return (
    <>
      {/* The page header is the frame's (SHELL-11); what is left here is the
          tab's own action, which travels to the header's action cell, as the
          one shared `Button` rather than a page-scoped button class. */}
      <PageFrameActions>
        {activeTab === 'skills' && (
          <Button variant="secondary" size="sm" onClick={actions.manageSkills}>
            Manage Installed Skills
          </Button>
        )}
      </PageFrameActions>
      <div className="page__section-stack">
        {activeTab === 'kits' ? (
          actions.renderKits?.()
        ) : (
          <>
            <div className="page__search-row">
              <input
                type="text"
                className="page__search-input"
                placeholder={`Search ${copy.noun}…`}
                value={search}
                onChange={(event) => actions.setSearch(event.target.value)}
                aria-label={`Search ${copy.noun}`}
              />
            </div>
            <RegistryCatalogState
              tab={activeTab}
              message={message}
              loading={isLoading}
              error={loadError}
              onRetryCatalog={actions.retryCatalog}
              installedStatusError={installedStatusError}
              onRetryInstalled={actions.retryInstalled}
              availableCount={available.length}
              filteredCount={filtered.length}
              query={search}
              onClearFilter={() => actions.setSearch('')}
            />
            {!isLoading && !loadError && selectedItem && selectedItemId && (
              <RegistryCatalogDetail
                tab={activeTab}
                item={selectedItem}
                id={selectedItemId}
                installed={selectedInstalled}
                pending={selectedActionPending}
                checkingInstalled={isCheckingInstalled}
                actions={itemActions}
              />
            )}
            {!isLoading && !loadError && filtered.length > 0 && (
              <div className="page__card-grid">
                {filtered.map((item) => {
                  const id = getRegistryItemId(item);
                  return (
                    <RegistryCatalogCard
                      key={id}
                      tab={activeTab}
                      item={item}
                      installed={isInstalled(item, id)}
                      selected={id === selectedItemId}
                      layoutPending={layoutPending && layoutPendingId === id}
                      actions={itemActions}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function RegistryCatalogState({
  tab,
  message,
  loading,
  error,
  onRetryCatalog,
  installedStatusError,
  onRetryInstalled,
  availableCount,
  filteredCount,
  query,
  onClearFilter,
}: {
  tab: RegistryCatalogTab;
  message: string | null;
  loading: boolean;
  error: Error | null;
  onRetryCatalog: () => void;
  installedStatusError: Error | null;
  onRetryInstalled: () => void;
  availableCount: number;
  filteredCount: number;
  query: string;
  onClearFilter: () => void;
}) {
  return (
    <>
      {message && <div className="page__message">{message}</div>}
      {loading && <SkeletonList count={4} label="Loading catalog" />}
      {!loading && error && (
        <ErrorState
          title={`Could not load ${getRegistryTabCopy(tab).noun} right now.`}
          description={describeStationFailure(error).body}
          action={<Button onClick={onRetryCatalog}>Retry catalog</Button>}
        />
      )}
      {!loading && !error && availableCount === 0 && (
        <Empty
          variant="prominent"
          label={getRegistryTabCopy(tab).empty}
          description={
            tab === 'layouts'
              ? 'Install a plugin that contributes a layout, then add that layout to a Project.'
              : 'Add a source, or ask the Station operator to add one.'
          }
        />
      )}
      {!loading && !error && availableCount > 0 && filteredCount === 0 && (
        <FilteredEmpty
          query={query}
          noun={getRegistryTabCopy(tab).noun}
          variant="prominent"
          onClear={onClearFilter}
        />
      )}
      {!loading && !error && installedStatusError && (
        <div className="page__message" role="alert">
          <span>
            Catalog entries are available, but installed status could not be
            confirmed: {describeStationFailure(installedStatusError).body}
          </span>{' '}
          <button
            type="button"
            className="page__message-action"
            onClick={onRetryInstalled}
          >
            Retry installed status
          </button>
        </div>
      )}
    </>
  );
}
