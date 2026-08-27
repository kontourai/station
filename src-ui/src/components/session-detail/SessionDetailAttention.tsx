import type { AttentionItem } from '@kontourai/station-sdk';
import { AttentionCard } from '../attention/AttentionCard';
import { Button } from '../Button';
import { ErrorState } from '../state';

/**
 * The "Needs your attention" section — either the fetch-failure retry
 * state, or every still-live `AttentionItem` for this session (after the
 * caller's own duplicate-suppression against the live in-turn request; see
 * `isDuplicateOfPendingRequest` in `useMutableSessionDetailState`). Split
 * out of `MutableSessionDetail` per station#1204.
 */
export function SessionDetailAttention({
  checkFailed,
  errorMessage,
  onRetry,
  items,
}: {
  checkFailed: boolean;
  errorMessage: string;
  onRetry: () => void;
  items: AttentionItem[];
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
      {items.map((item) => (
        <AttentionCard key={item.id} item={item} />
      ))}
    </section>
  );
}
