import type { RegistryCatalogTab } from '@kontourai/station-sdk';
import { useRegistrySkillContentQuery } from '@kontourai/station-sdk';
import { Button } from '../Button';
import { IntegrationGlyph } from '../icons/IntegrationGlyph';
import { SkeletonBlock } from '../state';
import {
  type RegistryLayoutAction,
  RegistryLayoutActions,
} from './RegistryLayoutActions';
import {
  getRegistryActionLabel,
  getRegistryItemId,
  getRegistrySkillInstallRefusal,
  getRegistrySourceLabel,
  type RegistryItem,
} from './registryCatalogModel';

interface ItemActions {
  clearMessage: () => void;
  select: (id: string) => void;
  runAction: (item: RegistryItem, id: string, installed: boolean) => void;
  runLayoutAction: (
    item: RegistryItem,
    id: string,
    action: RegistryLayoutAction,
  ) => void;
  onUseLayout: (id: string) => void;
  managePlugins?: () => void;
  openSkill?: (name: string) => void;
  openProjects?: () => void;
}

export function RegistryCatalogDetail({
  tab,
  item,
  id,
  installed,
  pending,
  checkingInstalled,
  actions,
}: {
  tab: RegistryCatalogTab;
  item: RegistryItem;
  id: string;
  installed: boolean;
  pending: boolean;
  checkingInstalled: boolean;
  actions: ItemActions;
}) {
  const installRefusal = installed
    ? null
    : getRegistrySkillInstallRefusal(tab, item);
  const skillHint =
    installRefusal ??
    (tab === 'skills'
      ? installed
        ? 'Removing deletes the workspace copy so the skill is no longer selectable in agent definitions.'
        : 'Installing copies this skill into the workspace so it becomes selectable in agent definitions.'
      : null);
  const source = getRegistrySourceLabel(item);
  const isInstalledPlugin = tab === 'plugins' && installed;
  return (
    <section
      className="page__card-loose registry-catalog__detail"
      data-testid="registry-detail"
      aria-labelledby={`registry-detail-${id}`}
    >
      <div className="page__section-label">Selected {tab.slice(0, -1)}</div>
      <RegistryItemHeading
        item={item}
        installed={installed}
        tab={tab}
        headingId={`registry-detail-${id}`}
      />
      {source && (
        <div className="page__meta-row">
          <span className="page__meta-pill">{source}</span>
        </div>
      )}
      {item.source && item.catalog && (
        <div className="page__subtitle">
          Source location:{' '}
          <code className="registry-catalog__source">{item.source}</code>
        </div>
      )}
      {item.catalogFreshness === 'stale' && (
        <p role="status">Offline marketplace · last successful catalog</p>
      )}
      {item.version && <div className="page__subtitle">v{item.version}</div>}
      {item.catalog && (
        <div className="page__subtitle">
          Catalog revision: <code>{item.catalog.revision.slice(0, 12)}</code>
        </div>
      )}
      {tab === 'skills' && item.catalog && (
        <RegistrySkillInstructions id={id} />
      )}
      {skillHint && <div className="page__subtitle">{skillHint}</div>}
      {isInstalledPlugin && (
        <div className="page__subtitle">
          This plugin is installed. Add its enabled layout to a project, or
          manage its settings in Plugins.
        </div>
      )}
      <div className="page__card-footer">
        {tab === 'layouts' ? (
          <RegistryLayoutActions
            item={item}
            pending={pending || checkingInstalled}
            showSecondary
            onAction={(action) => actions.runLayoutAction(item, id, action)}
            onUse={() => actions.onUseLayout(id)}
          />
        ) : tab === 'skills' && installed ? (
          <>
            <Button
              variant="primary"
              onClick={() => actions.openSkill?.(item.catalog?.itemId ?? id)}
            >
              Open skill
            </Button>
            <Button
              variant="secondary"
              disabled={pending || checkingInstalled}
              onClick={() => actions.runAction(item, id, true)}
            >
              Remove from workspace
            </Button>
          </>
        ) : isInstalledPlugin ? (
          <>
            <Button variant="primary" size="sm" onClick={actions.openProjects}>
              Open a Project to Add Layout
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={actions.managePlugins}
            >
              Manage Plugin
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending || checkingInstalled}
              onClick={() => {
                actions.clearMessage();
                actions.runAction(item, id, true);
              }}
            >
              {checkingInstalled
                ? 'Checking installed status...'
                : pending
                  ? 'Working...'
                  : 'Remove Plugin'}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={pending || checkingInstalled || !!installRefusal}
            onClick={() => {
              actions.clearMessage();
              actions.runAction(item, id, installed);
            }}
          >
            {installRefusal
              ? 'Unavailable'
              : checkingInstalled
                ? 'Checking installed status...'
                : pending
                  ? 'Working...'
                  : getRegistryActionLabel(tab, installed)}
          </Button>
        )}
      </div>
    </section>
  );
}

export function RegistryCatalogCard({
  tab,
  item,
  installed,
  selected,
  actions,
}: {
  tab: RegistryCatalogTab;
  item: RegistryItem;
  installed: boolean;
  selected: boolean;
  layoutPending: boolean;
  actions: ItemActions;
}) {
  const id = getRegistryItemId(item);
  const source = getRegistrySourceLabel(item);
  const choose = () => {
    actions.clearMessage();
    actions.select(id);
  };
  return (
    <article
      className={`page__card-loose${selected ? ' page__card-loose--selected' : ''}`}
    >
      <RegistryItemHeading item={item} installed={installed} tab={tab} />
      {item.version && (
        <div className="page__subtitle registry-catalog__version">
          v{item.version}
        </div>
      )}
      <div className="page__card-footer">
        <div className="page__meta-row">
          {source && <span className="page__meta-pill">{source}</span>}
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={selected}
          onClick={choose}
        >
          View {item.displayName || item.name || id} details
        </Button>
      </div>
    </article>
  );
}

function RegistryItemHeading({
  item,
  installed,
  tab,
  headingId,
}: {
  item: RegistryItem;
  installed: boolean;
  tab: RegistryCatalogTab;
  headingId?: string;
}) {
  const id = getRegistryItemId(item);
  const name = item.displayName || item.name || id;
  return (
    <div className="page__card-row">
      {tab === 'integrations' && (
        <IntegrationGlyph
          id={id}
          displayName={item.displayName || item.name}
          icon={item.icon}
          iconUrl={item.iconUrl}
          className="page__card-icon"
        />
      )}
      <div className="page__card-text">
        <div className="page__card-name" id={headingId}>
          {name}
        </div>
        {item.description && (
          <div className="page__card-desc">{item.description}</div>
        )}
      </div>
      <span className={`page__tag${installed ? ' page__tag--accent' : ''}`}>
        {tab === 'layouts'
          ? (item.lifecycle?.state ?? 'Available')
          : installed
            ? 'Installed'
            : getRegistrySkillInstallRefusal(tab, item)
              ? 'Unavailable'
              : 'Available'}
      </span>
    </div>
  );
}

function RegistrySkillInstructions({ id }: { id: string }) {
  const content = useRegistrySkillContentQuery(id);
  return (
    <details>
      <summary>Read skill instructions</summary>
      {content.isLoading ? (
        <SkeletonBlock count={3} label="Loading instructions" />
      ) : content.error ? (
        <p role="alert">{content.error.message}</p>
      ) : (
        <pre className="marketplaces__instructions">{content.data}</pre>
      )}
    </details>
  );
}
