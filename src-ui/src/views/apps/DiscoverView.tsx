import type {
  RegistryAppPlacement,
  RegistryAppWorksWith,
} from '@kontourai/station-contracts/catalog';
import {
  type RegistryCatalogTab,
  useInstalledRegistryItemsQuery,
  useInvalidateQuery,
  usePluginsQuery,
  useRegistryItemsQuery,
} from '@kontourai/station-sdk';
import { Badge } from '@kontourai/ui/react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Button } from '../../components/Button';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import { LockGlyph } from '../../components/icons/Glyph';
import { MarketplaceSources } from '../../components/registry/MarketplaceSources';
import {
  getRegistryItemId,
  type RegistryItem,
} from '../../components/registry/RegistryCatalog';
import {
  StationExtensionsAccess,
  useStationExtensionsAccess,
} from '../../components/registry/StationExtensionsAccess';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  FilteredEmpty,
  SkeletonList,
} from '../../components/state';
import { useNavigation } from '../../contexts/NavigationContext';
import { pluginRegistry } from '../../core/PluginRegistry';
import { useIsMobile } from '../../hooks/useIsMobile';
import { RemovePluginModal } from '../plugin-management/RemovePluginModal';
import { usePluginCatalogInstall } from '../plugin-management/usePluginCatalogInstall';
import {
  appFactsOf,
  bringsLine,
  type DiscoverFilter,
  discoverKind,
  facetCounts,
  filterDiscover,
  OPENS_AS_LABELS,
  opensAsLine,
  trustLine,
  WORKS_WITH_LABELS,
} from './discoverModel';

const MORE_FILTERS_ID = 'discover-more-filters';

/**
 * Apps › Discover: the plugin catalogue, described by what each entry's
 * manifest says (`RegistryItem.app`). Facets offer only what the facts back.
 */
export function DiscoverView() {
  const { navigate } = useNavigation();
  const invalidateQuery = useInvalidateQuery();
  const extensionAccess = useStationExtensionsAccess();
  const pluginRegistryStatus = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getLoadStatus,
  );
  const [filter, setFilter] = useState<DiscoverFilter>({
    worksWith: null,
    opensAs: null,
    query: '',
  });
  const [source, setSource] = useState('all');
  // On a phone the other filters fold under one control so the apps stay
  // near the top; on a wider screen they are always shown.
  const phone = useIsMobile();
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [overrides, setOverrides] = useState(() => new Map<string, boolean>());
  // Remove asks first, with the question Library asks. Once an app is
  // removed its Remove button is gone, so focus moves to the card's Review.
  const [removeConfirm, setRemoveConfirm] = useState<RegistryItem | null>(null);
  const [refocusId, setRefocusId] = useState<string | null>(null);
  const { data: installedPlugins } = usePluginsQuery();
  const catalog = useRegistryItemsQuery<RegistryItem>('plugins');
  const installedQuery =
    useInstalledRegistryItemsQuery<RegistryItem>('plugins');
  // Each catalogue read updates the sources' freshness, which the source
  // picker shows.
  useEffect(() => {
    if (catalog.dataUpdatedAt || catalog.error)
      void invalidateQuery(['registry', 'sources']);
  }, [catalog.dataUpdatedAt, catalog.error, invalidateQuery]);

  const actionCallbacks = (
    _tab: RegistryCatalogTab,
    item: RegistryItem,
    itemId: string,
    isInstalled: boolean,
    reportSuccess?: () => void,
  ) => ({
    onError: (error: Error) => setMessage(error.message),
    onSuccess: () => {
      setOverrides((current) => new Map(current).set(itemId, !isInstalled));
      if (reportSuccess) reportSuccess();
      else
        setMessage(
          `${isInstalled ? 'Removed' : 'Added'} ${item.displayName || itemId}`,
        );
      void installedQuery.refetch().finally(() => {
        setOverrides((current) => {
          const next = new Map(current);
          next.delete(itemId);
          return next;
        });
      });
    },
  });
  const { startInstall, previewMutation, pluginMutation, modal } =
    usePluginCatalogInstall({ actionCallbacks, setMessage });

  const available = catalog.data ?? [];
  const installedIds = useMemo(
    () => new Set((installedQuery.data ?? []).map(getRegistryItemId)),
    [installedQuery.data],
  );
  const isAdded = (item: RegistryItem) => {
    const id = getRegistryItemId(item);
    return overrides.get(id) ?? (installedIds.has(id) || !!item.installed);
  };
  const fromSource =
    source === 'all'
      ? available
      : available.filter((item) => item.catalog?.sourceId === source);
  const shown = filterDiscover(fromSource, filter);
  // Each facet counts what the search and the other facet leave, so a value
  // offered always has apps behind it; the chosen value stays to be cleared.
  const worksWith = facetCounts(
    filterDiscover(fromSource, { ...filter, worksWith: null }),
    WORKS_WITH_LABELS,
    (facts) => facts.worksWith,
    filter.worksWith,
  );
  const opensAs = facetCounts(
    filterDiscover(fromSource, { ...filter, opensAs: null }),
    OPENS_AS_LABELS,
    (facts) => facts.opensAs,
    filter.opensAs,
  );
  // A catalogue with a value for a facet keeps that facet's group, so a
  // search that matches nothing does not move the filters.
  const catalogueHasWorksWith =
    facetCounts(fromSource, WORKS_WITH_LABELS, (facts) => facts.worksWith)
      .length > 0;
  const catalogueHasOpensAs =
    facetCounts(fromSource, OPENS_AS_LABELS, (facts) => facts.opensAs).length >
    0;
  // What the folded filters are doing, named on their control.
  const activeMoreFilters = [
    OPENS_AS_LABELS.find(([value]) => value === filter.opensAs)?.[1],
    source === 'all'
      ? undefined
      : (available.find((item) => item.catalog?.sourceId === source)
          ?.catalogSourceName ?? 'one source'),
  ].filter((label): label is string => label !== undefined);
  const stale = available.some((item) => item.catalogFreshness === 'stale');
  const pendingId = previewMutation.isPending
    ? previewMutation.variables
    : pluginMutation.isPending
      ? pluginMutation.variables?.id
      : undefined;
  const clearFilter = () =>
    setFilter({ worksWith: null, opensAs: null, query: '' });

  const remoteAccess = <StationExtensionsAccess />;

  return (
    <div className="discover">
      {extensionAccess.blocked && remoteAccess}
      {pluginRegistryStatus.state === 'degraded' &&
        pluginRegistryStatus.failure !== 'remote-isolation' && (
          <ErrorState
            variant="compact"
            title={
              pluginRegistryStatus.failedPluginNames.length
                ? `Couldn't load: ${pluginRegistryStatus.failedPluginNames.join(', ')}`
                : "Couldn't load this Station's apps"
            }
            action={
              <Button size="sm" onClick={() => void pluginRegistry.reload()}>
                Retry
              </Button>
            }
          />
        )}
      <div className="discover__layout">
        <input
          type="search"
          className="page__search-input discover__search"
          placeholder="Search apps"
          aria-label="Search apps"
          value={filter.query}
          onChange={(event) =>
            setFilter((current) => ({
              ...current,
              query: event.target.value,
            }))
          }
        />
        <FacetGroup
          className="discover__facet-group--works"
          shown={catalogueHasWorksWith}
          title="Works with"
          allLabel="Everything"
          selected={filter.worksWith}
          values={worksWith}
          onSelect={(worksWith: RegistryAppWorksWith | null) =>
            setFilter((current) => ({ ...current, worksWith }))
          }
        />
        <aside className="discover__facets" aria-label="More filters">
          {phone && (
            <DisclosureToggle
              expanded={moreFiltersOpen}
              onToggle={() => setMoreFiltersOpen((open) => !open)}
              controls={MORE_FILTERS_ID}
              className="discover__more-toggle"
            >
              {activeMoreFilters.length > 0
                ? `More filters · ${activeMoreFilters.join(', ')}`
                : 'More filters'}
            </DisclosureToggle>
          )}
          {(!phone || moreFiltersOpen) && (
            <div id={MORE_FILTERS_ID} className="discover__more-filters">
              <FacetGroup
                className="discover__facet-group--opens"
                shown={catalogueHasOpensAs}
                title="Opens as"
                allLabel="Anywhere"
                selected={filter.opensAs}
                values={opensAs}
                onSelect={(opensAs: RegistryAppPlacement | null) =>
                  setFilter((current) => ({ ...current, opensAs }))
                }
              />
              <div className="discover__facet-group discover__facet-group--from">
                <h2 className="discover__facet-title">From</h2>
                <MarketplaceSources
                  selected={source}
                  onSelect={(id) => setSource(id)}
                  kinds={['plugins']}
                  manage="dialog"
                  label="Show apps from"
                  hideLabel
                />
              </div>
              <p className="discover__elsewhere">
                Skills and tool servers are found where you use them:{' '}
                <button
                  type="button"
                  className="discover__link"
                  onClick={() => navigate('/guidance?tab=skills')}
                >
                  Skills
                </button>{' '}
                and{' '}
                <button
                  type="button"
                  className="discover__link"
                  onClick={() => navigate('/connections/tools')}
                >
                  Tools
                </button>
                .
              </p>
            </div>
          )}
        </aside>
        <section className="discover__results" aria-label="Apps">
          {stale && (
            <p className="discover__notice" role="status">
              Some apps are from the last list Station could read from their
              source. Refresh the source in Manage sources to see what is there
              now.
            </p>
          )}
          {message && (
            <p className="discover__notice" role="status">
              {message}
            </p>
          )}
          {catalog.isLoading && catalog.data === undefined ? (
            <SkeletonList count={6} label="Loading apps" />
          ) : catalog.error && catalog.data === undefined ? (
            <ErrorState
              title="Couldn't load apps"
              description={describeReadFailure(catalog.error)}
              action={
                <Button size="sm" onClick={() => void catalog.refetch()}>
                  Retry
                </Button>
              }
            />
          ) : available.length === 0 ? (
            <Empty
              variant="prominent"
              label="Your sources list no apps yet"
              description="Add a source to find apps to add."
            />
          ) : shown.length === 0 ? (
            <FilteredEmpty
              query={filter.query || 'this filter'}
              noun="apps"
              onClear={clearFilter}
            />
          ) : (
            <ul className="discover__grid">
              {shown.map((item) => (
                <DiscoverCard
                  key={getRegistryItemId(item)}
                  item={item}
                  added={isAdded(item)}
                  checking={
                    installedQuery.isLoading &&
                    installedQuery.data === undefined
                  }
                  pending={pendingId === getRegistryItemId(item)}
                  onReview={() => {
                    setMessage(null);
                    startInstall('plugins', item, getRegistryItemId(item));
                  }}
                  onRemove={() => setRemoveConfirm(item)}
                  refocusReview={refocusId === getRegistryItemId(item)}
                  onReviewFocused={() => setRefocusId(null)}
                  onManage={() =>
                    navigate(
                      item.installedPluginName
                        ? `/apps/library/${encodeURIComponent(item.installedPluginName)}`
                        : '/apps/library',
                    )
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </div>
      {!extensionAccess.blocked && remoteAccess}
      {modal}
      {removeConfirm && (
        <RemovePluginModal
          name={removeConfirm.displayName || getRegistryItemId(removeConfirm)}
          retainsData={(installedPlugins ?? []).some(
            (plugin) =>
              plugin.name ===
                (removeConfirm.installedPluginName ??
                  getRegistryItemId(removeConfirm)) &&
              !('status' in plugin) &&
              plugin.retainedOnRemoval === true,
          )}
          onCancel={() => setRemoveConfirm(null)}
          onConfirm={() => {
            const item = removeConfirm;
            const id = getRegistryItemId(item);
            setRemoveConfirm(null);
            setMessage(null);
            const callbacks = actionCallbacks('plugins', item, id, true);
            pluginMutation.mutate(
              { id: item.installedPluginName ?? id, action: 'uninstall' },
              {
                ...callbacks,
                onSuccess: () => {
                  setRefocusId(id);
                  callbacks.onSuccess();
                },
              },
            );
          }}
        />
      )}
    </div>
  );
}

function FacetGroup<T extends string>({
  className,
  shown,
  title,
  allLabel,
  selected,
  values,
  onSelect,
}: {
  className: string;
  /** Whether the catalogue has any value for this facet at all. */
  shown: boolean;
  title: string;
  allLabel: string;
  selected: T | null;
  values: Array<{ value: T; label: string; count: number }>;
  onSelect: (value: T | null) => void;
}) {
  if (!shown) return null;
  return (
    <fieldset className={`discover__facet-group ${className}`}>
      <legend className="discover__facet-title">{title}</legend>
      <ul className="discover__facet-list">
        <li>
          <button
            type="button"
            className="discover__facet"
            aria-pressed={selected === null}
            onClick={() => onSelect(null)}
          >
            {allLabel}
          </button>
        </li>
        {values.map((entry) => (
          <li key={entry.value}>
            <button
              type="button"
              className="discover__facet"
              aria-pressed={selected === entry.value}
              onClick={() => onSelect(entry.value)}
            >
              {/* Spaced so the name reads "Knowledge 2 apps", not "Knowledge2". */}
              <span>{entry.label}</span>{' '}
              <span className="discover__facet-count">
                {entry.count}{' '}
                <span className="sr-only">
                  {entry.count === 1 ? 'app' : 'apps'}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function DiscoverCard({
  item,
  added,
  checking,
  pending,
  onReview,
  onRemove,
  onManage,
  refocusReview,
  onReviewFocused,
}: {
  item: RegistryItem;
  added: boolean;
  checking: boolean;
  pending: boolean;
  onReview: () => void;
  onRemove: () => void;
  onManage: () => void;
  /** This card's app was just removed: focus its Review once it shows. */
  refocusReview: boolean;
  onReviewFocused: () => void;
}) {
  const reviewRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!refocusReview || added || pending || !reviewRef.current) return;
    reviewRef.current.focus();
    onReviewFocused();
  }, [refocusReview, added, pending, onReviewFocused]);
  const id = getRegistryItemId(item);
  const name = item.displayName || id;
  const kind = discoverKind(item);
  const facts = appFactsOf(item);
  const brings = facts ? bringsLine(facts) : null;
  const trust = facts ? trustLine(facts) : null;
  const headingId = `discover-card-${id}`;
  const from = [item.catalogSourceName, item.version && `v${item.version}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="discover__card" aria-labelledby={headingId}>
      <div className="discover__card-head">
        <h3 id={headingId} className="discover__card-name">
          {name}
        </h3>
        {from && <p className="discover__card-from">{from}</p>}
      </div>
      {item.description && (
        <p className="discover__card-description">{item.description}</p>
      )}
      {facts ? (
        <dl className="discover__facts">
          {facts.screens.length > 0 ? (
            <div>
              <dt>Screens</dt>
              <dd>{facts.screens.join(' · ')}</dd>
            </div>
          ) : (
            <div>
              <dt>Opens as</dt>
              <dd>{opensAsLine(facts)}</dd>
            </div>
          )}
          <div>
            <dt>Brings</dt>
            <dd>{brings ?? 'nothing extra'}</dd>
          </div>
          {facts.toolServers.length > 0 && (
            <div>
              <dt>Needs</dt>
              <dd>
                {facts.toolServers.join(', ')}{' '}
                {facts.toolServers.length === 1
                  ? 'tool server'
                  : 'tool servers'}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="discover__card-kind">
          {kind === 'no-screen'
            ? 'No screen of its own: it adds skills, agents or providers.'
            : 'What it includes is shown when you review it.'}
        </p>
      )}
      <div className="discover__card-footer">
        {trust === 'in-window' ? (
          <span className="discover__trust">Runs in Station's window</span>
        ) : trust === 'sandboxed' ? (
          <span className="discover__trust discover__trust--sandboxed">
            <LockGlyph /> Sandboxed
          </span>
        ) : (
          <span />
        )}
        <div className="discover__card-actions">
          {added ? (
            <>
              <Badge value="Added" tone="active" />
              <Button
                variant="secondary"
                size="sm"
                disabled={pending || checking}
                aria-label={`Remove ${name}`}
                onClick={onRemove}
              >
                {pending ? 'Working…' : 'Remove'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Manage ${name}`}
                onClick={onManage}
              >
                Manage
              </Button>
            </>
          ) : (
            <Button
              ref={reviewRef}
              variant="secondary"
              size="sm"
              disabled={pending || checking}
              aria-label={`Review ${name}`}
              onClick={onReview}
            >
              {checking ? 'Checking…' : pending ? 'Working…' : 'Review'}
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
