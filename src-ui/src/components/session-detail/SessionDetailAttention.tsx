import type { AttentionItem } from '@kontourai/station-sdk';
import {
  attentionKindLabel,
  isPeerHostedAttentionItem,
  peerAttentionElsewhereText,
} from '../../utils/attention';
import { AttentionCard } from '../attention/AttentionCard';
import { Button } from '../Button';
import { ErrorState } from '../state';

/**
 * The "Needs your attention" section — either the fetch-failure retry
 * state, or every still-live `AttentionItem` for this session (after the
 * caller's own duplicate-suppression against the live in-turn request; see
 * `isDuplicateOfPendingRequest` in `useMutableSessionDetailState`). Split
 * out of `MutableSessionDetail` per archive#1204.
 */
export function SessionDetailAttention({
  checkFailed,
  errorMessage,
  onRetry,
  items,
  answerHere = true,
}: {
  checkFailed: boolean;
  errorMessage: string;
  onRetry: () => void;
  items: AttentionItem[];
  /**
   * False for a paired-Station (peer) record: the item's inline reply and
   * actions address the LOCAL thread id, which names nothing here, so the
   * reason is shown and the answering is left to the Station that owns it.
   */
  answerHere?: boolean;
}) {
  if (checkFailed) {
    return (
      <ErrorState
        className="sessions-detail__attention-error"
        variant="compact"
        title="Couldn't check whether this session needs attention"
        description={errorMessage}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    );
  }

  if (items.length === 0) return null;

  return (
    <section
      className="sessions-detail__attention"
      data-testid="session-attention"
      aria-label="Needs your attention"
    >
      <p className="sessions-detail__eyebrow">Needs your attention</p>
      {/* A peer-marked item carries its own paired-Station handling inside
          AttentionCard (a forwarded decision, or the note): never a local
          reply. Unmarked items on a peer record (an older server) keep the
          plain note. */}
      {answerHere
        ? items.map((item) => <AttentionCard key={item.id} item={item} />)
        : items.map((item) =>
            isPeerHostedAttentionItem(item) ? (
              <AttentionCard key={item.id} item={item} />
            ) : (
              <article
                key={item.id}
                className="attention-item"
                data-testid="attention-item-elsewhere"
              >
                <div className="attention-item__type">
                  {attentionKindLabel(item.kind)}
                </div>
                <div className="attention-item__message">{item.title}</div>
                <div className="attention-item__detail">
                  {peerAttentionElsewhereText()}
                </div>
              </article>
            ),
          )}
    </section>
  );
}
