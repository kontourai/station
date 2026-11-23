import type {
  AutomationActionsUnavailable,
  AutomationDeliveryRecord,
  AutomationEpisodeRecord,
  AutomationRule,
  AutomationSourceProjection,
} from '@kontourai/station-contracts/automation';
import {
  useAutomationDeliveries,
  useAutomationEpisodes,
  useAutomationRules,
  useAutomationSources,
  useRetryAutomationEpisode,
} from '@kontourai/station-sdk';
import { StatusBadge } from '@kontourai/ui/react';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, Skeleton } from '../../components/state';
import { errorText } from '../../utils/errorText';
import './AutomationsSection.css';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

/**
 * GitHub automations (#4513): sources, rules, open episodes and recent
 * deliveries, read-only except "Retry episode". Honest counts: each heading's
 * count is the length of the list rendered under it, from the same array,
 * so a count can never disagree with what it links to. Each list is its own
 * read, so one failure leaves the others visible (a partial view).
 */

type Read<T> = {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
};

const PREVIEW_DISABLED = 'feature_preview_disabled';

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function AutomationList<T>({
  id,
  title,
  read,
  items,
  empty,
  render,
}: {
  id: string;
  title: string;
  read: Read<unknown>;
  items: readonly T[] | undefined;
  empty: string;
  render: (item: T) => ReactNode;
}) {
  const headingId = `automations-${id}`;
  return (
    <section className="automations__list" aria-labelledby={headingId}>
      <h4 id={headingId} className="automations__heading">
        {title}
        {items ? (
          <span className="automations__count"> · {items.length}</span>
        ) : null}
      </h4>
      {read.isLoading ? <Skeleton variant="line" /> : null}
      {read.isError ? (
        <ErrorState
          variant="compact"
          title={`${title} could not be read`}
          description={errorText(read.error)}
          action={<Button onClick={() => void read.refetch()}>Retry</Button>}
        />
      ) : null}
      {items && items.length === 0 ? (
        <Empty variant="compact" label={empty} />
      ) : null}
      {items && items.length > 0 ? (
        <ul className="automations__items">{items.map(render)}</ul>
      ) : null}
    </section>
  );
}

const STALLED: Record<AutomationActionsUnavailable['reason'], string> = {
  'projects-unreadable':
    'Automation Tasks are paused: Station cannot read its Projects. Pending runs start once it can.',
  unavailable:
    'Automation Tasks are paused: Station could not check their rules. Pending runs start once it can.',
};

/** A rule's effective approval posture, in a few words. */
function rulePosture(rule: AutomationRule): string | undefined {
  if (rule.action.kind !== 'dispatch-task') return undefined;
  if (rule.action.approvalMode === 'auto') return 'Approves its own tool calls';
  if (rule.action.approvalMode === 'connection-default')
    return "Agent's own approval settings";
  return 'Asks before acting';
}

/** Whether a Retry sent now could start the Agent. */
function retryCanStart(
  episode: AutomationEpisodeRecord,
  mayAct: boolean,
): boolean {
  return (
    mayAct &&
    !episode.retryNeedsRuleChange &&
    episode.startFailure !== 'task-not-canceled'
  );
}

/** Why the Agent did not start, and what helps now. */
function startFailedNote(
  episode: AutomationEpisodeRecord,
  rule: AutomationRule | undefined,
  mayAct: boolean,
): string {
  const agent = rule?.action.agentId ?? '';
  if (episode.startFailure === 'task-not-canceled')
    return 'The Agent did not start, and its Task could not be canceled. Cancel that Task before retrying.';
  if (episode.retryNeedsRuleChange)
    return episode.startFailure === 'agent-own-approval-required'
      ? `Agent ${agent} uses its own approval settings; set the rule's approval to the Agent's own, or change its Agent.`
      : `Agent ${agent} cannot take this approval setting. Retry returns when you change the rule's setting or its Agent.`;
  const why = 'The Agent did not start, so nothing ran.';
  return mayAct
    ? `${why} Retry is available.`
    : `${why} The rule is not live, so it cannot be retried.`;
}

function EpisodeRow({
  episode,
  rules,
  sources,
}: {
  episode: AutomationEpisodeRecord;
  rules: readonly AutomationRule[] | undefined;
  sources: readonly AutomationSourceProjection[] | undefined;
}) {
  const retry = useRetryAutomationEpisode();
  const rule = rules?.find((candidate) => candidate.id === episode.ruleId);
  const ruleName = rule?.name ?? episode.ruleId;
  const source = sources?.find((candidate) => candidate.id === rule?.sourceId);
  // The rule may act: live, on an enabled source that is not revoked. The
  // server still checks the grant when the retry is sent.
  const mayAct =
    rule?.mode === 'live' &&
    source?.enabled === true &&
    source.revokedAt === undefined;
  return (
    <li className="automations__item">
      <span>
        {ruleName} · episode {episode.episodeId} · {episode.attemptCount}/
        {episode.maxAttempts} attempts
      </span>
      <StatusBadge
        status={episode.state}
        tone={episode.state === 'open' ? 'neutral' : 'caution'}
      />
      {episode.startFailed ? (
        <span className="automations__note" role="status">
          {startFailedNote(episode, rule, mayAct)}
        </span>
      ) : null}
      {episode.state === 'exhausted' ||
      (episode.startFailed && retryCanStart(episode, mayAct)) ? (
        <Button
          disabled={retry.isPending}
          aria-label={`Retry episode ${episode.episodeId} of ${ruleName}`}
          onClick={() =>
            retry.mutate({
              ruleId: episode.ruleId,
              episodeId: episode.episodeId,
            })
          }
        >
          Retry episode
        </Button>
      ) : null}
      {retry.isError ? (
        <span className="automations__note" role="status">
          {errorText(retry.error)}
        </span>
      ) : null}
    </li>
  );
}

export function AutomationsSection() {
  const sources = useAutomationSources();
  const rules = useAutomationRules();
  const episodes = useAutomationEpisodes();
  const deliveries = useAutomationDeliveries();
  const reads = [sources, rules, episodes, deliveries];
  const previewOff = reads.some(
    (read) => read.isError && errorCode(read.error) === PREVIEW_DISABLED,
  );

  return (
    <SettingsSection
      icon="⟳"
      title="GitHub automations"
      id="section-github-automations"
    >
      <div {...settingsRow('github-automations')} tabIndex={-1}>
        {previewOff ? (
          <Empty
            variant="compact"
            label="GitHub automation observations are off"
            description="Turn them on in Feature previews to see sources, rules and deliveries."
          />
        ) : (
          <>
            <AutomationList<AutomationSourceProjection>
              id="sources"
              title="Sources"
              read={sources}
              items={sources.data?.sources}
              empty="No sources"
              render={(source) => (
                <li key={source.id} className="automations__item">
                  <span>
                    {source.name} · {source.repository}
                  </span>
                  <StatusBadge
                    status={
                      source.revokedAt
                        ? 'revoked'
                        : source.enabled
                          ? 'enabled'
                          : 'disabled'
                    }
                    tone={source.enabled ? 'positive' : 'neutral'}
                  />
                </li>
              )}
            />
            <AutomationList<AutomationRule>
              id="rules"
              title="Rules"
              read={rules}
              items={rules.data?.rules}
              empty="No rules"
              render={(rule) => (
                <li key={rule.id} className="automations__item">
                  <span>
                    {rule.name} · {rule.action.kind}
                    {rulePosture(rule) ? ` · ${rulePosture(rule)}` : ''}
                  </span>
                  <StatusBadge
                    status={rule.mode}
                    tone={rule.mode === 'live' ? 'positive' : 'neutral'}
                  />
                </li>
              )}
            />
            {episodes.data?.actionsUnavailable ? (
              <p className="automations__note" role="status">
                {STALLED[episodes.data.actionsUnavailable.reason]}
                {episodes.data.actionsUnavailable.detail
                  ? ` ${episodes.data.actionsUnavailable.detail}`
                  : ''}
              </p>
            ) : null}
            <AutomationList<AutomationEpisodeRecord>
              id="episodes"
              title="Open episodes"
              read={episodes}
              items={episodes.data?.episodes}
              empty="No open episodes"
              render={(episode) => (
                <EpisodeRow
                  key={`${episode.ruleId}:${episode.episodeId}`}
                  episode={episode}
                  rules={rules.data?.rules}
                  sources={sources.data?.sources}
                />
              )}
            />
            <AutomationList<AutomationDeliveryRecord>
              id="deliveries"
              title="Recent deliveries"
              read={deliveries}
              items={deliveries.data?.deliveries}
              empty="No deliveries yet"
              render={(delivery) => (
                <li key={delivery.deliveryKey} className="automations__item">
                  <span>{delivery.semanticKey}</span>
                  <StatusBadge
                    status={
                      delivery.reason
                        ? `${delivery.outcome} · ${delivery.reason}`
                        : delivery.outcome === 'stopped'
                          ? 'stopped by a person'
                          : delivery.outcome
                    }
                    tone={
                      delivery.outcome === 'started'
                        ? 'positive'
                        : delivery.outcome === 'failed' ||
                            delivery.outcome === 'refused'
                          ? 'negative'
                          : delivery.outcome === 'suppressed'
                            ? 'caution'
                            : 'neutral'
                    }
                  />
                </li>
              )}
            />
          </>
        )}
      </div>
    </SettingsSection>
  );
}
