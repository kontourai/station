import { PAIRING_SCOPE_ORCHESTRATION_OPERATE } from '@kontourai/station-contracts/environment-security';
import {
  useChildWorkInstructionsQuery,
  useSteerChildWorkMutation,
} from '@kontourai/station-sdk';
import { del, get, set } from 'idb-keyval';
import { useEffect, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { Button } from '../Button';
import { ErrorState } from '../state';
import { useUIBlockActions } from './UIBlockActionsContext';
import './ChildWorkInstructionPanel.css';

type Pending = {
  threadId: string;
  childId: string;
  turnId: string;
  input: string;
  clientInputId: string;
};

export function ChildWorkInstructionPanel({
  threadId,
  childId,
  turnId,
  running,
  name,
  historyAvailable,
}: {
  threadId: string;
  childId: string;
  turnId?: string;
  running: boolean;
  name: string;
  historyAvailable: boolean;
}) {
  const authority = useAuthorityPersistence();
  const scope = useHostRequestAuthorityScope();
  const mayContinue = useUIBlockActions().canSendChildInstruction === true;
  const grant = authority.observation?.grant;
  const canOperate =
    grant?.kind === 'operator' ||
    (grant?.kind === 'device' &&
      grant.grantedScopes.includes(PAIRING_SCOPE_ORCHESTRATION_OPERATE));
  const key = authority.namespace
    ? `child-steer:${JSON.stringify([authority.namespace, threadId, childId])}`
    : null;
  const history = useChildWorkInstructionsQuery(
    {
      threadId,
      childId,
      enabled: !!scope && !!authority.namespace && historyAvailable,
      requestScope: scope,
      running,
    },
    scope?.apiBase,
  );
  const send = useSteerChildWorkMutation(scope?.apiBase, scope);
  const [text, setText] = useState('');
  const [draftTurnId, setDraftTurnId] = useState<string | undefined>();
  const [pending, setPending] = useState<Pending | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
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
    void del(key).then(() => {
      if (!active) return;
      setPending(null);
      if (entry.delivery === 'refused') {
        setText(pending.input);
        setDraftTurnId(pending.turnId);
        setMessage('The instruction was not sent.');
      } else {
        setText('');
        setDraftTurnId(undefined);
        setMessage('Sent to the subagent.');
      }
    });
    return () => {
      active = false;
    };
  }, [key, pending, history.data]);
  const submit = async (retry: boolean) => {
    if (
      busy.current ||
      !key ||
      !scope?.isCurrent() ||
      !canOperate ||
      !mayContinue ||
      (!retry && (!running || !turnId))
    )
      return;
    let saved: Pending | null = pending;
    if (!retry) {
      if (!turnId) return;
      saved = {
        threadId,
        childId,
        turnId,
        input: text.trim(),
        clientInputId: crypto.randomUUID(),
      };
    }
    if (!saved?.input) return;
    if (!retry && draftTurnId !== turnId) {
      setMessage('The subagent turn changed. This instruction was not sent.');
      return;
    }
    if (
      saved.threadId !== threadId ||
      saved.childId !== childId ||
      (!retry && saved.turnId !== turnId)
    ) {
      setMessage('The subagent turn changed. This instruction was not sent.');
      return;
    }
    busy.current = true;
    try {
      if (!retry) {
        try {
          await set(key, saved);
        } catch {
          setMessage('Could not save the instruction. It was not sent.');
          return;
        }
        setPending(saved);
      }
      if (!scope.isCurrent()) {
        setMessage('The connection changed. Your instruction is saved.');
        return;
      }
      const current = target.current;
      if (
        (!retry && !current.running) ||
        !current.mayContinue ||
        !current.canOperate ||
        current.threadId !== saved.threadId ||
        current.childId !== saved.childId ||
        (!retry && current.turnId !== saved.turnId)
      ) {
        setMessage(
          'The subagent or your access changed. Your instruction is saved.',
        );
        return;
      }
      const result = await send.mutateAsync(saved);
      await history.refetch();
      if (result.outcome === 'steered') {
        await del(key);
        setPending(null);
        setText('');
        setDraftTurnId(undefined);
        setMessage('Sent to the subagent.');
      } else if (result.outcome === 'indeterminate')
        setMessage(
          'Delivery could not be confirmed. Check again with the same instruction.',
        );
      else {
        await del(key);
        setPending(null);
        setText(saved.input);
        setDraftTurnId(saved.turnId);
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
      setMessage(
        'Delivery could not be confirmed. Check again with the same instruction.',
      );
    } finally {
      busy.current = false;
    }
  };
  const entries = history.data?.pages.flatMap((page) => page.entries) ?? [];
  return (
    <section className="child-instructions" aria-label="Subagent instructions">
      <h4>Station instructions to {name}</h4>
      {!historyAvailable && (
        <p>Instruction history is unavailable for this subagent.</p>
      )}
      {historyAvailable &&
        scope &&
        authority.namespace &&
        history.isPending && <p>Loading instructions…</p>}
      {history.isError && (
        <ErrorState
          variant="compact"
          title="Could not load instructions"
          description={
            history.error instanceof Error ? history.error.message : undefined
          }
          action={
            <Button
              size="sm"
              className="tap-target"
              onClick={() => void history.refetch()}
            >
              Try again
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
                {entry.clientOrigin?.reported.surface ?? 'Source not recorded'}{' '}
                ·{' '}
                {entry.delivery === 'delivered'
                  ? 'Sent'
                  : entry.delivery === 'refused'
                    ? 'Not sent'
                    : 'Delivery unconfirmed'}
              </small>
            </li>
          ))}
        </ol>
      )}
      {historyAvailable && history.isSuccess && entries.length === 0 && (
        <p>No instructions sent yet.</p>
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
      {pending && <p>Saved instruction: {pending.input}</p>}
      {pending && canOperate && mayContinue && key && loaded ? (
        <Button
          className="tap-target"
          pending={send.isPending}
          onClick={() => void submit(true)}
        >
          Check saved instruction
        </Button>
      ) : !running ? (
        <p>This subagent has finished.</p>
      ) : !turnId ? (
        <p>This subagent cannot receive instructions.</p>
      ) : !canOperate || !mayContinue ? (
        <p>You cannot send to this subagent.</p>
      ) : !key || !loaded ? (
        <p>Preparing instructions…</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(false);
          }}
        >
          <label>
            Send to {name}
            <textarea
              className="editor-textarea"
              rows={3}
              value={text}
              onChange={(event) => {
                if (!text && event.target.value) setDraftTurnId(turnId);
                setText(event.target.value);
              }}
              maxLength={200000}
            />
          </label>
          <Button
            type="submit"
            className="tap-target"
            disabled={
              !text.trim() ||
              history.isError ||
              !historyAvailable ||
              !history.isSuccess
            }
            pending={send.isPending}
          >
            Send
          </Button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
