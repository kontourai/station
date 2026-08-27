import { describe, expect, it } from 'vitest';
import type {
  VoiceSessionAdapter,
  VoiceSessionOperationResult,
  VoiceSessionSnapshot,
} from '../voice/session-types.js';
import { VoiceSessionError } from '../voice/session-types.js';
import {
  createSyntheticVoiceSessionAdapter,
  runVoiceSessionAdapterConformance,
} from '../voice/testing.js';

describe('voice-session conformance helpers', () => {
  it('provides a controllable synthetic adapter with immutable snapshots and deferred lifecycle operations', async () => {
    const adapter = createSyntheticVoiceSessionAdapter({
      descriptor: { id: 'synthetic', name: 'Synthetic' },
      capabilities: { interrupt: true, updateContext: true, textTurn: true },
      deferredOperations: ['start', 'stop'],
    });

    const start = adapter.start({
      controlSessionId: 'control-1',
      conversationSessionId: 'conversation-1',
    });
    expect(adapter.calls).toEqual([
      {
        operation: 'start',
        input: {
          controlSessionId: 'control-1',
          conversationSessionId: 'conversation-1',
        },
      },
    ]);
    expect(adapter.getSnapshot()).toMatchObject({
      state: 'connecting',
      revision: 1,
      controlSessionId: 'control-1',
      conversationSessionId: 'conversation-1',
    });
    expect(Object.isFrozen(adapter.getSnapshot())).toBe(true);

    adapter.resolveDeferred('start');
    await expect(start).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'connected-idle', revision: 2 },
    });

    const stop = adapter.stop();
    expect(adapter.getSnapshot()).toMatchObject({
      state: 'stopping',
      revision: 3,
    });
    adapter.resolveDeferred('stop');
    await expect(stop).resolves.toMatchObject({
      ok: true,
      snapshot: { state: 'disconnected', revision: 4 },
    });
    expect(adapter.calls.map((call) => call.operation)).toEqual([
      'start',
      'stop',
    ]);
  });

  it('accepts a conformant adapter fixture across lifecycle, revision, identity, and optional-capability behavior', async () => {
    const adapter = createSyntheticVoiceSessionAdapter({
      descriptor: { id: 'conformant', name: 'Conformant' },
      capabilities: { interrupt: true, updateContext: true, textTurn: true },
    });

    const report = await runVoiceSessionAdapterConformance({
      adapter,
      exercise: () => {
        adapter.emit({ state: 'listening' });
        adapter.emit({ state: 'transcribing' });
        adapter.emit({ state: 'thinking' });
        adapter.emit({ state: 'speaking' });
        adapter.emit({
          state: 'error',
          error: new VoiceSessionError('operation-failed', 'synthetic failure'),
        });
      },
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.snapshots.map((snapshot) => snapshot.state)).toEqual([
      'disconnected',
      'connecting',
      'connected-idle',
      'listening',
      'transcribing',
      'thinking',
      'speaking',
      'error',
      'stopping',
      'disconnected',
    ]);
    expect(adapter.calls.map((call) => call.operation)).toEqual([
      'start',
      'interrupt',
      'update-context',
      'send-text',
      'stop',
    ]);
  });

  it('accepts staged control and conversation identity acquisition', async () => {
    let snapshot: VoiceSessionSnapshot = Object.freeze({
      state: 'disconnected',
      revision: 0,
    });
    let listener: (() => void) | undefined;
    const emit = (next: Omit<VoiceSessionSnapshot, 'revision'>) => {
      snapshot = Object.freeze({
        ...next,
        revision: snapshot.revision + 1,
      });
      listener?.();
      return snapshot;
    };
    const adapter: VoiceSessionAdapter = {
      descriptor: { id: 'staged', name: 'Staged identity' },
      capabilities: {},
      getSnapshot: () => snapshot,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      start: async (input) => ({
        ok: true,
        snapshot: emit({
          state: 'connecting',
          ...(input?.controlSessionId
            ? { controlSessionId: input.controlSessionId }
            : {}),
        }),
      }),
      stop: async () => ({
        ok: true,
        snapshot: emit({ state: 'disconnected' }),
      }),
    };

    const report = await runVoiceSessionAdapterConformance({
      adapter,
      exercise: () => {
        emit({
          state: 'connected-idle',
          conversationSessionId: 'conformance-conversation-session',
        });
        emit({ state: 'listening' });
        emit({ state: 'transcribing' });
        emit({ state: 'thinking' });
        emit({ state: 'speaking' });
        emit({
          state: 'error',
          error: new VoiceSessionError('operation-failed', 'expected'),
        });
        emit({ state: 'stopping' });
      },
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('reports a deliberately non-conformant fixture without depending on Vitest at runtime', async () => {
    let snapshot: VoiceSessionSnapshot = {
      state: 'disconnected',
      revision: 0,
    };
    let listener: (() => void) | undefined;
    const success = (): VoiceSessionOperationResult => ({
      ok: true,
      snapshot,
    });
    const adapter: VoiceSessionAdapter = {
      descriptor: { id: 'broken', name: 'Broken' },
      capabilities: { interrupt: true },
      getSnapshot: () => snapshot,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      start: async () => {
        snapshot = {
          state: 'connected-idle',
          revision: 0,
          controlSessionId: 'same-id',
          conversationSessionId: 'same-id',
        };
        listener?.();
        return success();
      },
      stop: async () => success(),
    };

    const report = await runVoiceSessionAdapterConformance({
      adapter,
      exercise: () => undefined,
    });

    expect(report.ok).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'capability-method-mismatch',
        'snapshot-not-frozen',
        'snapshot-revision-not-monotonic',
        'identity-not-distinct',
        'missing-lifecycle-state',
      ]),
    );
  });
});
