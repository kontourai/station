import type { RegistryCatalogTab } from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import { PageFrameActions, usePageHeader } from '../page-frame';
import { Empty, FilteredEmpty, SkeletonList } from '../state';
import { Tabs, tabElementId, tabPanelElementId } from '../Tabs';
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

const TABS = [
  { key: 'agents', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'layouts', label: 'Layouts' },
  { key: 'kits', label: 'Kits' },
] as const satisfies readonly { key: RegistryCatalogTab; label: string }[];
type RegistryTabKeysExhaustive =
  RegistryCatalogTab extends (typeof TABS)[number]['key']
    ? true
    : [
        'TABS is missing a RegistryCatalogTab member:',
        Exclude<RegistryCatalogTab, (typeof TABS)[number]['key']>,
      ];
true satisfies RegistryTabKeysExhaustive;

/** Groups this view's generated tab/panel ids — see `components/Tabs.tsx`. */
const TABS_ID = 'registry-catalog';

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
  setActiveTab: (tab: RegistryCatalogTab) => void;
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
  managePlugins: () => void;
  openProjects: () => void;
  retryInstalled: () => void;
  renderKits?: () => ReactNode;
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
    managePlugins: actions.managePlugins,
    openProjects: actions.openProjects,
  };
  // The tab decides the description; the frame decides where it renders.
  usePageHeader({ subtitle: getRegistryTabCopy(activeTab).description });
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
      <Tabs
        id={TABS_ID}
        aria-label="Registry catalog"
        sticky
        // Automatic activation: switching tabs is a cheap in-place list
        // swap (no route push), matching Guidance/Memory below.
        //
        // archive#4463: whether ACTIVATION itself should
        // clear the search box is a real, open UX question (an arrow-key
        // journey through the strip clears it on every intermediate tab
        // under automatic activation, same as a click always did) — kept
        // as-is per arbiter decision, not silently changed here. What
        // changed is only that this can no longer fire on mere focus
        // movement without activation, which manual-mode hosts now do.
        activation="automatic"
        items={TABS}
        activeKey={activeTab}
        onSelect={(key) => {
          actions.clearMessage();
          actions.setSearch('');
          actions.setActiveTab(key as RegistryCatalogTab);
        }}
      />
      <div
        className="page__section-stack"
        role="tabpanel"
        id={tabPanelElementId(TABS_ID, activeTab)}
        aria-labelledby={tabElementId(TABS_ID, activeTab)}
      >
        {activeTab === 'kits' ? (
          actions.renderKits?.()
        ) : (
          <>
            <div className="page__search-row">
              <input
                type="text"
                className="page__search-input"
                placeholder={`Search ${activeTab}...`}
                value={search}
                onChange={(event) => actions.setSearch(event.target.value)}
                aria-label={`Search ${activeTab}`}
              />
            </div>
            <RegistryCatalogState
              tab={activeTab}
              message={message}
              loading={isLoading}
              error={loadError}
              installedStatusError={installedStatusError}
              onRetryInstalled={actions.retryInstalled}
              availableCount={available.length}
              filteredCount={filtered.length}
              query={search}
              onClearFilter={() => actions.setSearch('')}
            />
            {!isLoading && !loadError && filtered.length > 0 && (
              <>
                {selectedItem && selectedItemId && (
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
              </>
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
        <div className="page__empty">
          <p>Could not load {tab} right now.</p>
          <p className="page__subtitle">{error.message}</p>
        </div>
      )}
      {!loading && !error && availableCount === 0 && (
        <Empty
          variant="prominent"
          label={getRegistryTabCopy(tab).empty}
          description={
            tab === 'layouts'
              ? 'Install a plugin that contributes a layout, then add that layout to a project.'
              : 'Ask an administrator to include an item in a configured registry source, or browse the installed Plugins area to manage existing plugins.'
          }
          action={
            <a
              href="https://github.com/kontourai/station/blob/main/docs/guides/plugins.md"
              target="_blank"
              rel="noopener noreferrer"
              className="page__empty-action"
            >
              Open plugin guidance
            </a>
          }
        />
      )}
      {!loading && !error && availableCount > 0 && filteredCount === 0 && (
        <FilteredEmpty
          query={query}
          noun={tab}
          variant="prominent"
          onClear={onClearFilter}
        />
      )}
      {!loading && !error && installedStatusError && (
        <div className="page__message" role="alert">
          <span>
            Catalog entries are available, but installed status could not be
            confirmed: {installedStatusError.message}
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
