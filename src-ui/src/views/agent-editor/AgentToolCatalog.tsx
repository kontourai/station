import type { RegistryCatalogTab } from '@kontourai/station-sdk';
import { Button } from '../../components/Button';
import { IntegrationGlyph } from '../../components/icons/IntegrationGlyph';
import { MarketplaceSources } from '../../components/registry/MarketplaceSources';
import {
  getRegistryItemId,
  type RegistryItem,
} from '../../components/registry/RegistryCatalog';
import { Empty, SkeletonList } from '../../components/state';
import { Tabs } from '../../components/Tabs';

export function AgentToolCatalog({
  tab,
  onTab,
  search,
  onSearch,
  source,
  onSource,
  items,
  loading,
  error,
  message,
  installed,
  pendingId,
  pending,
  onInstall,
}: {
  tab: RegistryCatalogTab;
  onTab: (tab: RegistryCatalogTab) => void;
  search: string;
  onSearch: (query: string) => void;
  source: string;
  onSource: (id: string) => void;
  items: RegistryItem[];
  loading: boolean;
  error: Error | null;
  message: string | null;
  installed: (item: RegistryItem, id: string) => boolean;
  pendingId?: string;
  pending: boolean;
  onInstall: (item: RegistryItem, id: string, installed: boolean) => void;
}) {
  const available = items.filter(
    (item) => !installed(item, getRegistryItemId(item)),
  );
  return (
    <div className="agent-tool-catalog">
      <Tabs
        activation="automatic"
        id="agent-tool-catalog"
        aria-label="Tool catalogs"
        items={[
          { key: 'integrations', label: 'Servers' },
          { key: 'plugins', label: 'Plugins' },
        ]}
        activeKey={tab}
        onSelect={(key) => {
          onTab(key === 'plugins' ? 'plugins' : 'integrations');
          onSource('all');
        }}
      />
      {tab === 'plugins' && (
        <MarketplaceSources
          selected={source}
          onSelect={onSource}
          kinds={['plugins']}
        />
      )}
      <input
        type="search"
        className="editor-input"
        aria-label="Find tools"
        placeholder="Search catalogs"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
      />
      {message && (
        <p className="editor-hint" role="status">
          {message}
        </p>
      )}
      {loading ? (
        <SkeletonList count={3} label="Loading catalog" />
      ) : error ? (
        <p role="alert">Could not load this catalog.</p>
      ) : available.length === 0 ? (
        <Empty variant="compact" label="Nothing matches." />
      ) : (
        available.map((item) => {
          const id = getRegistryItemId(item);
          const from =
            item.catalogSourceName ||
            item.toolOrigin?.registryName ||
            'Registry provider';
          return (
            <article
              className="agent-tool-picker__source agent-tool-catalog__item"
              key={id}
            >
              <div className="agent-tool-picker__source-heading">
                <IntegrationGlyph
                  id={id}
                  displayName={item.displayName || id}
                  icon={item.icon}
                  iconUrl={item.iconUrl}
                  size={20}
                />
                <strong>{item.displayName || id}</strong>
                <Button
                  variant="secondary"
                  pending={pending && pendingId === id}
                  pendingLabel="Installing…"
                  disabled={pending}
                  onClick={() => onInstall(item, id, false)}
                >
                  {tab === 'plugins' ? 'Review install' : 'Install'}
                </Button>
              </div>
              <details className="agent-tool-picker__details">
                <summary>Details · {from}</summary>
                <p>{item.description || 'No description supplied.'}</p>
                {item.version && <p>Version {item.version}</p>}
                <code>{item.toolOrigin?.location || item.source || id}</code>
              </details>
            </article>
          );
        })
      )}
    </div>
  );
}
