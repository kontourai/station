import type {
  MemoryClaimView,
  MemoryDecisionOutcome,
  MemoryQueueItem,
  MemoryRecallEntry,
} from '@kontourai/station-contracts/knowledge-memory';
import {
  createPrivateMemoryClient,
  PrivateMemoryRequestError,
  privateMemoryHostSupport,
  useApiMutation,
  useApiQuery,
  useFeaturePreviewsQuery,
} from '@kontourai/station-sdk';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { Badge } from '@kontourai/ui/react';
import { useMemo, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import './MemoryReview.css';

const LABEL: Record<
  MemoryRecallEntry['review']['label'],
  { text: string; tone: 'positive' | 'caution' | 'neutral' | 'active' }
> = {
  confirmed: { text: 'Confirmed', tone: 'positive' },
  corrected: { text: 'Corrected', tone: 'positive' },
  'in-review': { text: 'Needs a decision', tone: 'caution' },
  unreviewed: { text: 'Not reviewed', tone: 'neutral' },
};

const DECISION_TEXT: Record<MemoryDecisionOutcome, string> = {
  accept: 'Remembered',
  correct: 'Corrected',
  reject: 'Not remembered',
  hold: 'Left open',
};

/** What a memory says, in plain words: what it is about, then the value. */
function ClaimLine({ claim }: { claim: MemoryClaimView }) {
  return (
    <p className="memory-review__claim">
      <span className="memory-review__subject">
        About {claim.subject} · {claim.property}
      </span>
      <span>{claim.value}</span>
    </p>
  );
}

function Evidence({ label, claim }: { label: string; claim: MemoryClaimView }) {
  return (
    <figure className="memory-review__evidence">
      <figcaption>{label}</figcaption>
      <ClaimLine claim={claim} />
      <blockquote>“{claim.source.excerpt}”</blockquote>
      <small>
        Said{' '}
        <time dateTime={claim.source.observedAt}>
          {new Date(claim.source.observedAt).toLocaleDateString()}
        </time>
      </small>
    </figure>
  );
}

function QueueCard({
  item,
  busy,
  onOpen,
  onDecide,
}: {
  item: MemoryQueueItem;
  busy: boolean;
  onOpen: () => void;
  onDecide: (outcome: MemoryDecisionOutcome, correctedValue?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [value, setValue] = useState('');
  const decided = item.status === 'decided';
  return (
    <li className="memory-review__card" aria-label={item.question}>
      <div className="memory-review__card-head">
        <h4>{item.question}</h4>
        {decided && item.decision ? (
          <Badge
            value={DECISION_TEXT[item.decision.outcome]}
            tone={item.decision.outcome === 'reject' ? 'neutral' : 'positive'}
          />
        ) : item.decision?.outcome === 'hold' ? (
          <Badge value="Left open" tone="neutral" />
        ) : (
          <Badge value="Needs a decision" tone="caution" />
        )}
      </div>
      <ul className="memory-review__reasons">
        {item.reasons.map((reason) => (
          <li key={reason.rule}>{reason.plain}</li>
        ))}
      </ul>
      {!open && !decided && (
        <Button
          onClick={() => {
            setOpen(true);
            onOpen();
          }}
        >
          Review
        </Button>
      )}
      {(open || decided) && (
        <div className="memory-review__compare">
          <Evidence label="New" claim={item.proposed} />
          {item.current && (
            <Evidence label="Already remembered" claim={item.current} />
          )}
        </div>
      )}
      {open && !decided && (
        <ActionRow
          className="memory-review__choices"
          label="Decide"
          overflowLabel="More ways to decide"
          primary={
            <Button disabled={busy} onClick={() => onDecide('accept')}>
              Remember the new one
            </Button>
          }
          secondary={
            <Button disabled={busy} onClick={() => onDecide('reject')}>
              {item.current ? 'Keep the old one' : 'Don’t remember this'}
            </Button>
          }
          overflow={[
            {
              key: 'correct',
              label: 'Correct it',
              disabled: busy,
              onSelect: () => setCorrecting((value) => !value),
            },
            {
              key: 'hold',
              label: 'Not sure',
              disabled: busy,
              onSelect: () => onDecide('hold'),
            },
          ]}
        />
      )}
      {open && !decided && correcting && (
        <form
          className="memory-review__correct"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) onDecide('correct', value.trim());
          }}
        >
          <label>
            What is right?
            <input
              className="editor-input"
              value={value}
              maxLength={2000}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={busy || !value.trim()}>
            Save correction
          </Button>
        </form>
      )}
    </li>
  );
}

export function MemoryReview() {
  const scope = useHostRequestAuthorityScope();
  const previews = useFeaturePreviewsQuery();
  const enabled = Boolean(
    previews.data?.some((item) => item.id === 'private-memory' && item.enabled),
  );
  const client = useMemo(
    () =>
      scope
        ? createPrivateMemoryClient({
            apiBase: scope.apiBase,
            requestScope: scope,
          })
        : null,
    [scope],
  );
  const scopeKey = [scope?.apiBase ?? null, scope?.authorityKey ?? null];
  const active = Boolean(enabled && scope && client);
  const support = useApiQuery(
    ['memory', 'support', ...scopeKey],
    () => privateMemoryHostSupport(scope?.apiBase ?? ''),
    { enabled: active, retry: false },
  );
  const supported = active && support.data !== 'unsupported';
  const queue = useApiQuery(
    ['memory', 'queue', ...scopeKey],
    (signal) => {
      if (!client || !scope?.isCurrent()) throw new Error('unavailable');
      return client.queue(signal);
    },
    {
      enabled: supported && support.isSuccess,
      retry: false,
      staleTime: 0,
      cancelWhenInactive: true,
    },
  );
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const recall = useApiQuery(
    ['memory', 'recall', ...scopeKey, submitted],
    (signal) => {
      if (!client || !scope?.isCurrent() || submitted === null)
        throw new Error('unavailable');
      return client.recall(submitted, 25, signal);
    },
    {
      enabled: supported && support.isSuccess && submitted !== null,
      retry: false,
      staleTime: 0,
      cancelWhenInactive: true,
    },
  );
  const [lastNote, setLastNote] = useState<string | null>(null);
  const decide = useApiMutation(
    async (variables: {
      itemId: string;
      outcome: MemoryDecisionOutcome;
      correctedValue?: string;
    }) => {
      if (!client || !scope?.isCurrent()) throw new Error('unavailable');
      return client.decide(variables.itemId, {
        outcome: variables.outcome,
        ...(variables.correctedValue
          ? { correctedValue: variables.correctedValue }
          : {}),
        requestKey: randomCorrelationId(),
      });
    },
    {
      onSuccess: (result) => {
        // "Not sure" already shows its own badge, so it needs no message.
        const message = result.promoted
          ? 'Saved.'
          : result.reviewerKind === 'agent'
            ? 'Saved as a note. Decide this directly on your Station to change your memory.'
            : null;
        setLastNote(message);
      },
      invalidateKeys: [['memory']],
    },
  );
  if (!scope || !enabled || !scope.isCurrent()) return null;
  const refused =
    queue.error instanceof PrivateMemoryRequestError &&
    queue.error.failure === 'not-available';
  const pending = queue.data?.items.filter((item) => item.status === 'pending');
  const decidedItems = queue.data?.items.filter(
    (item) => item.status === 'decided',
  );
  return (
    <section aria-label="Review memory" className="memory-review">
      <h3>Your saved memories</h3>
      {support.data === 'unsupported' && (
        <Empty
          label="This Station can’t review memory yet"
          description="Update Station, then come back."
        />
      )}
      {supported && (
        <>
          <h4>Check these</h4>
          {lastNote && (
            <p className="memory-review__note" role="status">
              {lastNote}
            </p>
          )}
          {queue.isFetching && !queue.data && <SkeletonList count={2} />}
          {refused && (
            <Empty
              label="Nothing saved yet"
              description="Memory your agents save shows up here."
            />
          )}
          {queue.isError && !refused && (
            <ErrorState
              title="Couldn’t load the queue"
              action={
                <Button onClick={() => void queue.refetch()}>Retry</Button>
              }
            />
          )}
          {queue.data && pending?.length === 0 && (
            <Empty label="Nothing is waiting for you" />
          )}
          {pending && pending.length > 0 && (
            <ul className="memory-review__list">
              {pending.map((item) => (
                <QueueCard
                  key={item.itemId}
                  item={item}
                  busy={decide.isPending}
                  onOpen={() => {
                    void client?.open(item.itemId).catch(() => undefined);
                  }}
                  onDecide={(outcome, correctedValue) =>
                    decide.mutate({
                      itemId: item.itemId,
                      outcome,
                      ...(correctedValue ? { correctedValue } : {}),
                    })
                  }
                />
              ))}
            </ul>
          )}
          {decide.isError && (
            <ErrorState
              variant="compact"
              title="Couldn’t save that decision"
              action={<Button onClick={() => decide.reset()}>Dismiss</Button>}
            />
          )}
          {queue.data && (
            <p className="memory-review__count">
              {queue.data.recallableWithoutReview === 1
                ? '1 more memory didn’t need checking. Confirm it in search to add it to new chats.'
                : `${queue.data.recallableWithoutReview} more memories didn’t need checking. Confirm them in search to add them to new chats.`}
            </p>
          )}
          {decidedItems && decidedItems.length > 0 && (
            <details className="memory-review__decided">
              <summary>Decided ({decidedItems.length})</summary>
              <ul className="memory-review__list">
                {decidedItems.map((item) => (
                  <QueueCard
                    key={item.itemId}
                    item={item}
                    busy
                    onOpen={() => undefined}
                    onDecide={() => undefined}
                  />
                ))}
              </ul>
            </details>
          )}

          <h4>Search your memory</h4>
          <form
            className="memory-review__search"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(search.trim());
            }}
          >
            <label>
              What do you want to find?
              <input
                className="editor-input"
                value={search}
                maxLength={200}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <Button type="submit">Search</Button>
          </form>
          {recall.isFetching && <SkeletonList count={2} />}
          {recall.isError && (
            <ErrorState
              title="Couldn’t search memory"
              action={
                <Button onClick={() => void recall.refetch()}>Retry</Button>
              }
            />
          )}
          {recall.data && recall.data.entries.length === 0 && (
            <Empty label="Nothing matches that" />
          )}
          {recall.data && recall.data.entries.length > 0 && (
            <ul className="memory-review__list">
              {recall.data.entries.map((entry) => (
                <li key={entry.claimId} className="memory-review__card">
                  <div className="memory-review__card-head">
                    <ClaimLine claim={entry} />
                    <Badge
                      value={LABEL[entry.review.label].text}
                      tone={LABEL[entry.review.label].tone}
                    />
                  </div>
                  <blockquote>“{entry.source.excerpt}”</blockquote>
                  <dl className="memory-review__history">
                    {entry.replaces.length > 0 && (
                      <>
                        <dt>Replaces</dt>
                        {entry.replaces.map((other) => (
                          <dd key={other.claimId}>{other.text}</dd>
                        ))}
                      </>
                    )}
                    {entry.replacedBy.length > 0 && (
                      <>
                        <dt>Replaced by</dt>
                        {entry.replacedBy.map((other) => (
                          <dd key={other.claimId}>{other.text}</dd>
                        ))}
                      </>
                    )}
                    {entry.conflictsWith.length > 0 && (
                      <>
                        <dt>Disagrees with</dt>
                        {entry.conflictsWith.map((other) => (
                          <dd key={other.claimId}>
                            {other.text}
                            {(other.label === 'confirmed' ||
                              other.label === 'corrected') &&
                              ' (you confirmed this one)'}
                          </dd>
                        ))}
                      </>
                    )}
                  </dl>
                  {entry.review.label === 'unreviewed' &&
                    entry.review.routing === 'uncontested' &&
                    !entry.conflictsWith.some(
                      (other) =>
                        other.label === 'confirmed' ||
                        other.label === 'corrected',
                    ) && (
                      <Button
                        disabled={decide.isPending}
                        onClick={() =>
                          decide.mutate({
                            itemId: entry.itemId,
                            outcome: 'accept',
                          })
                        }
                      >
                        Confirm
                      </Button>
                    )}
                </li>
              ))}
            </ul>
          )}
          {recall.data && recall.data.notes.length > 0 && (
            <p className="memory-review__count">
              {recall.data.notes.length === 1
                ? '1 more saved item matched but isn’t a memory, so it isn’t shown.'
                : `${recall.data.notes.length} more saved items matched but aren’t memories, so they aren’t shown.`}
            </p>
          )}
        </>
      )}
    </section>
  );
}
