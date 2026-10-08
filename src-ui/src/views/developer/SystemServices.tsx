import { useSystemStatusForApiBaseQuery } from '@kontourai/station-sdk';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useNavigation } from '../../contexts/NavigationContext';

export function SystemServices({ apiBase }: { apiBase: string }) {
  const query = useSystemStatusForApiBaseQuery(apiBase);
  const { navigate } = useNavigation();
  const status = query.data;
  return (
    <div className="system-tab__services">
      <div className="developer-tab__header-row">
        <p className="system-tab__muted">
          Readiness reported by the connected Station.
        </p>
        <Button size="sm" onClick={() => void query.refetch()}>
          Refresh status
        </Button>
      </div>
      {query.isError && (
        <ErrorState
          variant="compact"
          title="Service status could not be refreshed"
        />
      )}
      {!status ? (
        query.isLoading ? (
          <SkeletonBlock count={2} label="Reading services" />
        ) : null
      ) : (
        <>
          {status.prerequisitesState !== 'ready' && (
            <p role="status">
              {status.prerequisitesState === 'stale'
                ? 'Showing the previous discovery snapshot while Station refreshes it.'
                : 'Host discovery is still pending.'}
            </p>
          )}
          <section className="system-tab__card">
            <div className="developer-tab__header-row">
              <h2>Engines</h2>
              <Button size="sm" onClick={() => navigate('/connections')}>
                Configure connections
              </Button>
            </div>
            {status.externalEngines?.length ? (
              <ul className="system-services__list">
                {status.externalEngines.map((engine) => (
                  <li key={engine.engineConnectionId ?? engine.engineId}>
                    <strong>{engine.name}</strong>
                    <span>
                      {engine.ready
                        ? 'Ready'
                        : (engine.reason?.replaceAll('_', ' ') ??
                          'Readiness not reported')}
                    </span>
                    {engine.source && <small>{engine.source}</small>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty
                variant="compact"
                label="No engine readiness records reported"
              />
            )}
          </section>
          <section className="system-tab__card">
            <h2>Runtime capabilities</h2>
            {status.capabilities ? (
              <ul className="system-services__list">
                {Object.entries(status.capabilities).map(
                  ([name, capability]) => (
                    <li key={name}>
                      <strong>{name}</strong>
                      <span>
                        {capability.ready
                          ? 'Ready'
                          : (capability.reason ?? 'Not ready')}
                      </span>
                      {capability.source && <small>{capability.source}</small>}
                    </li>
                  ),
                )}
              </ul>
            ) : (
              <Empty variant="compact" label="Capabilities not reported" />
            )}
          </section>
          <section className="system-tab__card">
            <h2>Developer services</h2>
            {status.developerServices?.length ? (
              <ul className="system-services__list">
                {status.developerServices.map((service) => (
                  <li key={service.id}>
                    <strong>{service.name}</strong>
                    <span>{service.state.replaceAll('_', ' ')}</span>
                    <small>{service.detail}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty
                variant="compact"
                label="Developer service observations not reported"
              />
            )}
          </section>
          <section className="system-tab__card">
            <h2>ACP connections</h2>
            {status.acp?.connections.length ? (
              <ul className="system-services__list">
                {status.acp.connections.map((connection) => (
                  <li key={connection.id}>
                    <strong>{connection.id}</strong>
                    <span>{connection.status}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty
                variant="compact"
                label="No ACP connection records reported"
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
