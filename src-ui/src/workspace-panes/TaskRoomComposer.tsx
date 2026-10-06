import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import type {
  TaskRoomContextSnapshot,
  TaskRoomWorkInput,
} from '@kontourai/station-contracts/task-room-work';
import {
  TaskRoomWorkNotSentError,
  useAppendProjectTaskRoomHumanMessageMutation,
  useSubmitTaskRoomAgentRequestMutation,
  useTaskRoomAgentOptionsQuery,
  useTaskRoomAgentRequestsQuery,
} from '@kontourai/station-sdk/project-task-rooms';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useId, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { Empty, FilteredEmpty, SkeletonList } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import './TaskRoomComposer.css';

export function TaskRoomComposer({
  taskId,
  taskCreatedAt,
  projectSlug,
  writable,
  readable,
}: {
  taskId: string;
  taskCreatedAt: string;
  projectSlug: string;
  writable: boolean;
  readable: boolean;
}) {
  const scope = useHostRequestAuthorityScope();
  const options = useTaskRoomAgentOptionsQuery(projectSlug, scope, writable);
  const requests = useTaskRoomAgentRequestsQuery(
    taskId,
    taskCreatedAt,
    scope,
    readable,
  );
  const request = useSubmitTaskRoomAgentRequestMutation(
    taskId,
    taskCreatedAt,
    projectSlug,
    scope,
  );
  const message = useAppendProjectTaskRoomHumanMessageMutation(taskId, {
    requestScope: scope,
    taskCreatedAt,
  });
  const [draft, setDraft] = useState('');
  const [recipient, setRecipient] = useState<{ id: string; name: string }>();
  const [mention, setMention] = useState<{
    start: number;
    end: number;
    query: string;
  }>();
  const [active, setActive] = useState(0);
  const [composing, setComposing] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState<TaskRoomWorkInput>();
  const [notice, setNotice] = useState('');
  const [includeBrief, setIncludeBrief] = useState(true);
  const [brief, setBrief] = useState<TaskRoomContextSnapshot>();
  const briefSelection = useRef(0);
  const [draftOwner, setDraftOwner] = useState<string>();
  const owner = JSON.stringify([
    scope?.apiBase,
    scope?.authorityKey,
    taskId,
    taskCreatedAt,
  ]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const connectionChanged = draftOwner !== undefined && draftOwner !== owner;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const { DiscardModal } = useUnsavedGuard(
    !!draft || !!recipient || !!unconfirmed,
  );
  const pending = request.isPending || message.isPending;
  const locked = pending || !!unconfirmed || connectionChanged;
  const candidates = (options.isError ? [] : (options.data?.targets ?? []))
    .filter((target) =>
      `${target.name} ${target.id} ${target.description ?? ''}`
        .toLocaleLowerCase()
        .includes(mention?.query.toLocaleLowerCase() ?? ''),
    )
    .slice(0, 8);
  const selected = Math.min(active, Math.max(0, candidates.length - 1));
  const picker = writable && !!mention && !composing && !recipient && !locked;
  const select = (index: number) => {
    const agent = candidates[index];
    if (!agent?.ready || !mention) return;
    setDraftOwner(owner);
    briefSelection.current += 1;
    setRecipient({ id: agent.id, name: agent.name });
    setBrief(
      !requests.isError && scope?.isCurrent()
        ? (requests.data?.context ?? undefined)
        : undefined,
    );
    setDraft(draft.slice(0, mention.start) + draft.slice(mention.end));
    setMention(undefined);
    textarea.current?.focus();
  };
  const findMention = (value: string, caret: number) => {
    const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    setActive(0);
    setMention(
      match
        ? { start: caret - match[1].length - 1, end: caret, query: match[1] }
        : undefined,
    );
  };
  const submit = async () => {
    if (
      !writable ||
      pending ||
      !draft.trim() ||
      connectionChanged ||
      !scope?.isCurrent()
    )
      return;
    setNotice('');
    if (recipient) {
      if (!requests.data || requests.isError || !scope?.isCurrent()) {
        setNotice(
          'Agent requests are unavailable on this connection. Draft retained.',
        );
        return;
      }
      if (!unconfirmed && includeBrief && !brief) {
        setNotice(
          'Task brief is unavailable. Load it or explicitly send only this request.',
        );
        return;
      }
      const input = unconfirmed ?? {
        operationId: randomCorrelationId(),
        agentId: recipient.id,
        prompt: draft.trim(),
        ...(includeBrief && brief
          ? { context: { version: brief.version, digest: brief.digest } }
          : {}),
      };
      if (!unconfirmed) briefSelection.current += 1;
      setUnconfirmed(input);
      try {
        const outcome = await request.mutateAsync(input);
        if (outcome.kind === 'recorded') {
          setDraft('');
          setRecipient(undefined);
          setBrief(undefined);
          setIncludeBrief(true);
          setUnconfirmed(undefined);
          setNotice(
            outcome.record.state === 'dispatched'
              ? 'Agent request dispatched.'
              : 'Agent request recorded. Execution is not confirmed.',
          );
        } else {
          setUnconfirmed(undefined);
          setNotice(
            `Agent request refused: ${outcome.reason}. Draft retained.`,
          );
        }
      } catch (error) {
        if (error instanceof TaskRoomWorkNotSentError) {
          if (!unconfirmed) setUnconfirmed(undefined);
          setNotice(
            unconfirmed
              ? `${error.message} The original request is still unconfirmed.`
              : error.message,
          );
          return;
        }
        setNotice(
          'Request acknowledgement is unavailable. Check the request list, or retry this same request.',
        );
      }
      return;
    }
    try {
      const outcome = await message.mutateAsync({
        proposalId: randomCorrelationId(),
        text: draft.trim(),
      });
      if (outcome.kind === 'committed' || outcome.kind === 'duplicate')
        setDraft('');
      else setNotice('Message rejected. Draft retained.');
    } catch {
      setNotice(
        'Message acknowledgement is unavailable. Check room history before resending.',
      );
    }
  };
  return (
    <div className="task-room-composer">
      <section aria-label="Agent requests">
        <h3>Agent requests</h3>
        {requests.isError ? (
          <p role="alert">Agent requests are unavailable.</p>
        ) : null}
        <ol>
          {!requests.isError && readable && scope?.isCurrent()
            ? requests.data?.records.map((record) => (
                <li key={`${record.requesterId}:${record.operationId}`}>
                  <strong>@{record.agentId}</strong>: {record.prompt}
                  <p>
                    {record.state === 'dispatched'
                      ? 'Dispatched; inspect execution for progress and results'
                      : record.state === 'refused'
                        ? 'Refused'
                        : 'Execution not confirmed'}
                  </p>
                  <a href={activityDeepLink({ sessionId: record.sessionId })}>
                    View agent execution
                  </a>
                  <details>
                    <summary>Request details</summary>
                    {record.context ? (
                      <div className="task-room-brief-preview">
                        <strong>{record.context.title}</strong>
                        <p>{record.context.description}</p>
                        <pre>{record.context.text}</pre>
                        <p>
                          Saved brief {record.context.digest.slice(0, 12)} ·
                          document {record.context.documentRevision}
                        </p>
                      </div>
                    ) : (
                      <p>Request text only; no saved Task brief.</p>
                    )}
                    <p>
                      Requested {record.createdAt} by {record.requesterId}.
                      Execution {record.sessionId}.
                    </p>
                  </details>
                </li>
              ))
            : null}
        </ol>
        <Button
          size="sm"
          disabled={requests.isFetching}
          onClick={() => void requests.refetch()}
        >
          Refresh requests
        </Button>
      </section>
      {recipient ? (
        <fieldset aria-label="Agent recipient">
          Asking <strong>@{recipient.name}</strong>
          <Button
            size="sm"
            disabled={locked}
            aria-label={`Remove ${recipient.name}`}
            onClick={() => {
              briefSelection.current += 1;
              setRecipient(undefined);
            }}
          >
            Remove
          </Button>
        </fieldset>
      ) : (
        <Button
          size="sm"
          disabled={!writable || locked}
          onClick={() => {
            setDraftOwner(owner);
            setMention({ start: draft.length, end: draft.length, query: '' });
            setActive(0);
            textarea.current?.focus();
          }}
        >
          Ask an agent
        </Button>
      )}
      {recipient && !connectionChanged ? (
        <fieldset aria-label="Request context" disabled={locked}>
          <label className="task-room-brief-choice">
            <input
              type="checkbox"
              checked={includeBrief}
              onChange={(event) => {
                briefSelection.current += 1;
                setIncludeBrief(event.target.checked);
                if (event.target.checked)
                  setBrief(
                    !requests.isError
                      ? (requests.data?.context ?? undefined)
                      : undefined,
                  );
              }}
            />
            Include Task brief
          </label>
          {includeBrief ? (
            <>
              {brief ? (
                <details className="task-room-brief-preview">
                  <summary>
                    Preview selected brief · {brief.digest.slice(0, 12)}
                  </summary>
                  <strong>{brief.title}</strong>
                  <p>{brief.description}</p>
                  <pre>{brief.text}</pre>
                  <p>Document version {brief.documentRevision}</p>
                </details>
              ) : (
                <p>Task brief is unavailable on this connection.</p>
              )}
              <Button
                size="sm"
                disabled={locked || requests.isFetching || requests.isError}
                onClick={async () => {
                  const selection = ++briefSelection.current;
                  const result = await requests.refetch();
                  if (
                    scope?.isCurrent() &&
                    currentOwner.current === owner &&
                    briefSelection.current === selection &&
                    !result.isError
                  )
                    setBrief(result.data?.context ?? undefined);
                }}
              >
                Use latest brief
              </Button>
              <p>
                This exact snapshot goes with the request. Later edits do not
                change it.
              </p>
            </>
          ) : (
            <p>Only your request text will be sent.</p>
          )}
        </fieldset>
      ) : null}
      <label htmlFor={`${id}-message`}>Message</label>
      <textarea
        id={`${id}-message`}
        ref={textarea}
        value={draft}
        disabled={!writable || locked || !scope}
        aria-controls={picker ? `${id}-agents` : undefined}
        aria-activedescendant={
          picker && candidates.length ? `${id}-agent-${selected}` : undefined
        }
        aria-describedby={`${id}-help`}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(event) => {
          setComposing(false);
          findMention(
            event.currentTarget.value,
            event.currentTarget.selectionStart,
          );
        }}
        onChange={(event) => {
          setDraftOwner(owner);
          setDraft(event.currentTarget.value);
          findMention(
            event.currentTarget.value,
            event.currentTarget.selectionStart,
          );
        }}
        onClick={(event) =>
          findMention(
            event.currentTarget.value,
            event.currentTarget.selectionStart,
          )
        }
        onKeyDown={(event) => {
          if (!picker || event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            setMention(undefined);
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(
              Math.max(
                0,
                Math.min(
                  candidates.length - 1,
                  selected + (event.key === 'ArrowDown' ? 1 : -1),
                ),
              ),
            );
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            select(selected);
          }
        }}
      />
      <p id={`${id}-help`}>
        Type @ to choose an agent. Send starts the request; ordinary messages go
        to the team.
      </p>
      {picker ? (
        <div id={`${id}-agents`} role="listbox" aria-label="Choose an agent">
          {options.isLoading ? (
            <SkeletonList count={3} label="Finding agents" />
          ) : null}
          {options.isError ? (
            <p role="alert">Agent choices are unavailable.</p>
          ) : null}
          {!options.isLoading && !options.isError && !candidates.length ? (
            mention.query ? (
              <FilteredEmpty
                query={mention.query}
                noun="agents"
                onClear={() => {
                  setDraft(
                    draft.slice(0, mention.start) +
                      '@' +
                      draft.slice(mention.end),
                  );
                  setMention({
                    start: mention.start,
                    end: mention.start + 1,
                    query: '',
                  });
                  setActive(0);
                  textarea.current?.focus();
                }}
              />
            ) : (
              <Empty variant="compact" label="Nothing available" />
            )
          ) : null}
          {candidates.map((agent, index) => (
            <div key={agent.id}>
              <Button
                id={`${id}-agent-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={selected === index}
                aria-disabled={!agent.ready}
                disabled={!agent.ready}
                onClick={() => select(index)}
              >
                {agent.name} @{agent.id}
              </Button>
              <p>
                {agent.ready
                  ? agent.description
                  : (agent.unavailableReason ?? 'Unavailable')}
              </p>
            </div>
          ))}
        </div>
      ) : null}
      <Button
        pending={pending}
        disabled={
          !writable ||
          connectionChanged ||
          !scope ||
          !draft.trim() ||
          (recipient &&
            (!requests.data ||
              requests.isError ||
              (!unconfirmed && includeBrief && !brief)))
        }
        onClick={() => void submit()}
      >
        {unconfirmed
          ? 'Retry same agent request'
          : recipient
            ? `Ask ${recipient.name}`
            : 'Send to task room'}
      </Button>
      {notice ? <p role="status">{notice}</p> : null}
      {connectionChanged ? (
        <p role="alert">
          This draft belongs to the previous connection or Task. Reopen that
          Task to resolve it.
        </p>
      ) : null}
      <DiscardModal />
    </div>
  );
}
