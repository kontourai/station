import type {
  IntegrationActionStatus,
  IntegrationConnectionStatus,
} from '@kontourai/station-contracts/integration-status';
import {
  useIntegrationStatusQuery,
  usePluginVisibilityQuery,
} from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { Badge } from '@kontourai/ui/react';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import './IntegrationStatusSection.css';

const providers: Record<IntegrationConnectionStatus['provider'], string> = {
  github: 'GitHub',
  discord: 'Discord',
  slack: 'Slack',
  webhook: 'Webhooks',
  linear: 'Linear',
  jira: 'Jira',
};

const actions: Record<IntegrationActionStatus['action'], string> = {
  notify: 'Notify',
  start: 'Start',
  continue: 'Continue',
  approve: 'Approve',
  read: 'Read',
  write: 'Write',
  'link-pr': 'Link PR',
  'update-status': 'Update status',
  'close-issue': 'Close issue',
};

const states = {
  works: { label: 'Works', tone: 'positive' },
  unverified: { label: 'Unverified', tone: 'caution' },
  failed: { label: 'Failed', tone: 'negative' },
  'not-configured': { label: 'Not configured', tone: 'neutral' },
  'waiting-on-provider': { label: 'Not available yet', tone: 'neutral' },
  unsupported: { label: 'Not available yet', tone: 'neutral' },
} as const;

function actionPresentation(action: IntegrationActionStatus) {
  const hasProbe =
    typeof action.computedBy === 'string' &&
    action.computedBy.trim().length > 0;
  const state = hasProbe ? action.state : 'unverified';
  return {
    hasProbe,
    reason: hasProbe ? action.reason : 'No probe result is available.',
    label: actions[action.action],
    state: states[state],
  };
}

function ConnectionStatus({
  connection,
}: {
  connection: IntegrationConnectionStatus;
}) {
  const [selectedAction, setSelectedAction] = useState<
    IntegrationActionStatus['action'] | null
  >(null);
  const detailsId = useId();
  const selected = connection.actions.find(
    (action) => action.action === selectedAction,
  );
  const details = selected ? actionPresentation(selected) : null;
  return (
    <section>
      <h3>{providers[connection.provider]}</h3>
      <ul>
        {connection.actions.map((action) => {
          const display = actionPresentation(action);
          return (
            <li key={action.action}>
              <Button
                variant="ghost"
                className="integration-status__chip"
                aria-label={`${display.label}: ${display.state.label}`}
                aria-expanded={selectedAction === action.action}
                aria-controls={detailsId}
                title={display.reason}
                onClick={() =>
                  setSelectedAction((current) =>
                    current === action.action ? null : action.action,
                  )
                }
              >
                <span>{display.label}</span>
                <Badge value={display.state.label} tone={display.state.tone} />
              </Button>
            </li>
          );
        })}
      </ul>
      {selected && details && (
        <div
          id={detailsId}
          className="integration-status__details"
          role="status"
        >
          <strong>
            {details.label}: {details.state.label}
          </strong>
          <p>{details.reason}</p>
          {details.hasProbe && <small>Probe: {selected.computedBy}</small>}
        </div>
      )}
    </section>
  );
}

export function IntegrationStatusSection() {
  const enabled = useSurfaceVisibilityFlags().has('chat-apps');
  const authority = useHostRequestAuthorityScope();
  if (!enabled || !authority) return null;
  return (
    <IntegrationStatusForAuthority
      key={`${authority.apiBase}:${authority.authorityKey}`}
      authority={authority}
    />
  );
}

function IntegrationStatusForAuthority({
  authority,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const operator = usePluginVisibilityQuery();
  const status = useIntegrationStatusQuery(authority.apiBase, {
    requestScope: authority,
    enabled: operator.data !== undefined,
  });
  if (
    !operator.data ||
    (status.error instanceof StationHttpError && status.error.status === 403) ||
    (!status.data && !status.isError)
  )
    return null;

  return (
    <details className="integration-status">
      <summary>Integration status</summary>
      <div className="integration-status__body">
        {status.isError ? (
          <ErrorState
            variant="compact"
            title="Integration status unavailable"
            description="Check the Station connection and try again."
            action={
              <Button onClick={() => void status.refetch()}>Retry</Button>
            }
          />
        ) : status.isFetching ? (
          <SkeletonBlock count={2} label="Checking integration status" />
        ) : status.data?.connections.length ? (
          <>
            <div className="integration-status__heading">
              <p>Choose a status for its reason.</p>
              <Button variant="ghost" onClick={() => void status.refetch()}>
                Refresh
              </Button>
            </div>
            <div className="integration-status__connections">
              {status.data.connections.map((connection) => (
                <ConnectionStatus
                  key={connection.connectionId}
                  connection={connection}
                />
              ))}
            </div>
          </>
        ) : (
          <Empty label="Integration status list is empty" variant="compact" />
        )}
      </div>
    </details>
  );
}
