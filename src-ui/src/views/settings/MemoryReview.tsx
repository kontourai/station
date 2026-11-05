import type {
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
import { Badge } from '@kontourai/ui/react';
import { useMemo, useState } from 'react';
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

function Evidence({
  label,
  text,
  excerpt,
  observedAt,
}: {
  label: string;
  text: string;
  excerpt: string;
  observedAt: string;
}) {
  return (
    <figure className="memory-review__evidence">
      <figcaption>{label}</figcaption>
      <p className="memory-review__claim">{text}</p>
      <blockquote>“{excerpt}”</blockquote>
      <small>
        Said{' '}
        <time dateTime={observedAt}>
          {new Date(observedAt).toLocaleDateString()}
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
  note,
}: {
  item: MemoryQueueItem;
  busy: boolean;
  onOpen: () => void;
  onDecide: (outcome: MemoryDecisionOutcome, correctedValue?: string) => void;
  note: string | null;
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
          <Evidence
            label="New"
            text={item.proposed.text}
            excerpt={item.proposed.source.excerpt}
            observedAt={item.proposed.source.observedAt}
          />
          {item.current && (
            <Evidence
              label="Already remembered"
              text={item.current.text}
              excerpt={item.current.source.excerpt}
              observedAt={item.current.source.observedAt}
            />
          )}
        </div>
      )}
      {open && !decided && (
        <div className="memory-review__actions">
          <Button disabled={busy} onClick={() => onDecide('accept')}>
            Remember the new one
          </Button>
          <Button disabled={busy} onClick={() => onDecide('reject')}>
            {item.current ? 'Keep the old one' : 'Don’t remember this'}
          </Button>
          <Button disabled={busy} onClick={() => setCorrecting((v) => !v)}>
            Correct it
          </Button>
          <Button disabled={busy} onClick={() => onDecide('hold')}>
            Not sure
          </Button>
        </div>
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
      {note && (
        <p className="memory-review__note" role="status">
          {note}
        </p>
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
  const [notes, setNotes] = useState<Record<string, string>>({});
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
        requestKey: crypto.randomUUID(),
      });
    },
    {
      onSuccess: (result) =>
        setNotes((current) => ({
          ...current,
          [result.itemId]: result.promoted
            ? 'Saved.'
            : result.reviewerKind === 'agent'
              ? 'Noted, but only you at this Station can settle it. It is still waiting.'
              : 'Saved. It stays open until you decide.',
        })),
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
      <h3>Review memory</h3>
      {support.data === 'unsupported' && (
        <Empty
          label="This Station can’t review memory yet"
          description="Update Station, then come back."
        />
      )}
      {supported && (
        <>
          <h4>Waiting for you</h4>
          {queue.isFetching && !queue.data && <SkeletonList count={2} />}
          {refused && (
            <Empty
              label="No private memory yet"
              description="Memory you collect shows up here for review."
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
                  note={notes[item.itemId] ?? null}
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
              {queue.data.recallableWithoutReview} other{' '}
              {queue.data.recallableWithoutReview === 1
                ? 'memory is'
                : 'memories are'}{' '}
              ready to use without review.
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
                    note={null}
                    onOpen={() => undefined}
                    onDecide={() => undefined}
                  />
                ))}
              </ul>
            </details>
          )}

          <h4>Look something up</h4>
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
                    <p className="memory-review__claim">{entry.text}</p>
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
                          <dd key={other.claimId}>{other.text}</dd>
                        ))}
                      </>
                    )}
                  </dl>
                  {entry.review.label === 'unreviewed' &&
                    entry.review.routing === 'uncontested' && (
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
                  {notes[entry.itemId] && (
                    <p className="memory-review__note" role="status">
                      {notes[entry.itemId]}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {recall.data && recall.data.notes.length > 0 && (
            <p className="memory-review__count">
              Also found {recall.data.notes.length} unstructured{' '}
              {recall.data.notes.length === 1 ? 'note' : 'notes'}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
