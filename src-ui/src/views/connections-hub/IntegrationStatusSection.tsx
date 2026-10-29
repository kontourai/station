import type {
  IntegrationActionStatus,
  IntegrationConnectionStatus,
} from '@kontourai/station-contracts/integration-status';
import {
  useIntegrationStatusQuery,
  usePluginVisibilityQuery,
} from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { Badge, Popover, Tooltip } from '@kontourai/ui/react';
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

function CapabilityChip({ action }: { action: IntegrationActionStatus }) {
  const hasProbe =
    typeof action.computedBy === 'string' &&
    action.computedBy.trim().length > 0;
  const state = hasProbe ? action.state : 'unverified';
  const reason = hasProbe ? action.reason : 'No probe result is available.';
  const label = actions[action.action];
  const presentation = states[state];
  return (
    <Popover
      ariaLabel={`${label} status details`}
      className="integration-status__popover"
      trigger={
        <Tooltip label={reason}>
          <Button
            variant="ghost"
            className="integration-status__chip"
            aria-label={`${label}: ${presentation.label}`}
            aria-haspopup="dialog"
          >
            <span>{label}</span>
            <Badge value={presentation.label} tone={presentation.tone} />
          </Button>
        </Tooltip>
      }
    >
      <p>{reason}</p>
      {hasProbe && <small>Probe: {action.computedBy}</small>}
    </Popover>
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
                <section key={connection.connectionId}>
                  <h3>{providers[connection.provider]}</h3>
                  <ul>
                    {connection.actions.map((action) => (
                      <li key={action.action}>
                        <CapabilityChip action={action} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        ) : (
          <Empty label="No integration status available" variant="compact" />
        )}
      </div>
    </details>
  );
}
