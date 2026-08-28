import type {
  AnswerShareState,
  AnswerShareSummary,
} from '@kontourai/station-contracts/answer-share';
import {
  useAnswerSharesQuery,
  useRevokeAnswerShareMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { Empty, ErrorState, Skeleton } from '../../components/state';
import { errorText } from '../../utils/errorText';
import './AnswerSharesSection.css';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

/**
 * Shared answers (archive#1423) — the operator's own list of the answer
 * permalinks they have minted, and the place they turn one off.
 *
 * Modelled on `PairedDevicesPanel`/`PairedDeviceList`, which is the repo's
 * existing surface for "credentials I granted, and how I take them back":
 * an inline two-click confirm rather than a native dialog, a busy set so a
 * revoke in flight disables its own row, and revoked entries kept visible in
 * their own group instead of vanishing.
 *
 * The list never shows a token. The server keeps only a digest, so there is
 * nothing to show and nothing to recover — a lost permalink is re-minted from
 * the answer itself.
 */

/**
 * State copy. Every member of the union gets a sentence, and none of them is
 * a bare status word: "Expired" alone leaves the reader to guess whether the
 * link still resolves, which is precisely the ambiguity the honest-state
 * requirement removes.
 */
const STATE_LABEL: Record<AnswerShareState, string> = {
  active: 'Live — anyone with the link can read this answer',
  revoked: 'Revoked — the link now says so and shows nothing',
  expired: 'Expired — the link now says so and shows nothing',
};

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  // An unparseable timestamp is named as one rather than rendered as an
  // epoch date; a wrong date on a capability record is a claim.
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleDateString()
    : 'date not recorded';
}

function ShareRow({
  share,
  onRevoke,
  busy,
}: {
  share: AnswerShareSummary;
  onRevoke: (share: AnswerShareSummary) => void;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="answer-shares__row">
      <div className="answer-shares__body">
        <div className="answer-shares__name">
          {share.label ?? `Answer from turn ${share.turnId}`}
        </div>
        <div className="answer-shares__meta">{STATE_LABEL[share.state]}</div>
        <div className="answer-shares__meta">
          Created {formatDate(share.createdAt)} · expires{' '}
          {formatDate(share.expiresAt)}
          {share.revokedAt ? ` · revoked ${formatDate(share.revokedAt)}` : ''}
        </div>
      </div>
      {share.state !== 'revoked' && (
        <div className="answer-shares__actions">
          {confirming ? (
            <>
              <button
                type="button"
                className="button button--danger"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  onRevoke(share);
                }}
              >
                Confirm
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button"
              disabled={busy}
              aria-label={`Revoke share of turn ${share.turnId}`}
              onClick={() => setConfirming(true)}
            >
              Revoke
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function AnswerSharesSection() {
  const shares = useAnswerSharesQuery();
  const revoke = useRevokeAnswerShareMutation();
  const [busyId, setBusyId] = useState<string | null>(null);

  return (
    <SettingsSection icon="⚯" title="Shared answers" id="section-answer-shares">
      <div {...settingsRow('shared-answers')} tabIndex={-1}>
        <p className="answer-shares__intro">
          Answer permalinks you have created. Each one is a link to a single
          answer and its provenance card; revoking one ends its access
          immediately, and the link then says it was revoked rather than
          pretending it never existed.
        </p>

        {shares.isLoading && <Skeleton variant="line" />}

        {shares.isError && (
          <ErrorState
            variant="compact"
            title="Shared answers could not be listed"
            description={errorText(shares.error)}
            action={
              <button
                type="button"
                className="button"
                onClick={() => shares.refetch()}
              >
                Retry
              </button>
            }
          />
        )}

        {revoke.isError && (
          <ErrorState
            variant="compact"
            title="This share could not be revoked"
            description={errorText(revoke.error)}
          />
        )}

        {shares.data?.length === 0 && (
          <Empty
            variant="compact"
            label="Nothing shared yet"
            description="Use “Share answer” beneath any answer in a chat to create a link."
          />
        )}

        {shares.data?.map((share) => (
          <ShareRow
            key={share.id}
            share={share}
            busy={busyId === share.id}
            onRevoke={(target) => {
              setBusyId(target.id);
              revoke.mutate(target.id, {
                onSettled: () => setBusyId(null),
              });
            }}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
