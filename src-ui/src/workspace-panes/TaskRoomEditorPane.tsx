import type { WorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';
import {
  adoptCommittedProjectTaskRoomDocument,
  type ProjectTaskRoomDocument,
  refetchAuthoritativeProjectTaskRoomDocument,
  usePlanProjectTaskRoomEditMutation,
  useProjectTaskRoomDiscoveryQuery,
  useProjectTaskRoomDocumentQuery,
  useSubmitProjectTaskRoomBatchMutation,
} from '@kontourai/station-sdk/project-task-rooms';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import {
  browserEpochMs,
  clearInteractiveWorkspacePerformanceBookkeeping,
  emitRemoteCursorCommitPerformanceMark,
  emitTaskCommitPerformanceMark,
  emitTaskDocumentApplyPerformanceMark,
  emitTaskInputPerformanceMark,
  INTERACTIVE_WORKSPACE_REMOTE_CURSOR_NONCE_EVENT,
  registerInteractiveWorkspaceTaskRoomListener,
  setInteractiveWorkspacePerformanceBookkeeping,
} from '../performance/interactive-workspace-performance-hooks';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';
import { projectTaskRoomEditorPaneId } from './ProjectTaskRoomPresence';
import type { WorkspacePaneHostRuntime } from './workspacePaneHostRuntime';

type AuthoritativeRoomDocument = Extract<
  ProjectTaskRoomDocument,
  { kind: 'snapshot' | 'delta' }
>;

/**
 * Browser adapter over the server's private edit planning capability. It never
 * receives operations, atoms, an epoch, or a write grant: only an opaque plan
 * receipt can be submitted, including after an indeterminate response.
 */
export function TaskRoomEditorPane({
  taskId,
  runtime,
  instanceId,
}: {
  taskId: string;
  runtime?: WorkspacePaneHostRuntime;
  instanceId?: WorkspacePaneInstanceId;
}) {
  const discovery = useProjectTaskRoomDiscoveryQuery(taskId);
  const shared = useProjectTaskRoomContext(taskId);
  const authorizationCurrent = shared?.stream !== 'terminal';
  const document = useProjectTaskRoomDocumentQuery(taskId);
  const queryClient = useQueryClient();
  const plan = usePlanProjectTaskRoomEditMutation(taskId);
  const batch = useSubmitProjectTaskRoomBatchMutation(taskId);
  const [text, setText] = useState('');
  const [authoritativeText, setAuthoritativeText] = useState('');
  const [appliedDocument, setAppliedDocument] =
    useState<AuthoritativeRoomDocument>();
  const [rejection, setRejection] = useState<string>();
  const [possibleEffect, setPossibleEffect] = useState<{
    intentId: string;
    intentDigest: string;
    observedDocument: object;
  }>();
  const [settlement, setSettlement] = useState<
    'unchanged' | 'committed' | 'duplicate'
  >();
  const id = useId().replaceAll(':', '');
  const operationGeneration = useRef(0);
  const authorizationRef = useRef(true);
  const displayedTaskId = useRef(taskId);
  const authoritativeTextRef = useRef(authoritativeText);
  const lastDocumentIdentity = useRef<string | undefined>(undefined);
  const pendingPerformanceApply = useRef<
    | {
        workingRevision: string;
        text: string;
      }
    | undefined
  >(undefined);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const cursorSampleNonces = useRef(new Map<string, string>());
  if (authorizationRef.current !== authorizationCurrent) {
    authorizationRef.current = authorizationCurrent;
    operationGeneration.current += 1;
  }
  authoritativeTextRef.current = authoritativeText;
  useLayoutEffect(() => {
    // Task identity defines the lifetime, even though only the generation is read.
    void taskId;
    operationGeneration.current += 1;
    return () => {
      operationGeneration.current += 1;
    };
  }, [taskId]);
  const isCurrentOperation = (generation: number) =>
    authorizationRef.current && operationGeneration.current === generation;
  const applyAuthoritativeDocument = (
    nextDocument: AuthoritativeRoomDocument,
    requireCurrentStream = true,
  ) => {
    if (
      (requireCurrentStream && !authorizationRef.current) ||
      displayedTaskId.current !== taskId
    )
      return;
    const identity = `${nextDocument.kind}\u0000${nextDocument.revision}\u0000${nextDocument.text}`;
    if (lastDocumentIdentity.current === identity) return;
    lastDocumentIdentity.current = identity;
    const previousAuthoritativeText = authoritativeTextRef.current;
    if (
      import.meta.env.MODE === 'test' ||
      import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE === '1'
    ) {
      pendingPerformanceApply.current = {
        workingRevision: nextDocument.revision,
        text: nextDocument.text,
      };
      emitTaskDocumentApplyPerformanceMark({
        taskId,
        workingRevision: nextDocument.revision,
        appliedEpochMs: browserEpochMs(),
      });
    }
    setText((current) =>
      current === previousAuthoritativeText ? nextDocument.text : current,
    );
    setAppliedDocument(nextDocument);
    authoritativeTextRef.current = nextDocument.text;
    setAuthoritativeText(nextDocument.text);
  };
  const applyAuthoritativeDocumentRef = useRef(applyAuthoritativeDocument);
  applyAuthoritativeDocumentRef.current = applyAuthoritativeDocument;
  const dirty = text !== authoritativeText;
  const { DiscardModal } = useUnsavedGuard(dirty);
  useLayoutEffect(() => {
    if (displayedTaskId.current === taskId) return;
    displayedTaskId.current = taskId;
    lastDocumentIdentity.current = undefined;
    pendingPerformanceApply.current = undefined;
    setPossibleEffect(undefined);
    setRejection(undefined);
    setSettlement(undefined);
    if (document.data?.kind === 'snapshot' || document.data?.kind === 'delta') {
      const next = document.data.text;
      lastDocumentIdentity.current = `${document.data.kind}\u0000${document.data.revision}\u0000${next}`;
      setText(next);
      setAppliedDocument(document.data);
      authoritativeTextRef.current = next;
      setAuthoritativeText(next);
    } else {
      setText('');
      setAppliedDocument(undefined);
      authoritativeTextRef.current = '';
      setAuthoritativeText('');
    }
  }, [document.data, taskId]);
  useEffect(() => {
    if (!runtime || !instanceId) return;
    runtime.setBeforeClose(instanceId, () =>
      dirty ? { confirm: 'dirty' } : 'allow',
    );
    return () => {
      runtime.setBeforeClose(instanceId, undefined);
    };
  }, [dirty, instanceId, runtime]);
  const room = shared?.discovery ?? discovery;
  useLayoutEffect(() => {
    if (!shared) return;
    return shared.subscribeDocument((nextDocument) =>
      applyAuthoritativeDocumentRef.current(nextDocument),
    );
  }, [shared]);
  useLayoutEffect(() => {
    if (document.data?.kind === 'snapshot' || document.data?.kind === 'delta') {
      applyAuthoritativeDocumentRef.current(document.data, false);
    }
  }, [document.data]);
  const queryDocument =
    document.data?.kind === 'snapshot' || document.data?.kind === 'delta'
      ? document.data
      : undefined;
  const displayedDocument = appliedDocument ?? queryDocument;
  const documentLoaded = displayedDocument !== undefined;
  const documentRevision = displayedDocument?.revision;
  useLayoutEffect(() => {
    if (
      import.meta.env.MODE !== 'test' &&
      import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !== '1'
    )
      return;
    if (!documentRevision || !editorRef.current) return;
    const pending = pendingPerformanceApply.current;
    if (
      pending &&
      (pending.workingRevision !== documentRevision ||
        pending.text !== text ||
        editorRef.current.value !== pending.text)
    )
      return;
    editorRef.current.getBoundingClientRect();
    emitTaskCommitPerformanceMark({
      taskId,
      workingRevision: documentRevision,
      text,
      committedEpochMs: browserEpochMs(),
    });
    if (pending) pendingPerformanceApply.current = undefined;
  });
  const roomAvailable =
    room.data?.kind === 'opened' || room.data?.kind === 'existing';
  const capabilities =
    room.data?.kind === 'opened' || room.data?.kind === 'existing'
      ? room.data.capabilities
      : undefined;
  const readable = documentLoaded && capabilities?.documentRead === true;
  const writable =
    readable && capabilities?.documentWrite === true && authorizationCurrent;
  const paneId = projectTaskRoomEditorPaneId(taskId);
  const livePane = shared?.live?.panes.find(
    (pane) => pane.paneId === paneId && pane.actorId === shared.ownActorId,
  );
  const remoteCursors =
    shared?.live?.cursors.filter(
      (cursor) =>
        cursor.actorId !== shared.ownActorId &&
        cursor.workingRevision === documentRevision,
    ) ?? [];
  const followedCursor =
    livePane?.state === 'following'
      ? remoteCursors.find(
          (cursor) => cursor.actorId === livePane.targetActorId,
        )
      : undefined;
  useEffect(() => {
    if (
      import.meta.env.MODE !== 'test' &&
      import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !== '1'
    )
      return;
    const arm = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const value = event.detail;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const detail = value as Record<string, unknown>;
      if (
        detail.taskId !== taskId ||
        typeof detail.actorId !== 'string' ||
        typeof detail.workingRevision !== 'string' ||
        !Number.isSafeInteger(detail.anchor) ||
        !Number.isSafeInteger(detail.focus) ||
        typeof detail.nonce !== 'string' ||
        !/^[A-Za-z0-9_-]{8,64}$/.test(detail.nonce)
      )
        return;
      cursorSampleNonces.current.set(
        `${detail.actorId}\u0000${detail.workingRevision}\u0000${detail.anchor}\u0000${detail.focus}`,
        detail.nonce,
      );
      setInteractiveWorkspacePerformanceBookkeeping(
        taskId,
        cursorSampleNonces.current.size,
      );
    };
    window.addEventListener(
      INTERACTIVE_WORKSPACE_REMOTE_CURSOR_NONCE_EVENT,
      arm,
    );
    const unregister = registerInteractiveWorkspaceTaskRoomListener(
      `${taskId}:remote-cursor-nonce`,
    );
    return () => {
      window.removeEventListener(
        INTERACTIVE_WORKSPACE_REMOTE_CURSOR_NONCE_EVENT,
        arm,
      );
      unregister();
      clearInteractiveWorkspacePerformanceBookkeeping(taskId);
    };
  }, [taskId]);
  useLayoutEffect(() => {
    if (
      import.meta.env.MODE !== 'test' &&
      import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !== '1'
    )
      return;
    for (const cursor of remoteCursors) {
      const key = `${cursor.actorId}\u0000${cursor.workingRevision}\u0000${cursor.selection.anchor}\u0000${cursor.selection.focus}`;
      const sampleNonce = cursorSampleNonces.current.get(key);
      if (sampleNonce) {
        cursorSampleNonces.current.delete(key);
        setInteractiveWorkspacePerformanceBookkeeping(
          taskId,
          cursorSampleNonces.current.size,
        );
      }
      emitRemoteCursorCommitPerformanceMark({
        taskId,
        actorId: cursor.actorId,
        workingRevision: cursor.workingRevision,
        anchor: cursor.selection.anchor,
        focus: cursor.selection.focus,
        ...(sampleNonce ? { sampleNonce } : {}),
        committedEpochMs: browserEpochMs(),
      });
    }
  }, [remoteCursors, taskId]);
  useEffect(() => {
    if (!followedCursor || !editorRef.current) return;
    editorRef.current.setSelectionRange(
      followedCursor.selection.anchor,
      followedCursor.selection.focus,
    );
  }, [followedCursor]);
  function stopWatching() {
    if (shared && livePane)
      void shared.command({ command: 'stop', paneId }).catch(() => {});
  }
  function publishCursor(selection: { anchor: number; focus: number }) {
    if (
      !shared?.live?.generation ||
      shared.stream === 'terminal' ||
      !documentRevision
    )
      return;
    const bound = authoritativeText.length;
    void shared
      .command({
        command: 'cursor',
        generation: shared.live.generation,
        workingRevision: documentRevision,
        selection: {
          anchor: Math.min(selection.anchor, bound),
          focus: Math.min(selection.focus, bound),
        },
      })
      .catch(() => {});
  }
  async function adoptSettledText(
    settled: {
      kind: 'committed' | 'duplicate';
      revision: string;
      text: string;
    },
    observedDocument: object,
    settledTaskId: string,
    generation: number,
  ) {
    if (!isCurrentOperation(generation)) return;
    let adopted =
      settled.kind === 'committed'
        ? adoptCommittedProjectTaskRoomDocument(
            queryClient,
            settledTaskId,
            observedDocument,
            {
              kind: 'committed',
              revision: settled.revision,
              text: settled.text,
            },
          )
        : undefined;
    // A duplicate receipt is proof of an earlier exact batch, not authority for
    // the current document. Gaps, missing cache entries, and malformed cache
    // values are likewise resolved only by a no-cache authoritative read.
    if (!adopted) {
      try {
        const refreshed = await refetchAuthoritativeProjectTaskRoomDocument(
          queryClient,
          settledTaskId,
        );
        if (refreshed.kind === 'snapshot' || refreshed.kind === 'delta')
          adopted = refreshed;
      } catch {}
    }
    if (!isCurrentOperation(generation)) return;
    if (!adopted) return;
    setPossibleEffect(undefined);
    authoritativeTextRef.current = adopted.text;
    setRejection(undefined);
    setSettlement(settled.kind);
    setAppliedDocument(adopted);
    setAuthoritativeText(adopted.text);
    setText(adopted.text);
  }
  async function save() {
    if (
      !writable ||
      !dirty ||
      possibleEffect ||
      plan.isPending ||
      batch.isPending
    )
      return;
    const observedDocument = displayedDocument;
    if (
      observedDocument?.kind !== 'snapshot' &&
      observedDocument?.kind !== 'delta'
    )
      return;
    const saveTaskId = taskId;
    const generation = operationGeneration.current;
    if (!isCurrentOperation(generation)) return;
    setRejection(undefined);
    setSettlement(undefined);
    const selection = { anchor: text.length, focus: text.length };
    let intent:
      | {
          intentId: string;
          intentDigest: string;
          observedDocument: object;
        }
      | undefined;
    try {
      const planned = await plan.mutateAsync({
        intentId: randomCorrelationId(),
        desiredText: text,
        selection,
      });
      if (!isCurrentOperation(generation)) return;
      if (planned.kind === 'unchanged') {
        setPossibleEffect(undefined);
        authoritativeTextRef.current = text;
        setAuthoritativeText(text);
        setSettlement('unchanged');
        return;
      }
      if (planned.kind !== 'planned') {
        setPossibleEffect(undefined);
        setRejection(
          planned.reason ??
            (planned.kind === 'refused' || planned.kind === 'rejected'
              ? 'Station refused this edit.'
              : 'Station could not prepare this edit.'),
        );
        return;
      }
      intent = {
        intentId: planned.intentId,
        intentDigest: planned.digest,
        observedDocument,
      };
      setPossibleEffect(intent);
      if (!isCurrentOperation(generation)) return;
      const settled = await batch.mutateAsync({
        intentId: intent.intentId,
        intentDigest: intent.intentDigest,
      });
      if (settled.kind === 'committed' || settled.kind === 'duplicate') {
        await adoptSettledText(
          settled,
          intent.observedDocument,
          saveTaskId,
          generation,
        );
      } else if (settled.kind === 'rejected') {
        if (!isCurrentOperation(generation)) return;
        setPossibleEffect(undefined);
        setRejection(settled.reason ?? 'Station refused this exact edit.');
      }
    } catch {
      if (!isCurrentOperation(generation)) return;
      if (!intent) {
        setPossibleEffect(undefined);
        setRejection('Station could not prepare this edit.');
      }
      /* A submitted exact receipt remains available for identical retry. */
    }
  }
  async function retry() {
    if (!possibleEffect || batch.isPending) return;
    const generation = operationGeneration.current;
    if (!isCurrentOperation(generation)) return;
    try {
      const settled = await batch.mutateAsync({
        intentId: possibleEffect.intentId,
        intentDigest: possibleEffect.intentDigest,
      });
      if (settled.kind === 'committed' || settled.kind === 'duplicate') {
        await adoptSettledText(
          settled,
          possibleEffect.observedDocument,
          taskId,
          generation,
        );
      } else if (settled.kind === 'rejected') {
        if (!isCurrentOperation(generation)) return;
        setPossibleEffect(undefined);
        setRejection(settled.reason ?? 'Station refused this exact edit.');
      }
    } catch {
      /* Keep the identical receipt visible; its effect remains unknown. */
    }
  }
  const status =
    document.isLoading || room.isLoading
      ? 'Loading the shared document.'
      : !authorizationCurrent
        ? 'Task room authorization ended. The last readable document remains read-only.'
        : possibleEffect
          ? 'This exact edit may have taken effect. Retry the identical batch or resync before making another change.'
          : document.isError
            ? 'The shared document could not be loaded. Editing is disabled until a successful resync.'
            : document.data?.kind === 'gap'
              ? 'The shared document is stale. Resync before editing.'
              : document.data?.kind === 'unavailable'
                ? 'The shared document is unavailable. Editing is disabled.'
                : !roomAvailable
                  ? 'The Task room is unavailable. This document is read-only.'
                  : !readable
                    ? 'The shared document is not readable with this room capability.'
                    : !writable
                      ? 'The shared document is readable and read-only.'
                      : settlement === 'unchanged'
                        ? 'No changes were needed; your draft already matches the shared document.'
                        : settlement === 'committed'
                          ? 'Shared document saved.'
                          : settlement === 'duplicate'
                            ? 'This exact edit was already saved.'
                            : rejection
                              ? 'Save refused. Your draft is retained for retry.'
                              : dirty
                                ? 'Unsaved changes.'
                                : 'Shared document ready.';
  return (
    <section className="task-room-editor" aria-label="Task room editor">
      <p id={`task-room-editor-status-${id}`} role="status">
        {status}
      </p>
      {rejection ? (
        <p role="alert">
          {rejection} Draft retained; the shared document was not changed.
        </p>
      ) : null}
      {document.isError ? (
        <p role="alert">The latest shared document read failed.</p>
      ) : null}
      <label htmlFor={`task-room-editor-${id}`}>Task document</label>
      <textarea
        id={`task-room-editor-${id}`}
        ref={editorRef}
        data-station-performance-surface="task-editor"
        data-station-task-id={taskId}
        data-station-working-revision={documentRevision}
        value={text}
        onChange={(event) => {
          const enteredEpochMs = browserEpochMs();
          const nextText = event.currentTarget.value;
          setText(nextText);
          setRejection(undefined);
          setSettlement(undefined);
          stopWatching();
          if (shared)
            void shared
              .command({ command: 'typing', active: true })
              .catch(() => {});
          publishCursor({
            anchor: event.currentTarget.selectionStart,
            focus: event.currentTarget.selectionEnd,
          });
          if (
            documentRevision &&
            (import.meta.env.MODE === 'test' ||
              import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE ===
                '1')
          )
            emitTaskInputPerformanceMark({
              taskId,
              workingRevision: documentRevision,
              text: nextText,
              enteredEpochMs,
              exitedEpochMs: browserEpochMs(),
            });
        }}
        onPointerDown={stopWatching}
        onKeyDown={stopWatching}
        onSelect={(event) =>
          publishCursor({
            anchor: event.currentTarget.selectionStart,
            focus: event.currentTarget.selectionEnd,
          })
        }
        readOnly={!writable}
        aria-describedby={`task-room-editor-status-${id}`}
      />
      <aside aria-label="Remote selections">
        {remoteCursors.length ? (
          <ul>
            {remoteCursors.map((cursor) => {
              const participant = shared?.live?.participants.find(
                (candidate) => candidate.actor.actorId === cursor.actorId,
              );
              return (
                <li key={cursor.actorId} data-actor-id={cursor.actorId}>
                  {participant?.actor.kind === 'agent' ? 'Agent' : 'Human'}{' '}
                  {participant?.actor.label ?? 'participant'}: selection{' '}
                  {cursor.selection.anchor}–{cursor.selection.focus}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>Remote selections appear here.</p>
        )}
      </aside>
      <button
        type="button"
        onClick={() => void document.refetch()}
        disabled={document.isFetching}
      >
        Resync document
      </button>
      <button
        type="button"
        onClick={() => void save()}
        disabled={
          !writable ||
          !dirty ||
          !!possibleEffect ||
          plan.isPending ||
          batch.isPending
        }
      >
        {rejection ? 'Retry save' : 'Save shared document'}
      </button>
      {possibleEffect ? (
        <button
          type="button"
          onClick={() => void retry()}
          disabled={batch.isPending || !authorizationCurrent}
        >
          Retry identical batch
        </button>
      ) : null}
      <DiscardModal />
    </section>
  );
}
