import { PAIRING_SCOPE_ORCHESTRATION_OPERATE } from '@kontourai/station-contracts/environment-security';
import {
  useChildWorkInstructionsQuery,
  useSteerChildWorkMutation,
} from '@kontourai/station-sdk';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { get, update } from 'idb-keyval';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { describeStationFailure } from '../../utils/stationFailure';
import { Button } from '../Button';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { recordedDeliveryPort } from '../conversation/DeliveryPort';
import { LazyBoundary } from '../LazyBoundary';
import { Empty, ErrorState, SkeletonBlock } from '../state';

const loadInstructionForm = () =>
  import('./ChatInputArea').then((module) => ({
    default: module.ChildInstructionForm,
  }));

import { MessageDeliveryNote } from './message-bubble/MessageDeliveryNote';
import { useUIBlockActions } from './UIBlockActionsContext';
import './ChildWorkInstructionPanel.css';

type Pending = {
  threadId: string;
  childId: string;
  turnId: string;
  input: string;
  clientInputId: string;
};

async function clearInstruction(key: string, expected: Pending) {
  await update<Pending | null>(key, (current) =>
    current?.clientInputId === expected.clientInputId &&
    current.threadId === expected.threadId &&
    current.childId === expected.childId &&
    current.turnId === expected.turnId &&
    current.input === expected.input
      ? null
      : (current ?? null),
  );
}

export type ChildInstructionDrafts = Map<
  string,
  { text: string; turnId?: string }
>;

export function ChildWorkInstructionPanel({
  threadId,
  childId,
  turnId,
  running,
  name,
  historyAvailable,
  composer,
}: {
  composer?: {
    identity: string;
    canContinue: boolean;
    drafts?: ChildInstructionDrafts;
  };
  threadId: string;
  childId: string;
  turnId?: string;
  running: boolean;
  name: string;
  historyAvailable: boolean;
}) {
  const editorId = useId();
  const authority = useAuthorityPersistence();
  const host = useHostRequestAuthorityScope();
  const targetScope = useOptionalConversationConnection();
  const scope = targetScope?.requestScope ?? host;
  const apiBase = targetScope?.apiBase ?? scope?.apiBase;
  const cardActions = useUIBlockActions();
  const mayContinue = composer
    ? composer.canContinue
    : cardActions.canSendChildInstruction === true;
  const grant = authority.observation?.grant;
  const canOperate = targetScope?.station
    ? targetScope.station.isCurrent() &&
      targetScope.station.capabilities.childInstruction.state === 'allowed'
    : grant?.kind === 'operator' ||
      (grant?.kind === 'device' &&
        grant.grantedScopes.includes(PAIRING_SCOPE_ORCHESTRATION_OPERATE));
  const namespace = targetScope?.station?.stationKey ?? authority.namespace;
  const key = namespace
    ? `child-steer:${JSON.stringify([namespace, threadId, childId])}`
    : null;
  const history = useChildWorkInstructionsQuery(
    {
      threadId,
      childId,
      enabled: !!scope && !!namespace && historyAvailable,
      requestScope: scope,
      running,
    },
    apiBase,
  );
  const send = useSteerChildWorkMutation(apiBase, scope);
  const drafts = composer?.drafts;
  const [draft, setDraft] = useState(
    () =>
      (key && drafts?.get(key)) || {
        text: '',
        turnId: undefined as string | undefined,
      },
  );
  const { text, turnId: draftTurnId } = draft;
  const writeDraft = useCallback(
    (value: string, boundTurn?: string) => {
      const next = { text: value, turnId: boundTurn };
      if (key && drafts) {
        if (value) drafts.set(key, next);
        else drafts.delete(key);
      }
      setDraft(next);
    },
    [key, drafts],
  );
  const [pending, setPending] = useState<Pending | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const target = useRef({
    threadId,
    childId,
    turnId,
    running,
    mayContinue,
    canOperate,
  });
  target.current = {
    threadId,
    childId,
    turnId,
    running,
    mayContinue,
    canOperate,
  };
  useEffect(() => {
    let active = true;
    setPending(null);
    setLoaded(false);
    if (!key) return;
    void get<Pending>(key).then(
      (value) => {
        if (active) {
          setPending(value ?? null);
          setLoaded(true);
        }
      },
      () => {
        if (active) setMessage('Could not load the pending instruction.');
      },
    );
    return () => {
      active = false;
    };
  }, [key]);
  useEffect(() => {
    if (!key || !pending || !history.data) return;
    const entry = history.data.pages
      .flatMap((page) => page.entries)
      .find(
        (item) =>
          item.clientInputId === pending.clientInputId &&
          item.childId === pending.childId &&
          item.turnId === pending.turnId &&
          item.text === pending.input,
      );
    if (!entry || entry.delivery === 'indeterminate') return;
    let active = true;
    void clearInstruction(key, pending).then(() => {
      if (!active) return;
      setPending(null);
      if (entry.delivery === 'refused') {
        writeDraft(pending.input, pending.turnId);
        setMessage('The instruction was not sent.');
      } else {
        writeDraft('', undefined);
        setMessage('Sent to the subagent.');
      }
    });
    return () => {
      active = false;
    };
  }, [key, pending, history.data, writeDraft]);
  const submit = async () => {
    if (
      busy.current ||
      pending ||
      !key ||
      !scope?.isCurrent() ||
      !canOperate ||
      !mayContinue ||
      !running ||
      !turnId ||
      !text.trim()
    )
      return;
    const saved: Pending = {
      threadId,
      childId,
      turnId,
      input: text.trim(),
      clientInputId: randomCorrelationId(),
    };
    if (draftTurnId !== turnId) {
      setMessage('The subagent turn changed. This instruction was not sent.');
      return;
    }
    busy.current = true;
    setSubmitting(true);
    try {
      try {
        let claimed = false;
        await update<Pending | null>(key, (current) => {
          if (current) return current;
          claimed = true;
          return saved;
        });
        if (!claimed) {
          setMessage('Another instruction is awaiting confirmation.');
          return;
        }
      } catch {
        setMessage('Could not save the instruction. It was not sent.');
        return;
      }
      setPending(saved);
      if (!scope.isCurrent()) {
        setMessage('The connection changed. Your instruction is saved.');
        return;
      }
      const current = target.current;
      if (
        !current.running ||
        !current.mayContinue ||
        !current.canOperate ||
        current.threadId !== saved.threadId ||
        current.childId !== saved.childId ||
        current.turnId !== saved.turnId
      ) {
        setMessage(
          'The subagent or your access changed. Your instruction is saved.',
        );
        return;
      }
      const result = await send.mutateAsync(saved);
      await history.refetch();
      if (result.outcome === 'steered') {
        await clearInstruction(key, saved);
        setPending(null);
        writeDraft('', undefined);
        setMessage('Sent to the subagent.');
      } else if (result.outcome === 'indeterminate') setMessage('');
      else {
        await clearInstruction(key, saved);
        setPending(null);
        writeDraft(saved.input, saved.turnId);
        setMessage(
          result.outcome === 'unsupported'
            ? 'This subagent cannot receive instructions.'
            : result.outcome === 'confinement-changed'
              ? 'Access changed. The instruction was not sent.'
              : result.outcome === 'not-authorized'
                ? 'You cannot send to this subagent.'
                : 'The instruction was not sent. The subagent may have finished.',
        );
      }
    } catch {
      setMessage('');
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };
  const entries = history.data?.pages.flatMap((page) => page.entries) ?? [];
  const writable =
    running &&
    !!turnId &&
    canOperate &&
    mayContinue &&
    !!key &&
    loaded &&
    !pending;
  const identity = composer && (
    <span className="child-instructions__identity">{composer.identity}</span>
  );
  const historyContent = (
    <>
      {!historyAvailable && (
        <p>Instruction history is unavailable for this subagent.</p>
      )}
      {historyAvailable && scope && namespace && history.isPending && (
        <SkeletonBlock count={1} label="Instructions" />
      )}
      {history.isError && (
        <ErrorState
          variant="compact"
          title="Could not load instructions"
          description={
            history.error
              ? describeStationFailure(history.error).body
              : undefined
          }
          action={
            <Button
              size="sm"
              className="tap-target"
              onClick={() => void history.refetch()}
            >
              Retry
            </Button>
          }
        />
      )}
      {entries.length > 0 && (
        <ol>
          {entries.map((entry) => (
            <li key={entry.clientInputId}>
              <p>{entry.text}</p>
              <small>
                {entry.principal?.display ?? 'Sender not recorded'} ·{' '}
                {entry.clientOrigin?.reported.surface ??
                  'Source not recorded'}{' '}
              </small>
              <MessageDeliveryNote
                variant="inline"
                state={
                  entry.delivery === 'delivered'
                    ? 'delivered'
                    : entry.delivery === 'refused'
                      ? 'not-sent'
                      : 'unconfirmed'
                }
                port={recordedDeliveryPort}
              />
            </li>
          ))}
        </ol>
      )}
      {historyAvailable && history.isSuccess && entries.length === 0 && (
        <Empty variant="compact" label="Nothing sent yet" />
      )}
      {history.hasNextPage && (
        <Button
          size="sm"
          pending={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          Load more instructions
        </Button>
      )}
    </>
  );
  return (
    <section
      className={
        composer
          ? 'child-instructions child-instructions--composer'
          : 'child-instructions'
      }
      aria-label="Subagent instructions"
    >
      {composer ? (
        <>
          {!writable && identity}
          {(entries.length > 0 || history.isError || history.hasNextPage) && (
            <details>
              <summary>Instruction history</summary>
              {historyContent}
            </details>
          )}
        </>
      ) : (
        <>
          <h4>Station instructions to {name}</h4>
          {historyContent}
        </>
      )}
      {composer && message && <p role="status">{message}</p>}
      {pending && <p>Saved instruction: {pending.input}</p>}
      {pending && canOperate && mayContinue && key && loaded ? (
        <MessageDeliveryNote
          variant="inline"
          state={submitting ? 'sending' : 'unconfirmed'}
          port={{
            savedOnDevice: true,
            canDiscardUnconfirmed: !submitting,
            discard: async () => {
              await clearInstruction(key, pending);
              setPending((current) =>
                current?.clientInputId === pending.clientInputId
                  ? null
                  : current,
              );
              writeDraft(pending.input, target.current.turnId);
              setMessage('');
              return null;
            },
            check: async () => {
              if (
                !scope?.isCurrent() ||
                !target.current.canOperate ||
                !target.current.mayContinue
              )
                throw new Error('The connection or your access changed.');
              const fresh = await history.refetch();
              const found = fresh.data?.pages
                .flatMap((page) => page.entries)
                .find(
                  (entry) =>
                    entry.clientInputId === pending.clientInputId &&
                    entry.childId === pending.childId &&
                    entry.turnId === pending.turnId &&
                    entry.text === pending.input,
                );
              if (
                !scope.isCurrent() ||
                target.current.threadId !== pending.threadId ||
                target.current.childId !== pending.childId
              )
                throw new Error('The instruction target changed.');
              if (found && found.delivery !== 'indeterminate') {
                await clearInstruction(key, pending);
                setPending((current) =>
                  current?.clientInputId === pending.clientInputId
                    ? null
                    : current,
                );
                if (found.delivery === 'delivered') {
                  writeDraft('', undefined);
                  setMessage('Sent to the subagent.');
                } else {
                  writeDraft(pending.input, pending.turnId);
                  setMessage('The instruction was not sent.');
                }
              }
              return found?.delivery === 'delivered'
                ? 'started'
                : found?.delivery === 'refused'
                  ? 'not-received'
                  : 'indeterminate';
            },
          }}
        />
      ) : !running ? (
        <p>This subagent has finished.</p>
      ) : !turnId ? (
        <p>This subagent cannot receive instructions.</p>
      ) : !canOperate || !mayContinue ? (
        <p>You cannot send to this subagent.</p>
      ) : !key || !loaded ? (
        <p>Preparing instructions…</p>
      ) : (
        <LazyBoundary
          load={loadInstructionForm}
          shareAcrossMounts
          pending={<SkeletonBlock count={1} label="Preparing instructions" />}
          componentProps={{
            name,
            editorId,
            identity: composer?.identity,
            text,
            onChange: (value: string) => {
              if (busy.current) return;
              writeDraft(
                value,
                value ? (text ? draftTurnId : turnId) : undefined,
              );
            },
            sending: submitting || send.isPending,
            onSubmit:
              historyAvailable && history.isSuccess && !history.isError
                ? submit
                : undefined,
          }}
        />
      )}
      {!composer && message && <p role="status">{message}</p>}
    </section>
  );
}
