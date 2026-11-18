import type { CustomAppearanceProposalReference } from '@kontourai/station-contracts/custom-appearance';
import { useCustomAppearanceQuery } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, useSyncExternalStore } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAppearanceStudioEnabled } from '../../hooks/useAppearanceStudioEnabled';
import {
  getCustomAppearanceSnapshot,
  subscribeCustomAppearance,
} from '../../lib/custom-appearance/controller';
import {
  dismissAppearanceProposal,
  previewAppearanceProposal,
} from '../../lib/custom-appearance/proposal-actions';
import { describeStationFailure } from '../../utils/stationFailure';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { StatusSummary } from '../StatusSummary';
import { ErrorState, SkeletonBlock } from '../state';
import './AppearanceProposalCard.css';

export function AppearanceProposalCard({
  proposal,
  sessionId,
}: {
  proposal: CustomAppearanceProposalReference;
  sessionId?: string;
}) {
  const connection = useOptionalConversationConnection();
  const hostScope = useHostRequestAuthorityScope();
  const scope = connection?.requestScope;
  const localPainter =
    !!connection &&
    !!scope &&
    !!hostScope &&
    connection.apiBase === hostScope.apiBase &&
    scope.apiBase === hostScope.apiBase &&
    scope.authorityKey === hostScope.authorityKey &&
    (!connection.station || connection.station.routeKind === 'host');
  const enabled = useAppearanceStudioEnabled(localPainter ? scope : undefined);
  const query = useCustomAppearanceQuery(enabled ? scope : undefined, {
    refetchInterval: 5000,
  });
  const client = useQueryClient();
  const snapshot = useSyncExternalStore(
    subscribeCustomAppearance,
    getCustomAppearanceSnapshot,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [settled, setSettled] = useState<'Kept' | 'Dismissed'>();
  const sameHost =
    !!scope &&
    !!hostScope &&
    scope.authorityKey === hostScope.authorityKey &&
    scope.apiBase === hostScope.apiBase;
  const current =
    !!scope?.isCurrent() &&
    !!hostScope?.isCurrent() &&
    (!connection?.station || connection.station.isCurrent());
  const canWrite = !connection?.record?.readOnly && current && sameHost;
  const currentRef = useRef(false);
  currentRef.current = enabled && canWrite;
  const matchesSession = !!sessionId && proposal.sourceSessionId === sessionId;
  const live = query.data?.proposal;
  const matches =
    live?.id === proposal.id &&
    live?.sourceSessionId === sessionId &&
    matchesSession;
  const outdated = !!query.data && !matches;
  const available =
    enabled &&
    canWrite &&
    matches &&
    !pending &&
    !snapshot.safe &&
    !snapshot.previewing &&
    !query.isError;
  const status =
    settled ?? (outdated ? (live ? 'Superseded' : 'Settled') : 'Proposed');
  const target = scope
    ? {
        scope,
        client,
        proposalId: proposal.id,
        sourceSessionId: sessionId,
        isCurrent: () =>
          currentRef.current && scope.isCurrent() && !!hostScope?.isCurrent(),
        onError: (failure: unknown) =>
          setError(describeStationFailure(failure, connection?.station).body),
        onSettled: setSettled,
      }
    : undefined;
  async function act(action: 'preview' | 'dismiss') {
    if (!available || !target) return;
    setError(undefined);
    setPending(true);
    try {
      if (action === 'preview') await previewAppearanceProposal(target);
      else await dismissAppearanceProposal(target);
    } catch (failure) {
      target.onError(failure);
    } finally {
      setPending(false);
    }
  }
  const shown = matches && live ? live.appearance : undefined;
  const swatches = [
    ...new Set(
      Object.values(shown?.palette ?? {})
        .flatMap((palette) => [
          palette.accent,
          ...Object.values(palette.roles ?? {}),
        ])
        .filter((value): value is string => !!value),
    ),
  ].slice(0, 8);
  if (connection && !localPainter)
    return (
      <section
        className="appearance-proposal content-stack"
        aria-label="Appearance proposal"
      >
        <StatusSummary
          title={proposal.name}
          badge={{ label: 'Proposed', tone: 'neutral' }}
        />
        <p>Switch to this Station to preview its appearance.</p>
      </section>
    );
  if (!enabled) return null;
  return (
    <section
      className="appearance-proposal content-stack"
      aria-label="Appearance proposal"
    >
      <StatusSummary
        title={shown?.name ?? proposal.name}
        badge={{ label: status, tone: 'neutral' }}
      />
      <p>Appearance proposed by your agent</p>
      <div className="appearance-proposal__visual">
        {shown?.visual?.background && (
          <img
            className="appearance-proposal__image"
            src={shown?.visual.background.dataUrl}
            alt="Proposed background"
          />
        )}
        {swatches.length > 0 && (
          <div className="appearance-proposal__swatches">
            {swatches.map((color) => (
              <span
                key={color}
                className="appearance-proposal__swatch"
                style={{ backgroundColor: color }}
                role="img"
                aria-label={color}
              />
            ))}
          </div>
        )}
        <p>
          {shown?.visual?.background
            ? 'Background image'
            : shown
              ? 'Custom palette'
              : 'Appearance proposal'}
          {shown?.css ? ' · Custom CSS' : ''}
        </p>
      </div>
      {!sameHost ? (
        <p>Switch to this Station to preview its appearance.</p>
      ) : !matchesSession ? (
        <p>This proposal belongs to another chat.</p>
      ) : !current ? (
        <p>Reconnect to this Station to preview.</p>
      ) : connection?.record?.readOnly ? (
        <p>Open this chat to preview its appearance.</p>
      ) : null}
      {query.isPending && (
        <SkeletonBlock label="Checking appearance proposal" count={1} />
      )}
      {(error || query.isError) && (
        <ErrorState
          variant="compact"
          title="Appearance proposal could not be updated"
          description={error}
          action={
            <Button
              onClick={() => {
                setError(undefined);
                void query.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      )}
      <ActionRow
        overflowLabel="More appearance proposal actions"
        primary={
          <Button
            variant="primary"
            disabled={!available || !!settled}
            pending={pending}
            onClick={() => void act('preview')}
          >
            Preview
          </Button>
        }
        secondary={
          <Button
            disabled={!available || !!settled}
            onClick={() => void act('dismiss')}
          >
            Dismiss
          </Button>
        }
      />
    </section>
  );
}
