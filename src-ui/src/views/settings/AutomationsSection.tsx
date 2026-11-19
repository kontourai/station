import type {
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

function EpisodeRow({
  episode,
  rules,
}: {
  episode: AutomationEpisodeRecord;
  rules: readonly AutomationRule[] | undefined;
}) {
  const retry = useRetryAutomationEpisode();
  const ruleName =
    rules?.find((rule) => rule.id === episode.ruleId)?.name ?? episode.ruleId;
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
      {episode.state === 'exhausted' ? (
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
                  </span>
                  <StatusBadge
                    status={rule.mode}
                    tone={rule.mode === 'live' ? 'positive' : 'neutral'}
                  />
                </li>
              )}
            />
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
