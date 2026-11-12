import { useEngineConnectionsQuery } from '@kontourai/station-sdk';
import { Badge } from '@kontourai/ui/react';
import { Button } from '../components/Button';
import { PageSection } from '../components/PageSection';
import { usePageHeader } from '../components/page-frame';
import { AttentionList } from '../components/resource-hub/AttentionList';
import { ErrorState, SkeletonBlock } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { useConnectionSectionSignals } from './connections-hub/connection-section-signals';
import { CONNECTION_SECTIONS } from './connections-hub/connection-sections';
import { OverviewAllowance } from './connections-hub/OverviewAllowance';
import { OverviewUsage } from './connections-hub/OverviewUsage';
import { useEngineAccountAccess } from './engine-detail/useEngineAccountAccess';
import './ConnectionsHub.css';

/**
 * `/connections`: what needs fixing, each section's size and health, and —
 * for a viewer with `access:manage` — allowance and last week's usage
 * (docs/design/connections-overhaul.md, "Pages"). The attention list, the
 * tiles and the section rail read one derivation, so they cannot disagree.
 */
export function ConnectionsHub() {
  const { navigate } = useNavigation();
  const signals = useConnectionSectionSignals();
  const { data: engines = [] } = useEngineConnectionsQuery();
  const access = useEngineAccountAccess();
  usePageHeader({
    title: 'Connections',
    subtitle: 'What your agents run on, and what needs fixing.',
  });
  const manage = access.canManage && access.scope;
  const listedEngines = engines.filter(
    (engine) => engine.setup?.state !== 'available',
  );
  return (
    <div className="connections-overview content-stack">
      <PageSection title="Needs attention">
        {signals.unread.length ? (
          <ErrorState
            variant="compact"
            title="Some connections could not be loaded"
            action={<Button onClick={signals.retry}>Retry</Button>}
          />
        ) : null}
        {!signals.settled ? (
          <SkeletonBlock count={3} label="Loading connections" />
        ) : (
          <AttentionList
            label="Connections needing attention"
            emptyLabel={
              signals.unread.length
                ? 'Nothing else needs attention'
                : 'Nothing needs attention'
            }
            items={signals.attention.map((item) => {
              const action = item.action;
              return {
                id: item.id,
                title: item.title,
                status: item.status,
                sentence: item.sentence,
                ...(action
                  ? {
                      action: {
                        label: action.label,
                        onSelect: () => navigate(action.path),
                      },
                    }
                  : {}),
              };
            })}
          />
        )}
      </PageSection>
      <PageSection title="Sections">
        <ul className="connections-overview__tiles">
          {CONNECTION_SECTIONS.map((section) => {
            const unread = signals.unread.includes(section.id);
            return (
              <li key={section.id}>
                <button
                  type="button"
                  className="connections-overview__tile"
                  onClick={() => navigate(section.path)}
                >
                  <span className="connections-overview__tile-title">
                    {section.title}
                  </span>
                  <strong>{unread ? '—' : signals.count(section.id)}</strong>
                  {unread ? (
                    <Badge value="Not loaded" tone="neutral" />
                  ) : signals.needsAttention(section.id) ? (
                    <Badge value="Needs attention" tone="caution" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </PageSection>
      {manage ? (
        <>
          <PageSection title="Allowance">
            <OverviewAllowance
              scope={manage}
              engines={listedEngines.filter(
                (engine) => engine.type === 'claude' || engine.type === 'codex',
              )}
            />
          </PageSection>
          <PageSection title="Usage, last 7 days">
            <OverviewUsage
              scope={manage}
              names={new Map(engines.map((engine) => [engine.id, engine.name]))}
            />
          </PageSection>
        </>
      ) : null}
    </div>
  );
}
