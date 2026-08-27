import {
  type CollaborativeActorKind,
  type CollaborativeEditorPaneController,
  type CollaborativePaneState,
} from '@shared/collaborative-editor-pane';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import './CollaborativeEditorPane.css';

const MODE_COPY: Record<CollaborativePaneState['mode'], string> = {
  solo: 'Solo editing. The document is usable without a live room.',
  live: 'Live collaboration connected.',
  pending:
    'Document operations have possible effects. Review their exact status or resync.',
  'rejected-write':
    'A write was rejected. The shared document remains readable.',
  'read-only': 'Read-only. You can continue reading but cannot write.',
  resyncing: 'Resyncing exact shared document truth.',
  stale: 'This view may be stale. Retry resync before editing.',
  unavailable: 'This document is unavailable with the current authority.',
};

export interface CollaborativeReferenceNavigation {
  sessionHref(sessionId: string): string;
  runHref(projectId: string, runId: string): string;
}

/** Canonical Station routes remain injected so native hosts can replace them. */
export const CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION: CollaborativeReferenceNavigation =
  Object.freeze({
    sessionHref: (sessionId: string) =>
      `/activity?session=${encodeURIComponent(sessionId)}`,
    runHref: (projectId: string, runId: string) =>
      `/projects/${encodeURIComponent(projectId)}/flow-console?run=${encodeURIComponent(runId)}`,
  });

function usePaneState(controller: CollaborativeEditorPaneController) {
  const [state, setState] = useState(() => controller.snapshot());
  useEffect(() => {
    setState(controller.snapshot());
    return controller.subscribe(() => setState(controller.snapshot()));
  }, [controller]);
  return state;
}

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const read = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

function participantLabel(kind: CollaborativeActorKind, label: string): string {
  return kind === 'agent' ? `Agent ${label}` : `Human ${label}`;
}

export interface CollaborativeDecorationSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly actorIds: readonly string[];
}

export function collaborativeDecorationSegments(
  text: string,
  cursors: CollaborativePaneState['cursors'],
): readonly CollaborativeDecorationSegment[] {
  const boundaries = new Set([0, text.length]);
  for (const cursor of cursors) {
    boundaries.add(Math.min(cursor.selection.anchor, cursor.selection.focus));
    boundaries.add(Math.max(cursor.selection.anchor, cursor.selection.focus));
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const ranges = ordered.slice(0, -1).map((start, index) => {
    const end = ordered[index + 1];
    return {
      start,
      end,
      text: text.slice(start, end),
      actorIds: cursors
        .filter((cursor) => {
          const low = Math.min(cursor.selection.anchor, cursor.selection.focus);
          const high = Math.max(
            cursor.selection.anchor,
            cursor.selection.focus,
          );
          return low < end && high > start;
        })
        .map((cursor) => cursor.actorId)
        .sort(),
    };
  });
  const coincident = new Map<number, string[]>();
  for (const cursor of cursors)
    if (cursor.selection.anchor === cursor.selection.focus) {
      const actors = coincident.get(cursor.selection.anchor) ?? [];
      actors.push(cursor.actorId);
      coincident.set(cursor.selection.anchor, actors);
    }
  const carets = [...coincident.entries()].map(([offset, actorIds]) => ({
    start: offset,
    end: offset,
    text: '',
    actorIds: [...new Set(actorIds)].sort(),
  }));
  return [...ranges, ...carets].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
}

/** Thin accessible projection over the host-neutral deep controller Module. */
export function CollaborativeEditorPane({
  controller,
  referenceNavigation,
  ariaLabel = 'Collaborative code editor',
}: {
  controller: CollaborativeEditorPaneController;
  referenceNavigation: CollaborativeReferenceNavigation;
  ariaLabel?: string;
}) {
  const state = usePaneState(controller);
  const instanceId = useId().replaceAll(':', '');
  const statusId = `collaborative-editor-status-${instanceId}`;
  const decorationId = `collaborative-editor-decorations-${instanceId}`;
  const editorId = `collaborative-editor-${instanceId}`;
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLPreElement | null>(null);
  const reducedMotion = useReducedMotion();
  const editable =
    state.capabilities.document.write &&
    !['read-only', 'resyncing', 'stale', 'unavailable'].includes(state.mode);
  const decorationSegments = useMemo(
    () =>
      collaborativeDecorationSegments(state.displayText, state.displayCursors),
    [state.displayText, state.displayCursors],
  );

  return (
    <section
      className={`collaborative-editor-pane${reducedMotion ? ' collaborative-editor-pane--reduced-motion' : ''}`}
      aria-label={ariaLabel}
      data-pane-id={controller.paneId}
      data-motion={reducedMotion ? 'instant' : 'animated'}
    >
      <header className="collaborative-editor-pane__toolbar">
        <p role="status" aria-live="polite">
          {MODE_COPY[state.mode]}
        </p>
        <span>
          Room {state.roomConnection}. Revision{' '}
          {state.authoritative.workingStateRevision}.
        </span>
        <button
          type="button"
          onClick={() => controller.dispatch({ type: 'resync' })}
          disabled={
            !state.capabilities.document.read || state.mode === 'resyncing'
          }
        >
          Resync document
        </button>
      </header>

      {state.rejectedWrites.length > 0 ? (
        <div role="alert" aria-label="Rejected document writes">
          {state.rejectedWrites.map((rejection) => (
            <p key={rejection.operationId}>
              {rejection.reason}{' '}
              <button
                type="button"
                onClick={() =>
                  controller.dispatch({
                    type: 'dismiss-rejection',
                    operationId: rejection.operationId,
                  })
                }
              >
                Dismiss
              </button>
            </p>
          ))}
        </div>
      ) : null}
      {state.lastUnavailable ? (
        <p role="alert">{state.lastUnavailable}</p>
      ) : null}

      {state.pendingIntents.length > 0 ? (
        <section aria-label="Pending document effects">
          <h3>Pending document effects</h3>
          <ul>
            {state.pendingIntents.map((intent) => (
              <li key={intent.intentId} data-intent-id={intent.intentId}>
                {intent.states.indeterminate > 0
                  ? 'Outcome unknown.'
                  : intent.states.committedAwaitingProjection > 0
                    ? 'Saved. Waiting for everyone else to see it.'
                    : intent.states.possibleEffect > 0
                      ? 'Sending exact operation batch.'
                      : 'Reconciling partial batch.'}
                {intent.reason ? ` ${intent.reason}` : ''}
                {intent.states.indeterminate > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      controller.dispatch({
                        type: 'retry-pending',
                        intentId: intent.intentId,
                      })
                    }
                  >
                    Retry identical batch
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="collaborative-editor-pane__editor-stack">
        <label
          className="collaborative-editor-pane__editor-label"
          htmlFor={editorId}
        >
          Shared text or code
        </label>
        <div className="collaborative-editor-pane__editor-surface">
          <textarea
            id={editorId}
            ref={editorRef}
            aria-label="Shared text or code"
            aria-describedby={`${statusId} ${decorationId}`}
            value={state.displayText}
            readOnly={!editable}
            onChange={(event) =>
              controller.dispatch({
                type: 'local-input',
                text: event.currentTarget.value,
                selection: {
                  anchor: event.currentTarget.selectionStart,
                  focus: event.currentTarget.selectionEnd,
                },
              })
            }
            onPointerDown={() =>
              controller.dispatch({
                type: 'local-interaction',
                kind: 'pointer',
              })
            }
            onKeyDown={() =>
              controller.dispatch({
                type: 'local-interaction',
                kind: 'navigation',
              })
            }
            onSelect={(event) =>
              controller.dispatch({
                type: 'local-selection',
                selection: {
                  anchor: event.currentTarget.selectionStart,
                  focus: event.currentTarget.selectionEnd,
                },
              })
            }
            onScroll={(event) => {
              if (!overlayRef.current) return;
              overlayRef.current.scrollTop = event.currentTarget.scrollTop;
              overlayRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }}
          />
          <pre
            ref={overlayRef}
            className="collaborative-editor-pane__decorations"
            aria-hidden="true"
            data-overlay-document-copies="1"
            data-motion={reducedMotion ? 'instant' : 'animated'}
          >
            {decorationSegments.map((segment) =>
              segment.actorIds.length > 0 ? (
                <mark
                  key={`${segment.start}:${segment.end}:${segment.actorIds.join(',')}`}
                  className="collaborative-editor-pane__remote-selection"
                  data-actor-ids={segment.actorIds.join(',')}
                  data-caret={
                    segment.start === segment.end ? 'true' : undefined
                  }
                  style={reducedMotion ? { transition: 'none' } : undefined}
                >
                  {segment.text}
                </mark>
              ) : (
                <span key={`${segment.start}:${segment.end}`}>
                  {segment.text}
                </span>
              ),
            )}
          </pre>
        </div>
        <p id={decorationId} className="sr-only">
          {Math.min(state.displayCursors.length, 64)} remote selection
          {state.displayCursors.length === 1 ? '' : 's'}.
        </p>
      </div>

      <p id={statusId} className="sr-only">
        {MODE_COPY[state.mode]} Working-state revision{' '}
        {state.authoritative.workingStateRevision}.
      </p>

      {state.acceptedAttributions.length > 0 ? (
        <section aria-label="Accepted edit attribution">
          <h3>Accepted edits</h3>
          <ul>
            {state.acceptedAttributions.map((attribution) => {
              return (
                <li
                  key={attribution.operationId}
                  data-operation-id={attribution.operationId}
                  data-actor-kind={attribution.kind}
                >
                  {participantLabel(attribution.kind, attribution.label)}
                  {attribution.agentSessionId ? (
                    <a
                      href={referenceNavigation.sessionHref(
                        attribution.agentSessionId,
                      )}
                    >
                      Edit session
                    </a>
                  ) : null}
                  {attribution.runId ? (
                    <a
                      href={referenceNavigation.runHref(
                        controller.scope.projectId,
                        attribution.runId,
                      )}
                    >
                      Edit run
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <aside
        className="collaborative-editor-pane__presence"
        aria-label="People in this editor"
      >
        <h3>In this editor</h3>
        {state.participants.length === 0 ? (
          <p>Awaiting other participants.</p>
        ) : null}
        <ul>
          {state.participants.map((participant) => (
            <li key={participant.actorId}>
              <strong>
                {participantLabel(participant.kind, participant.label)}
              </strong>
              {participant.kind === 'agent' && participant.agentSessionId ? (
                <a
                  href={referenceNavigation.sessionHref(
                    participant.agentSessionId,
                  )}
                >
                  View agent session
                </a>
              ) : null}
              {participant.kind === 'agent' && participant.runId ? (
                <a
                  href={referenceNavigation.runHref(
                    controller.scope.projectId,
                    participant.runId,
                  )}
                >
                  View agent run
                </a>
              ) : null}
              <span>
                {participant.surface.state === 'shared-project-task'
                  ? ' In this shared Project and Task.'
                  : participant.surface.state === 'authorized-unshared'
                    ? ' In an authorized, unshared surface.'
                    : ' Location outside this shared work is undisclosed.'}
              </span>
              <div>
                <button
                  type="button"
                  disabled={!participant.followableView}
                  onClick={() =>
                    controller.dispatch({
                      type: 'jump',
                      actorId: participant.actorId,
                    })
                  }
                >
                  Jump to {participant.label}
                </button>
                <button
                  type="button"
                  disabled={
                    !state.capabilities.room.watch ||
                    !participant.followableView
                  }
                  onClick={() =>
                    controller.dispatch({
                      type: 'watch',
                      actorId: participant.actorId,
                    })
                  }
                >
                  Watch {participant.label}
                </button>
                <button
                  type="button"
                  disabled={
                    !state.capabilities.room.follow ||
                    !participant.followableView
                  }
                  onClick={() =>
                    controller.dispatch({
                      type: 'follow',
                      actorId: participant.actorId,
                    })
                  }
                >
                  Follow {participant.label}
                </button>
                {participant.surface.state === 'authorized-unshared' ? (
                  <button
                    type="button"
                    disabled={!state.capabilities.room.join}
                    onClick={() =>
                      controller.dispatch({
                        type: 'request-surface-join',
                        actorId: participant.actorId,
                      })
                    }
                  >
                    Request to join {participant.label}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {state.watch.state === 'active' && state.watch.following ? (
          <button
            type="button"
            onClick={() => controller.dispatch({ type: 'unfollow' })}
          >
            Stop following
          </button>
        ) : null}
        {state.watch.state !== 'off' ? (
          <button
            type="button"
            onClick={() => controller.dispatch({ type: 'stop-watch' })}
          >
            Stop watching
          </button>
        ) : null}
        {state.watch.state === 'paused' ? (
          <p role="status">Watching is paused: {state.watch.reason}.</p>
        ) : null}
      </aside>
    </section>
  );
}
