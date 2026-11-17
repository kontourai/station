import type { TaskRoomAttachment } from '@kontourai/station-contracts/project-task-room';
import type { TaskStatus } from '@kontourai/station-contracts/task-graph';
import type {
  TaskRoomContextSnapshot,
  TaskRoomWorkInput,
  TaskRoomWorkRecord,
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
import { applyReturnFocus } from '@kontourai/station-shared/return-focus';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { RoomComposer } from '../components/room/RoomComposer';
import {
  type RoomMentionCandidate,
  RoomMentionPicker,
  useRoomMention,
} from '../components/room/RoomMentionPicker';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { useTaskRoomAttachments } from '../hooks/useTaskRoomAttachments';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { describeStationFailure } from '../utils/stationFailure';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';
import {
  readTaskRoomDraft,
  removeTaskRoomDraft,
  saveTaskRoomDraft,
  type TaskRoomDraftRecovery,
} from './task-room-draft-recovery';
import './TaskRoomComposer.css';

/** What a recorded saved request means for retrying it, in the user's words. */
export function savedRequestStateNotice(
  state: TaskRoomWorkRecord['state'],
): string {
  switch (state) {
    case 'starting':
      return 'This request was saved but not confirmed as sent. Check its run before retrying.';
    case 'dispatched':
      return 'This request was sent to the agent. Check its run before retrying.';
    case 'indeterminate':
      return 'Couldn’t confirm whether this request ran. Check its run before retrying.';
    case 'refused':
      return 'This request was refused, so it didn’t run. Send it again as a new request.';
  }
}

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
  const compact = useIsMobile();
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
  const ownerGeneration = useRef(0);
  const connectionChanged = draftOwner !== undefined && draftOwner !== owner;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [returnToMessage, setReturnToMessage] = useState<{
    element: HTMLTextAreaElement;
    owner: string;
    generation: number;
    isCurrent: () => boolean;
    cancelled: boolean;
  }>();
  const focusReturnAttempt = useRef<typeof returnToMessage>(undefined);
  useLayoutEffect(() => {
    if (currentOwner.current !== owner) {
      currentOwner.current = owner;
      ownerGeneration.current += 1;
    }
    const cancelCompetingFocus = () => {
      const attempt = focusReturnAttempt.current;
      const active = document.activeElement;
      if (
        attempt &&
        active &&
        active !== document.body &&
        active !== document.documentElement &&
        active.isConnected &&
        active !== attempt.element
      ) {
        attempt.cancelled = true;
      }
    };
    document.addEventListener('focusin', cancelCompetingFocus, true);
    return () => {
      document.removeEventListener('focusin', cancelCompetingFocus, true);
      if (focusReturnAttempt.current)
        focusReturnAttempt.current.cancelled = true;
      focusReturnAttempt.current = undefined;
    };
  }, [owner]);
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
  useLayoutEffect(() => {
    if (!returnToMessage) return;
    if (
      returnToMessage.cancelled ||
      focusReturnAttempt.current !== returnToMessage ||
      returnToMessage.owner !== owner ||
      returnToMessage.generation !== ownerGeneration.current ||
      !returnToMessage.isCurrent() ||
      !scope?.isCurrent() ||
      !writable ||
      textarea.current !== returnToMessage.element
    ) {
      if (focusReturnAttempt.current === returnToMessage)
        focusReturnAttempt.current = undefined;
      setReturnToMessage(undefined);
      return;
    }
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement &&
      active.isConnected &&
      active !== returnToMessage.element
    ) {
      returnToMessage.cancelled = true;
      focusReturnAttempt.current = undefined;
      setReturnToMessage(undefined);
      return;
    }
    if (locked) return;
    focusReturnAttempt.current = undefined;
    setReturnToMessage(undefined);
    applyReturnFocus([returnToMessage.element], returnToMessage.element);
  }, [returnToMessage, owner, scope, writable, locked]);
  const candidates: RoomMentionCandidate[] = [
    ...(options.isError ? [] : (options.data?.targets ?? [])).map((target) => ({
      id: target.id,
      name: target.name,
      agent: true,
      handle: target.id,
      description: target.description,
      ready: target.ready,
      unavailableReason: target.unavailableReason,
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
        agent: false,
        description: 'Here now',
        ready: true,
      })),
  ];
  const mention = useRoomMention({
    candidates,
    enabled: writable && !composing && !recipient && !locked,
    onPick(candidate, query) {
      setDraftOwner(owner);
      if (!candidate.agent) {
        if (!draft.slice(0, query.start).trim())
          setLeadingPerson(candidate.name);
        setDraft(
          draft.slice(0, query.start) +
            `@${candidate.name} ` +
            draft.slice(query.end),
        );
        textarea.current?.focus();
        return;
      }
      briefSelection.current += 1;
      setLeadingPerson(undefined);
      setRecipient({ id: candidate.id, name: candidate.name });
      setBrief(
        !requests.isError && scope?.isCurrent()
          ? (requests.data?.context ?? undefined)
          : undefined,
      );
      setDraft(draft.slice(0, query.start) + draft.slice(query.end));
      textarea.current?.focus();
    },
  });
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
    const focusedMessage =
      document.activeElement === textarea.current ? textarea.current : null;
    const sendGeneration = ownerGeneration.current;
    const focusAttempt = focusedMessage
      ? {
          element: focusedMessage,
          owner,
          generation: sendGeneration,
          isCurrent: () => scope.isCurrent(),
          cancelled: false,
        }
      : undefined;
    focusReturnAttempt.current = focusAttempt;
    let focusReturnQueued = false;
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
            setNotice(describeStationFailure(error).body);
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
                ? `${describeStationFailure(error).body} The original request is still unconfirmed.`
                : describeStationFailure(error).body,
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
          ownerGeneration.current !== sendGeneration ||
          !scope.isCurrent()
        )
          return;
        if (outcome.kind === 'committed' || outcome.kind === 'duplicate') {
          if (focusAttempt && !focusAttempt.cancelled) {
            focusReturnQueued = true;
            setReturnToMessage(focusAttempt);
          }
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
      setNotice(describeStationFailure(error).body);
    } finally {
      if (!focusReturnQueued && focusReturnAttempt.current === focusAttempt)
        focusReturnAttempt.current = undefined;
      sendInFlight.current = false;
      setPreparing(false);
    }
  };
  return (
    <div
      className={`task-room-composer${compact ? ' task-room-composer--compact' : ''}`}
    >
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
                ? savedRequestStateNotice(recorded.state)
                : 'Couldn’t confirm whether this request ran. Check the run list before retrying.',
            );
          }}
        >
          Check saved request status
        </Button>
      )}
      {unconfirmedMessage && (
        <p role="status">
          Couldn’t confirm this message was sent. Retry sends the same message;
          discarding only removes your local copy.
        </p>
      )}
      {unconfirmed && (
        <p role="status">
          This request has an unknown outcome and may already be running. Retry
          uses the same operation; discarding only removes your local copy.
        </p>
      )}
      <RoomComposer
        id={`${id}-message`}
        label="Message the Task"
        placeholder="Message the Task…"
        value={draft}
        textareaRef={textarea}
        disabled={!writable || locked || !scope}
        onValueChange={(value, caret) => {
          setNotice('');
          setDraftOwner(owner);
          setDraft(value);
          if (!startsWithSelectedPerson(value, leadingPerson))
            setLeadingPerson(undefined);
          mention.find(value, caret);
        }}
        onSend={() => {
          if (!composing) void submit();
        }}
        canSend={
          writable &&
          !recoveryHeld &&
          !connectionChanged &&
          !!scope &&
          (!!draft.trim() ||
            attachments.files.length > 0 ||
            !!unconfirmed?.attachments?.length ||
            !!unconfirmedMessage?.attachments?.length) &&
          !(recipient && (!requests.data || requests.isError))
        }
        pending={pending}
        sendLabel={
          unconfirmedMessage
            ? 'Retry same room message'
            : unconfirmed
              ? 'Retry same agent request'
              : recipient
                ? `Ask ${recipient.name}`
                : 'Send to task room'
        }
        attachments={{
          port: attachments,
          locked: !writable || locked || !scope,
          owner,
        }}
        inputProps={{
          'aria-controls': mention.open ? `${id}-agents` : undefined,
          'aria-activedescendant':
            mention.open && mention.filtered.length
              ? `${id}-agents-option-${mention.selected}`
              : undefined,
          'aria-describedby': `${id}-help`,
          onCompositionStart: () => setComposing(true),
          onCompositionEnd: (event) => {
            setComposing(false);
            mention.find(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            );
          },
          onClick: (event) =>
            mention.find(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            ),
          onKeyDown: mention.onKeyDown,
        }}
        above={
          recipient ? (
            <fieldset
              className="room-composer__chip"
              aria-label="Agent recipient"
            >
              Asking <strong>@{recipient.name}</strong>
              <Button
                variant="ghost"
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
          ) : undefined
        }
        tools={
          <>
            {!recipient && (
              <Button
                size="sm"
                className="task-room-agent-action"
                disabled={!writable || locked}
                onClick={() => {
                  setDraftOwner(owner);
                  mention.openAt(draft.length);
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
                onChange={(event) =>
                  setIncludeBrief(event.currentTarget.checked)
                }
              />
              <span className="task-room-brief-long">
                Brief attached to agent requests
              </span>
              <span className="task-room-brief-short">Brief attached</span>
            </label>
          </>
        }
        below={
          <>
            <RoomMentionPicker
              id={`${id}-agents`}
              state={mention}
              loading={options.isLoading}
              failed={options.isError}
              onClearQuery={() => {
                const query = mention.mention;
                if (!query) return;
                setDraft(
                  `${draft.slice(0, query.start)}@${draft.slice(query.end)}`,
                );
                mention.openAt(query.start);
                textarea.current?.focus();
              }}
            />
            {recipient && brief?.text.includes('Brief shortened to fit') && (
              <p className="room-composer__status" role="status">
                The brief exceeds 16,000 characters. A shortened version with a
                notice will be attached.
              </p>
            )}
            <p className="sr-only" id={`${id}-help`}>
              Enter to send, Shift+Enter for a new line. Type @ for agents and
              people, / for commands.
            </p>
          </>
        }
      />
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
