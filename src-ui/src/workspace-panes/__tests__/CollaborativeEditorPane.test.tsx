/** @vitest-environment jsdom */

import {
  COLLABORATIVE_ROOM_SCHEMA_VERSION,
  type CollaborativeCapabilities,
  CollaborativeEditorPaneController,
  type CollaborativeOperation,
  type CollaborativeParticipant,
} from '@shared/collaborative-editor-pane';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { SHARED_WORKING_STATE_SCHEMA_VERSION } from '../../../../src-server/domain/shared-working-state.js';
import {
  CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION,
  CollaborativeEditorPane,
  collaborativeDecorationSegments,
} from '../CollaborativeEditorPane';

const NOW = 10_000;
const scope = {
  projectId: 'project-a',
  taskId: 'task-a',
  documentId: 'document-a',
};
const liveCapabilities: CollaborativeCapabilities = {
  document: { read: true, write: true },
  room: { join: true, read: true, share: true, watch: true, follow: true },
};

function operation(
  operationId: string,
  actorId: string,
  kind: 'human' | 'agent',
): CollaborativeOperation {
  return {
    schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
    operationId,
    documentId: scope.documentId,
    replicaId: `replica-${actorId}`,
    actor: { actorId, kind },
    parents: [],
    authorizationEpoch: 1,
    kind: 'insert',
    after: null,
    text: 'x',
  };
}

function participant(
  actorId: string,
  kind: 'human' | 'agent',
): CollaborativeParticipant {
  return {
    actorId,
    kind,
    label: actorId === 'agent-b' ? 'Codex' : 'Ari',
    surface: {
      state: 'shared-project-task',
      projectId: scope.projectId,
      taskId: scope.taskId,
    },
    expiresAt: NOW + 1_000,
    ...(kind === 'agent'
      ? { agentSessionId: 'session/9', runId: 'run/2' }
      : {}),
    followableView: {
      paneId: `pane-${actorId}`,
      documentId: scope.documentId,
      workingStateRevision: 'working-1',
      selection: { anchor: 1, focus: 2 },
      viewportAnchor: 1,
    },
  };
}

function installMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: (_type: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function createController(
  capabilities: CollaborativeCapabilities = liveCapabilities,
  transportOutcome: 'committed' | 'indeterminate' | 'refused' = 'committed',
) {
  let roomListener: ((update: unknown) => void) | null = null;
  let local = 0;
  const optimisticText = new Map<string, string>();
  const publish = vi.fn(() => ({ outcome: 'accepted' }));
  const navigate = vi.fn(() => ({ outcome: 'accepted' }));
  const submit = vi.fn(async (batch: { intentId: string; digest: string }) =>
    transportOutcome === 'committed'
      ? { outcome: 'accepted', intentId: batch.intentId, digest: batch.digest }
      : {
          outcome: transportOutcome,
          intentId: batch.intentId,
          digest: batch.digest,
          reason:
            transportOutcome === 'indeterminate'
              ? 'post-commit outcome unknown'
              : 'refused',
        },
  );
  const controller = new CollaborativeEditorPaneController({
    paneId: 'duplicate-pane-id',
    scope,
    localActorId: 'human-a',
    correlationId: 'correlation-a',
    authority: {
      current: () => ({
        state: 'AVAILABLE',
        authorityRevision: 'authority-1',
        actorId: 'human-a',
        scope,
        capabilities,
      }),
    },
    principalAuthority: {
      resolve: ({ actorId, scope: principalScope, workingStateRevision }) => ({
        state: 'AVAILABLE',
        actorId,
        kind: actorId === 'agent-b' ? 'agent' : 'human',
        label: actorId === 'agent-b' ? 'Codex' : 'Ari',
        scope: principalScope,
        workingStateRevision,
        ...(actorId === 'agent-b'
          ? { agentSessionId: 'session/9', runId: 'run/2' }
          : {}),
      }),
    },
    targetProjectionAuthority: {
      resolve: ({ scope: targetScope, workingStateRevision }) => ({
        state: 'AVAILABLE',
        scope: targetScope,
        workingStateRevision,
        textLength: 10_000,
      }),
    },
    navigationCapabilityAuthority: {
      mint: ({ authorityRevision, actorId, reason }) => ({
        state: 'AVAILABLE',
        capability: `cap:${authorityRevision}:${actorId}:${reason}`,
      }),
    },
    roomStreamAuthority: {
      current: () => ({
        state: 'AVAILABLE',
        scope,
        generation: 1,
        epoch: 'room-epoch-1',
      }),
    },
    convergence: {
      projection: () => ({
        outcome: 'available',
        projection: {
          scope,
          text: 'base',
          workingStateRevision: 'working-1',
        },
      }),
      applyAccepted: (entry: CollaborativeOperation) => ({
        outcome: 'applied',
        operationId: entry.operationId,
        operationDeferred: false,
        releasedOperationIds: [],
        projection: {
          scope,
          text: 'base',
          workingStateRevision: 'working-1',
        },
      }),
      resync: async () => ({
        outcome: 'available',
        projection: {
          scope,
          text: 'base',
          workingStateRevision: 'working-1',
        },
      }),
    },
    editing: {
      plan: ({ desiredText, selection }) => {
        const sequence = ++local;
        const intentId = `intent-${sequence}`;
        optimisticText.set(intentId, desiredText);
        return {
          outcome: 'planned',
          batch: {
            intentId,
            digest: 'b'.repeat(64),
            baseRevision: 'working-1',
            operations: [operation(`local-${sequence}`, 'human-a', 'human')],
            optimistic: {
              text: desiredText,
              workingStateRevision: `optimistic-${sequence}`,
            },
            selection,
          },
        };
      },
      projectPending: ({ pending }) => {
        const last = pending.at(-1);
        return {
          outcome: 'projected',
          text: last ? (optimisticText.get(last.intentId) ?? 'base') : 'base',
          workingStateRevision: last
            ? `optimistic-${last.intentId}`
            : 'working-1',
        };
      },
      transformSelection: ({ selection, pending }) => {
        const last = pending.at(-1);
        const text = last
          ? (optimisticText.get(last.intentId) ?? 'base')
          : 'base';
        const shift = text.length - 'base'.length;
        return {
          outcome: 'projected',
          text,
          workingStateRevision: last
            ? `optimistic-${last.intentId}`
            : 'working-1',
          selection: {
            anchor: selection.anchor + shift,
            focus: selection.focus + shift,
          },
        };
      },
    },
    transport: {
      submitBatch: submit,
    },
    room: {
      subscribe: (listener) => {
        roomListener = listener;
        return () => {
          roomListener = null;
        };
      },
    },
    cursorOutput: { maxPerSecond: 20, publish },
    host: {
      joinAndNavigate: navigate,
      requestSurfaceJoin: () => ({ outcome: 'accepted' }),
      share: () => ({ outcome: 'accepted' }),
    },
    revisionResolver: {
      resolve: async () => ({ state: 'UNAVAILABLE', reason: 'not configured' }),
    },
    now: () => NOW,
  });
  const emitPresence = () =>
    roomListener?.({
      schemaVersion: COLLABORATIVE_ROOM_SCHEMA_VERSION,
      kind: 'snapshot',
      generation: 1,
      epoch: 'room-epoch-1',
      sequence: 1,
      scope,
      connection: 'connected',
      participants: [
        participant('human-other', 'human'),
        participant('agent-b', 'agent'),
      ],
      cursors: [
        {
          actorId: 'agent-b',
          workingStateRevision: 'working-1',
          selection: { anchor: 1, focus: 3 },
          expiresAt: NOW + 1_000,
        },
      ],
      departedActorIds: [],
    });
  return {
    controller,
    emitPresence,
    emitRoom: (update: unknown) => roomListener?.(update),
    publish,
    navigate,
    submit,
  };
}

describe('CollaborativeEditorPane', () => {
  test('merges coincident carets into one stable actor-keyed decoration', () => {
    const segments = collaborativeDecorationSegments('base', [
      {
        actorId: 'z-actor',
        workingStateRevision: 'working-1',
        selection: { anchor: 2, focus: 2 },
        expiresAt: NOW + 1_000,
      },
      {
        actorId: 'a-actor',
        workingStateRevision: 'working-1',
        selection: { anchor: 2, focus: 2 },
        expiresAt: NOW + 1_000,
      },
    ]);
    expect(segments.filter((segment) => segment.start === segment.end)).toEqual(
      [
        {
          start: 2,
          end: 2,
          text: '',
          actorIds: ['a-actor', 'z-actor'],
        },
      ],
    );
  });

  test('renders real remote selection and accepted-op human/agent attribution with canonical links', () => {
    installMatchMedia(false);
    const h = createController();
    h.emitPresence();
    h.controller.dispatch({
      type: 'remote-accepted',
      operation: operation('remote-agent', 'agent-b', 'agent'),
    });
    render(
      <CollaborativeEditorPane
        controller={h.controller}
        referenceNavigation={CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION}
      />,
    );
    const decoration = document.querySelector<HTMLElement>(
      'mark[data-actor-ids="agent-b"]',
    );
    expect(decoration).toBeTruthy();
    expect(decoration?.textContent).toBe('as');
    const overlays = document.querySelectorAll<HTMLPreElement>(
      'pre[data-overlay-document-copies="1"]',
    );
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.textContent).toBe('base');
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Shared text or code',
    });
    Object.defineProperty(editor, 'scrollTop', {
      configurable: true,
      value: 24,
    });
    Object.defineProperty(editor, 'scrollLeft', {
      configurable: true,
      value: 7,
    });
    fireEvent.scroll(editor);
    expect(overlays[0]?.scrollTop).toBe(24);
    expect(overlays[0]?.scrollLeft).toBe(7);
    expect(screen.getAllByText('Agent Codex')).toHaveLength(2);
    expect(
      screen
        .getByRole('link', { name: 'View agent session' })
        .getAttribute('href'),
    ).toBe('/?surface=activity&session=session%2F9');
    expect(
      screen.getByRole('link', { name: 'View agent run' }).getAttribute('href'),
    ).toBe('/projects/project-a/flow-console?run=run%2F2');
    expect(
      document.querySelector('[data-operation-id="remote-agent"]')?.textContent,
    ).toContain('Agent Codex');
    expect(document.body.textContent).not.toContain('/Users/');
  });

  test('preserves native selection and exits actual follow on keyboard, pointer, selection, and edit', () => {
    installMatchMedia(false);
    const h = createController();
    h.emitPresence();
    h.controller.dispatch({ type: 'follow', actorId: 'agent-b' });
    render(
      <CollaborativeEditorPane
        controller={h.controller}
        referenceNavigation={CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION}
      />,
    );
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Shared text or code',
    });
    expect(h.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'follow', targetActorId: 'agent-b' }),
    );
    fireEvent.keyDown(editor, { key: 'ArrowRight' });
    expect(h.controller.snapshot().watch).toMatchObject({ following: false });
    h.controller.dispatch({ type: 'follow', actorId: 'agent-b' });
    fireEvent.pointerDown(editor);
    expect(h.controller.snapshot().watch).toMatchObject({ following: false });
    h.controller.dispatch({ type: 'follow', actorId: 'agent-b' });
    fireEvent.select(editor, {
      target: { selectionStart: 1, selectionEnd: 2 },
    });
    expect(h.controller.snapshot().watch).toMatchObject({ following: false });
    expect(h.publish).toHaveBeenCalled();
    fireEvent.change(editor, {
      target: { value: 'edit', selectionStart: 2, selectionEnd: 2 },
    });
    expect(editor.value).toBe('edit');
    fireEvent.click(screen.getByRole('button', { name: 'Stop watching' }));
    expect(h.controller.snapshot().watch).toEqual({ state: 'off' });
  });

  test('keeps textarea and one decoration overlay on the same optimistic text and mapped range', async () => {
    installMatchMedia(false);
    const h = createController();
    h.emitPresence();
    render(
      <CollaborativeEditorPane
        controller={h.controller}
        referenceNavigation={CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION}
      />,
    );
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Shared text or code',
    });
    await act(async () => {
      fireEvent.change(editor, {
        target: { value: 'Xbase', selectionStart: 1, selectionEnd: 1 },
      });
      await Promise.resolve();
    });
    const overlay = document.querySelector<HTMLPreElement>(
      'pre[data-overlay-document-copies="1"]',
    );
    expect(editor.value).toBe('Xbase');
    expect(overlay?.textContent).toBe('Xbase');
    expect(overlay?.querySelector('mark')?.textContent).toBe('as');
    expect(h.controller.snapshot().displayCursors[0]?.selection).toEqual({
      anchor: 2,
      focus: 4,
    });
  });

  test('renders exact indeterminate possible-effect state and retries the identical intent batch', async () => {
    installMatchMedia(false);
    const h = createController(liveCapabilities, 'indeterminate');
    render(
      <CollaborativeEditorPane
        controller={h.controller}
        referenceNavigation={CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION}
      />,
    );
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Shared text or code',
    });
    await act(async () => {
      fireEvent.change(editor, {
        target: { value: 'draft', selectionStart: 2, selectionEnd: 2 },
      });
      await Promise.resolve();
    });
    expect(document.querySelector('[data-intent-id]')?.textContent).toContain(
      'Outcome unknown.',
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Retry identical batch' }),
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(2));
    expect(h.submit.mock.calls[0]?.[0]).toEqual(h.submit.mock.calls[1]?.[0]);
    expect(Object.isFrozen(h.submit.mock.calls[0]?.[0])).toBe(true);
  });

  test('retains canonical accepted-agent session/run links after roster departure', () => {
    installMatchMedia(false);
    const h = createController();
    h.emitPresence();
    h.controller.dispatch({
      type: 'remote-accepted',
      operation: operation('remote-agent', 'agent-b', 'human'),
    });
    h.emitRoom({
      schemaVersion: COLLABORATIVE_ROOM_SCHEMA_VERSION,
      kind: 'delta',
      generation: 1,
      epoch: 'room-epoch-1',
      sequence: 2,
      scope,
      connection: 'connected',
      participants: [],
      cursors: [],
      departedActorIds: ['agent-b'],
    });
    render(
      <CollaborativeEditorPane
        controller={h.controller}
        referenceNavigation={CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION}
      />,
    );
    expect(screen.queryByText('View agent session')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Edit session' }).getAttribute('href'),
    ).toBe('/?surface=activity&session=session%2F9');
    expect(
      screen.getByRole('link', { name: 'Edit run' }).getAttribute('href'),
    ).toBe('/projects/project-a/flow-console?run=run%2F2');
    expect(document.querySelector('[data-actor-kind="agent"]')).toBeTruthy();
  });

  test('uses unique per-render IDs even when two pane controllers share a persisted pane ID', () => {
    installMatchMedia(false);
    const left = createController();
    const right = createController();
    render(
      <>
        <CollaborativeEditorPane
          controller={left.controller}
          referenceNavigation={CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION}
        />
        <CollaborativeEditorPane
          controller={right.controller}
          referenceNavigation={CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION}
        />
      </>,
    );
    const editors = screen.getAllByRole('textbox', {
      name: 'Shared text or code',
    });
    const described = editors.map((entry) =>
      entry.getAttribute('aria-describedby'),
    );
    expect(new Set(described).size).toBe(2);
    expect(
      document.querySelectorAll('[data-pane-id="duplicate-pane-id"]'),
    ).toHaveLength(2);
  });

  test.each([
    {
      capabilities: {
        document: { read: true, write: true },
        room: {
          join: false,
          read: false,
          share: false,
          watch: false,
          follow: false,
        },
      },
      copy: 'Solo editing',
      readOnly: false,
    },
    {
      capabilities: {
        ...liveCapabilities,
        document: { read: true, write: false },
      },
      copy: 'Read-only',
      readOnly: true,
    },
    {
      capabilities: {
        ...liveCapabilities,
        document: { read: false, write: false },
      },
      copy: 'unavailable',
      readOnly: true,
    },
  ])(
    'renders truthful $copy document usability',
    ({ capabilities, copy, readOnly }) => {
      installMatchMedia(false);
      const h = createController(capabilities);
      render(
        <CollaborativeEditorPane
          controller={h.controller}
          referenceNavigation={CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION}
        />,
      );
      expect(screen.getByRole('status').textContent).toContain(copy);
      expect(
        screen.getByRole<HTMLTextAreaElement>('textbox', {
          name: 'Shared text or code',
        }).readOnly,
      ).toBe(readOnly);
    },
  );

  test('switches remote decoration behavior to the real instant reduced-motion contract', () => {
    installMatchMedia(true);
    const h = createController();
    h.emitPresence();
    render(
      <CollaborativeEditorPane
        controller={h.controller}
        referenceNavigation={CANONICAL_COLLABORATIVE_REFERENCE_NAVIGATION}
      />,
    );
    const pane = document.querySelector<HTMLElement>(
      '.collaborative-editor-pane--reduced-motion',
    );
    const decorationOwner = document.querySelector<HTMLElement>(
      '[data-overlay-document-copies="1"]',
    );
    const decoration = document.querySelector<HTMLElement>(
      '.collaborative-editor-pane__remote-selection',
    );
    expect(pane?.dataset.motion).toBe('instant');
    expect(decorationOwner?.dataset.motion).toBe('instant');
    expect(decoration?.style.transition).toBe('none');
  });
});
