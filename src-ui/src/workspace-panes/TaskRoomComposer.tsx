import type { TaskRoomAttachment } from '@kontourai/station-contracts/project-task-room';
import type { TaskStatus } from '@kontourai/station-contracts/task-graph';
import type {
  TaskRoomContextSnapshot,
  TaskRoomWorkInput,
} from '@kontourai/station-contracts/task-room-work';
import { useUpdateTaskStatusMutation } from '@kontourai/station-sdk';
import {
  TaskRoomWorkNotSentError,
  useAppendProjectTaskRoomHumanMessageMutation,
  useSubmitTaskRoomAgentRequestMutation,
  useTaskRoomAgentOptionsQuery,
  useTaskRoomAgentRequestsQuery,
} from '@kontourai/station-sdk/project-task-rooms';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { Empty, FilteredEmpty, SkeletonList } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useTaskRoomAttachments } from '../hooks/useTaskRoomAttachments';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';
import { TaskRoomAttachmentComposer } from './TaskRoomAttachmentComposer';
import { TaskRoomMessageInput } from './TaskRoomMessageInput';
import {
  readTaskRoomDraft,
  removeTaskRoomDraft,
  saveTaskRoomDraft,
  type TaskRoomDraftRecovery,
} from './task-room-draft-recovery';
import './TaskRoomComposer.css';

function startsWithSelectedPerson(value: string, person?: string) {
  if (person === undefined) return false;
  const text = value.trimStart();
  const mention = `@${person}`;
  return (
    text.startsWith(mention) && /^(?:\s|$)/.test(text.slice(mention.length))
  );
}

function recoveryAt(owner?: string) {
  try {
    return {
      owner,
      saved: owner ? readTaskRoomDraft(owner) : undefined,
      error: false,
    };
  } catch {
    return { owner, saved: undefined, error: true };
  }
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
  const statusMutation = useUpdateTaskStatusMutation();
  const recoveryOwner = scope?.draftRecoveryKey
    ? JSON.stringify([
        scope.apiBase,
        scope.draftRecoveryKey,
        projectSlug,
        taskId,
        taskCreatedAt,
      ])
    : undefined;
  const [recovery, setRecovery] = useState(() => recoveryAt(recoveryOwner));
  const recoveryBaseline = useRef({
    owner: recovery.owner,
    saved: recovery.saved,
  });
  const persistRecovery = (saved: TaskRoomDraftRecovery) => {
    if (recoveryBaseline.current.owner !== saved.owner)
      throw new Error('Draft owner changed');
    recoveryBaseline.current = {
      owner: saved.owner,
      saved: saveTaskRoomDraft(saved, recoveryBaseline.current.saved),
    };
  };
  const [recoveryError, setRecoveryError] = useState(false);
  const [showDiscardRecovery, setShowDiscardRecovery] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
  const [unconfirmedMessage, setUnconfirmedMessage] = useState<{
    proposalId: string;
    text: string;
    occurredAt: string;
    attachments?: TaskRoomAttachment[];
  }>();
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
    projectSlug,
    taskId,
    taskCreatedAt,
  ]);
  const attachments = useTaskRoomAttachments(taskId, taskCreatedAt, scope, () =>
    setDraftOwner(owner),
  );
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const connectionChanged = draftOwner !== undefined && draftOwner !== owner;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const discardRecovery = () => {
    if (
      !recoveryOwner ||
      recovery.owner !== recoveryOwner ||
      !scope?.isCurrent()
    )
      return false;
    try {
      removeTaskRoomDraft(recoveryOwner, recoveryBaseline.current.saved);
      recoveryBaseline.current = { owner: recoveryOwner, saved: undefined };
      setRecovery({ owner: recoveryOwner, saved: undefined, error: false });
      setDraft('');
      attachments.clear();
      setRecipient(undefined);
      setLeadingPerson(undefined);
      setUnconfirmed(undefined);
      setUnconfirmedMessage(undefined);
      setDraftOwner(undefined);
      setBrief(undefined);
      setIncludeBrief(true);
      setRecoveryError(false);
      setShowDiscardRecovery(false);
      return true;
    } catch {
      setRecoveryError(true);
      return false;
    }
  };
  const { DiscardModal } = useUnsavedGuard(
    !!draft ||
      !!recipient ||
      !!unconfirmed ||
      !!unconfirmedMessage ||
      attachments.files.length > 0,
    discardRecovery,
  );
  useLayoutEffect(() => {
    if (recovery.owner !== recoveryOwner) {
      if (!draft && !recipient && !unconfirmed && !unconfirmedMessage) {
        const next = recoveryAt(recoveryOwner);
        recoveryBaseline.current = { owner: next.owner, saved: next.saved };
        setRecovery(next);
      }
      return;
    }
    if (
      !recoveryOwner ||
      recovery.saved ||
      recovery.error ||
      !scope?.isCurrent() ||
      (draftOwner !== undefined && draftOwner !== owner)
    )
      return;
    try {
      recoveryBaseline.current = {
        owner: recoveryOwner,
        saved: saveTaskRoomDraft(
          {
            owner: recoveryOwner,
            draft,
            recipient,
            leadingPerson,
            includeBrief,
            unconfirmed,
            unconfirmedMessage,
          },
          recoveryBaseline.current.saved,
        ),
      };
      setRecoveryError(false);
    } catch {
      setRecoveryError(true);
    }
  }, [
    recoveryOwner,
    recovery,
    draft,
    recipient,
    leadingPerson,
    includeBrief,
    unconfirmed,
    unconfirmedMessage,
    scope,
    draftOwner,
    owner,
  ]);
  const pending =
    preparing || request.isPending || message.isPending || attachments.busy;
  const recoveryHeld =
    !!recovery.saved || recovery.error || recovery.owner !== recoveryOwner;
  const locked =
    pending ||
    !!unconfirmed ||
    !!unconfirmedMessage ||
    connectionChanged ||
    recoveryHeld;
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
      (!draft.trim() &&
        !attachments.files.length &&
        !unconfirmed?.attachments?.length &&
        !unconfirmedMessage?.attachments?.length) ||
      connectionChanged ||
      recoveryHeld ||
      !scope?.isCurrent()
    )
      return;
    setNotice('');
    sendInFlight.current = true;
    setPreparing(true);
    try {
      if (!recipient && !unconfirmedMessage && draft.trim().startsWith('/')) {
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
          await statusMutation.mutateAsync({
            taskId,
            status,
            apiBase: scope.apiBase,
          });
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
      if (unconfirmed && (!recipient || recipient.id !== unconfirmed.agentId)) {
        setNotice(
          'The saved request recipient could not be verified. No retry was sent.',
        );
        return;
      }
      let selectedRecipient = recipient;
      let selectedDraft = draft;
      if (
        !selectedRecipient &&
        !unconfirmed &&
        !unconfirmedMessage &&
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
      const selectedAttachments =
        unconfirmed?.attachments ??
        unconfirmedMessage?.attachments ??
        (await attachments.prepare());
      if (selectedRecipient) {
        const currentRecipient = options.data?.targets.find(
          (target) => target.id === selectedRecipient.id && target.ready,
        );
        if (options.isError || !currentRecipient) {
          setNotice(
            'This agent is unavailable. The request has been kept; no new attempt was sent.',
          );
          return;
        }
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
          prompt: selectedDraft.trim() || 'See attached files.',
          ...(selectedAttachments.length
            ? { attachments: selectedAttachments }
            : {}),
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
        if (!recoveryOwner) {
          setNotice(
            'Request recovery is unavailable on this connection. Nothing was sent.',
          );
          return;
        }
        try {
          persistRecovery({
            owner: recoveryOwner,
            draft,
            recipient: {
              id: selectedRecipient.id,
              name: selectedRecipient.name,
            },
            leadingPerson,
            includeBrief,
            unconfirmed: input,
          });
        } catch {
          setRecoveryError(true);
          setNotice(
            'Recovery could not be updated. No new attempt was sent; any earlier request remains unconfirmed.',
          );
          return;
        }
        setRecipient({
          id: selectedRecipient.id,
          name: selectedRecipient.name,
        });
        setUnconfirmed(input);
        try {
          const outcome = await request.mutateAsync(input);
          if (
            !mounted.current ||
            currentOwner.current !== owner ||
            !scope.isCurrent()
          )
            return;
          if (outcome.kind === 'recorded') {
            setDraft((current) => (current === draft ? '' : current));
            setRecipient(undefined);
            attachments.clear();
            setBrief(undefined);
            setIncludeBrief(true);
            setUnconfirmed(undefined);
            setNotice(
              outcome.record.state === 'dispatched'
                ? 'Agent request dispatched.'
                : 'Agent request recorded. Execution is not confirmed.',
            );
          } else {
            if (!unconfirmed) setUnconfirmed(undefined);
            setNotice(
              unconfirmed
                ? `Retry refused: ${outcome.reason}. The original request remains unconfirmed.`
                : `Agent request refused: ${outcome.reason}. Draft retained.`,
            );
          }
        } catch (error) {
          if (
            !mounted.current ||
            currentOwner.current !== owner ||
            !scope.isCurrent()
          )
            return;
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
      const input = unconfirmedMessage ?? {
        proposalId: randomCorrelationId(),
        text: draft.trim() || 'Attached files',
        ...(selectedAttachments.length
          ? { attachments: selectedAttachments }
          : {}),
        occurredAt: new Date().toISOString(),
      };
      if (!recoveryOwner) {
        setNotice(
          'Message recovery is unavailable on this connection. Nothing was sent.',
        );
        return;
      }
      try {
        persistRecovery({
          owner: recoveryOwner,
          draft,
          leadingPerson,
          includeBrief,
          unconfirmedMessage: input,
        });
      } catch {
        setRecoveryError(true);
        setNotice(
          'Recovery could not be updated. No new attempt was sent; any earlier message remains unconfirmed.',
        );
        return;
      }
      setUnconfirmedMessage(input);
      try {
        const outcome = await message.mutateAsync(input);
        if (
          !mounted.current ||
          currentOwner.current !== owner ||
          !scope.isCurrent()
        )
          return;
        if (outcome.kind === 'committed' || outcome.kind === 'duplicate') {
          setDraft((current) => (current === draft ? '' : current));
          setLeadingPerson(undefined);
          attachments.clear();
          setUnconfirmedMessage(undefined);
        } else {
          setUnconfirmedMessage(undefined);
          setNotice('Message rejected. Draft retained.');
        }
      } catch {
        setNotice(
          'Message acknowledgement is unavailable. Check room history before resending.',
        );
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Attachments could not be sent. Draft retained.',
      );
    } finally {
      sendInFlight.current = false;
      setPreparing(false);
    }
  };
  return (
    <div className="task-room-composer">
      {recovery.saved && recovery.owner === recoveryOwner && (
        <section aria-label="Saved Task draft">
          <p>
            {recovery.saved.unconfirmed
              ? 'A saved agent request has an unknown outcome. Restore it to review or retry the exact same request. It may already be running.'
              : recovery.saved.unconfirmedMessage
                ? 'A saved message has an unknown outcome. Restore it to review or retry the exact same message.'
                : 'A draft was saved in this tab. Restore it to review before sending.'}
          </p>
          <Button
            disabled={!writable || !readable || !scope?.isCurrent()}
            onClick={() => {
              const saved = recovery.saved;
              if (
                !saved ||
                recovery.owner !== recoveryOwner ||
                !scope?.isCurrent()
              )
                return;
              const target = saved.recipient
                ? options.data?.targets.find(
                    (target) =>
                      target.id === saved.recipient?.id && target.ready,
                  )
                : undefined;
              if (saved.recipient && (options.isError || !target)) {
                setNotice(
                  'The saved agent is unavailable. Reconnect before restoring this request.',
                );
                return;
              }
              setDraft(saved.draft);
              setRecipient(
                target ? { id: target.id, name: target.name } : undefined,
              );
              setLeadingPerson(saved.leadingPerson);
              setIncludeBrief(saved.includeBrief);
              setUnconfirmed(saved.unconfirmed);
              setUnconfirmedMessage(saved.unconfirmedMessage);
              setDraftOwner(owner);
              setRecovery({
                owner: recoveryOwner,
                saved: undefined,
                error: false,
              });
            }}
          >
            Restore saved draft
          </Button>
          <Button
            variant="secondary"
            onClick={() => setShowDiscardRecovery(true)}
          >
            Discard saved draft
          </Button>
        </section>
      )}
      {(recovery.error || recoveryError) && (
        <p role="alert">
          The draft could not be saved or restored. Keep this tab open; request
          recovery is unavailable.
        </p>
      )}
      {unconfirmed && (
        <Button
          variant="secondary"
          disabled={pending || connectionChanged || !scope?.isCurrent()}
          onClick={async () => {
            const capturedOwner = owner;
            let result: Awaited<ReturnType<typeof requests.refetch>>;
            try {
              result = await requests.refetch();
            } catch {
              if (
                mounted.current &&
                currentOwner.current === capturedOwner &&
                scope?.isCurrent()
              )
                setNotice(
                  'Request status is unavailable. Its outcome remains unknown.',
                );
              return;
            }
            if (
              !mounted.current ||
              currentOwner.current !== capturedOwner ||
              !scope?.isCurrent()
            )
              return;
            const recorded =
              !result.isError &&
              result.data?.records.find(
                (record) =>
                  record.operationId === unconfirmed.operationId &&
                  record.agentId === unconfirmed.agentId &&
                  record.prompt === unconfirmed.prompt &&
                  record.context?.digest === unconfirmed.context?.digest,
              );
            setNotice(
              recorded
                ? `The saved request is recorded as ${recorded.state}. Review its full run before retrying.`
                : 'No matching receipt is available. This does not prove the request failed; its outcome remains unknown.',
            );
          }}
        >
          Check saved request status
        </Button>
      )}
      {unconfirmedMessage && (
        <p role="status">
          This message has an unknown outcome. Retry uses the same proposal;
          discarding only removes your local copy.
        </p>
      )}
      {unconfirmed && (
        <p role="status">
          This request has an unknown outcome and may already be running. Retry
          uses the same operation; discarding only removes your local copy.
        </p>
      )}
      <label className="sr-only" htmlFor={`${id}-message`}>
        Message the Task
      </label>
      <TaskRoomAttachmentComposer
        attachments={attachments}
        locked={!writable || locked || !scope}
        owner={owner}
      >
        <TaskRoomMessageInput
          onSend={() => {
            if (
              !composing &&
              !locked &&
              writable &&
              (draft.trim() || attachments.files.length)
            )
              void submit();
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
              !startsWithSelectedPerson(
                event.currentTarget.value,
                leadingPerson,
              )
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
      </TaskRoomAttachmentComposer>
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
              : unconfirmedMessage
                ? 'Retry same room message'
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
            recoveryHeld ||
            connectionChanged ||
            !scope ||
            (!draft.trim() &&
              !attachments.files.length &&
              !unconfirmed?.attachments?.length &&
              !unconfirmedMessage?.attachments?.length) ||
            (recipient && (!requests.data || requests.isError))
          }
          onClick={() => void submit()}
        >
          {unconfirmed || unconfirmedMessage
            ? 'Retry'
            : recipient
              ? `Ask ${recipient.name}`
              : 'Send'}
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
      {(draft || recipient || unconfirmed || unconfirmedMessage) &&
        !recoveryHeld && (
          <Button
            variant="secondary"
            disabled={pending || connectionChanged}
            onClick={() => setShowDiscardRecovery(true)}
          >
            Discard draft
          </Button>
        )}
      <ConfirmModal
        isOpen={showDiscardRecovery}
        title="Discard saved draft?"
        message="This removes only the saved copy. An unconfirmed request may still be running."
        confirmLabel="Discard"
        variant="warning"
        onConfirm={discardRecovery}
        onCancel={() => setShowDiscardRecovery(false)}
      />
      <DiscardModal />
    </div>
  );
}
