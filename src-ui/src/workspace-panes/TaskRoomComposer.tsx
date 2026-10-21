import type { TaskStatus } from '@kontourai/station-contracts/task-graph';
import type {
  TaskRoomContextSnapshot,
  TaskRoomWorkInput,
} from '@kontourai/station-contracts/task-room-work';
import { updateTaskStatus } from '@kontourai/station-sdk';
import {
  TaskRoomWorkNotSentError,
  useAppendProjectTaskRoomHumanMessageMutation,
  useSubmitTaskRoomAgentRequestMutation,
  useTaskRoomAgentOptionsQuery,
  useTaskRoomAgentRequestsQuery,
} from '@kontourai/station-sdk/project-task-rooms';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { Empty, FilteredEmpty, SkeletonList } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';
import { TaskRoomMessageInput } from './TaskRoomMessageInput';
import './TaskRoomComposer.css';

function startsWithSelectedPerson(value: string, person?: string) {
  if (person === undefined) return false;
  const text = value.trimStart();
  const mention = `@${person}`;
  return (
    text.startsWith(mention) && /^(?:\s|$)/.test(text.slice(mention.length))
  );
}

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
  const room = useProjectTaskRoomContext(taskId);
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
  const [leadingPerson, setLeadingPerson] = useState<string>();
  const [mention, setMention] = useState<{
    start: number;
    end: number;
    query: string;
  }>();
  const [active, setActive] = useState(0);
  const [composing, setComposing] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState<TaskRoomWorkInput>();
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [preparing, setPreparing] = useState(false);
  const sendInFlight = useRef(false);
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
  const pending = preparing || request.isPending || message.isPending;
  const locked = pending || !!unconfirmed || connectionChanged;
  const candidates = [
    ...(options.isError ? [] : (options.data?.targets ?? [])).map((target) => ({
      ...target,
      person: false,
    })),
    ...(room?.live?.participants ?? [])
      .filter(
        (participant) =>
          participant.publication === 'published' &&
          participant.actor.kind === 'human',
      )
      .map((participant) => ({
        id: participant.actor.actorId,
        name: participant.actor.label,
        description: 'Here now',
        ready: true,
        unavailableReason: undefined,
        person: true,
      })),
  ]
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
    if (agent.person) {
      if (!draft.slice(0, mention.start).trim()) setLeadingPerson(agent.name);
      setDraft(
        draft.slice(0, mention.start) +
          `@${agent.name} ` +
          draft.slice(mention.end),
      );
      setMention(undefined);
      textarea.current?.focus();
      return;
    }
    briefSelection.current += 1;
    setLeadingPerson(undefined);
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
      sendInFlight.current ||
      pending ||
      !draft.trim() ||
      connectionChanged ||
      !scope?.isCurrent()
    )
      return;
    setNotice('');
    sendInFlight.current = true;
    setPreparing(true);
    try {
      if (!recipient && draft.trim().startsWith('/')) {
        const statuses: Record<string, TaskStatus> = {
          '/done': 'done',
          '/blocked': 'blocked',
          '/review': 'review',
          '/cancel': 'canceled',
          '/start': 'in_progress',
        };
        const command = draft.trim().toLowerCase();
        const status = statuses[command];
        if (!status) {
          setNotice(
            'Commands: /start, /review, /done, /blocked, /cancel. Status changes follow the Task’s allowed transitions.',
          );
          return;
        }
        try {
          await updateTaskStatus({ taskId, status, apiBase: scope.apiBase });
          if (currentOwner.current !== owner || !scope.isCurrent()) return;
          setDraft((current) => (current === draft ? '' : current));
          setNotice('');
        } catch (error) {
          if (currentOwner.current === owner)
            setNotice(
              error instanceof Error
                ? error.message
                : 'Status could not be changed. Draft retained.',
            );
        }
        return;
      }
      let selectedRecipient = recipient;
      let selectedDraft = draft;
      if (
        !selectedRecipient &&
        !unconfirmed &&
        !startsWithSelectedPerson(draft, leadingPerson)
      ) {
        const typed = /^@([^\s]+)\s+([\s\S]+)$/.exec(draft.trim());
        if (typed) {
          const matches =
            options.data?.targets.filter(
              (target) =>
                target.ready &&
                (target.id.toLowerCase() === typed[1].toLowerCase() ||
                  target.name.toLowerCase() === typed[1].toLowerCase()),
            ) ?? [];
          if (matches.length !== 1) {
            setNotice('Pick an agent from the list to send a request');
            return;
          }
          selectedRecipient = matches[0];
          selectedDraft = typed[2];
        } else if (/^@/.test(draft.trim())) {
          setNotice('Pick an agent from the list to send a request');
          return;
        }
      }
      if (selectedRecipient) {
        if (!requests.data || requests.isError || !scope?.isCurrent()) {
          setNotice(
            'Agent requests are unavailable on this connection. Draft retained.',
          );
          return;
        }
        let latestBrief = brief;
        if (!unconfirmed && includeBrief) {
          const selection = ++briefSelection.current;
          const refreshed = await requests.refetch();
          if (
            currentOwner.current !== owner ||
            !scope.isCurrent() ||
            briefSelection.current !== selection
          )
            return;
          latestBrief = !refreshed.isError
            ? (refreshed.data?.context ?? undefined)
            : undefined;
          setBrief(latestBrief);
          if (!latestBrief) {
            setNotice(
              'Task brief is unavailable. Retry or uncheck Brief attached to send request text only.',
            );
            return;
          }
        }
        const input = unconfirmed ?? {
          operationId: randomCorrelationId(),
          agentId: selectedRecipient.id,
          prompt: selectedDraft.trim(),
          ...(includeBrief && latestBrief
            ? {
                context: {
                  version: latestBrief.version,
                  digest: latestBrief.digest,
                },
              }
            : {}),
        };
        if (!unconfirmed) briefSelection.current += 1;
        setUnconfirmed(input);
        try {
          const outcome = await request.mutateAsync(input);
          if (outcome.kind === 'recorded') {
            setDraft((current) => (current === draft ? '' : current));
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
        if (outcome.kind === 'committed' || outcome.kind === 'duplicate') {
          setDraft((current) => (current === draft ? '' : current));
          setLeadingPerson(undefined);
        } else setNotice('Message rejected. Draft retained.');
      } catch {
        setNotice(
          'Message acknowledgement is unavailable. Check room history before resending.',
        );
      }
    } finally {
      sendInFlight.current = false;
      setPreparing(false);
    }
  };
  return (
    <div className="task-room-composer">
      <label className="sr-only" htmlFor={`${id}-message`}>
        Message the Task
      </label>
      <TaskRoomMessageInput
        onSend={() => {
          if (!composing && !locked && writable && draft.trim()) void submit();
        }}
        id={`${id}-message`}
        placeholder="Message the Task…"
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
          setNotice('');
          setDraftOwner(owner);
          setDraft(event.currentTarget.value);
          if (
            !startsWithSelectedPerson(event.currentTarget.value, leadingPerson)
          )
            setLeadingPerson(undefined);
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
          if (!picker || composing || event.nativeEvent.isComposing) return;
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
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            select(selected);
          }
        }}
      />
      <div className="task-room-composer-actions">
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
            className="task-room-agent-action"
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
        <label className="task-room-brief-choice">
          <input
            type="checkbox"
            aria-label="Brief attached to agent requests"
            checked={includeBrief}
            disabled={locked}
            onChange={(event) => setIncludeBrief(event.currentTarget.checked)}
          />
          <span className="task-room-brief-long">
            Brief attached to agent requests
          </span>
          <span className="task-room-brief-short">Brief attached</span>
        </label>
        <Button
          className="task-room-send"
          aria-label={
            pending
              ? 'Sending…'
              : unconfirmed
                ? 'Retry same agent request'
                : recipient
                  ? `Ask ${recipient.name}`
                  : 'Send to task room'
          }
          pending={pending}
          pendingLabel="Sending…"
          disabled={
            !writable ||
            connectionChanged ||
            !scope ||
            !draft.trim() ||
            (recipient && (!requests.data || requests.isError))
          }
          onClick={() => void submit()}
        >
          {unconfirmed ? 'Retry' : recipient ? `Ask ${recipient.name}` : 'Send'}
        </Button>
      </div>
      {recipient && brief?.text.includes('Brief shortened to fit') && (
        <p role="status">
          The brief exceeds 16,000 characters. A shortened version with a notice
          will be attached.
        </p>
      )}
      <p className="task-room-composer-help" id={`${id}-help`}>
        Enter to send, Shift+Enter for a new line. Type @ for agents and people,
        / for commands.
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
                {agent.name}
                {agent.person ? '' : ` @${agent.id}`}
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
      {notice ? (
        <p className="task-room-inline-status" role="status">
          {notice}
        </p>
      ) : null}
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
