import { describe, expect, it } from 'vitest';
import type {
  VoiceSessionOperationResult,
  VoiceSessionSnapshot,
} from '../voice/session-types.js';
import {
  VOICE_SESSION_LIFECYCLE_STATES,
  VoiceSessionError,
} from '../voice/session-types.js';

describe('VoiceSessionAdapter public contract', () => {
  it('names every provider-neutral lifecycle state', () => {
    expect(VOICE_SESSION_LIFECYCLE_STATES).toEqual([
      'disconnected',
      'connecting',
      'connected-idle',
      'listening',
      'transcribing',
      'thinking',
      'speaking',
      'stopping',
      'error',
    ]);
  });

  it('keeps control and conversation identity separate in revisioned snapshots', () => {
    const snapshot: VoiceSessionSnapshot = {
      state: 'connected-idle',
      revision: 4,
      controlSessionId: 'control-1',
      conversationSessionId: 'conversation-1',
      transcript: 'Hello from the normalized session.',
      transcriptRole: 'user',
      muted: false,
      inputAudioLevel: 0.4,
    };

    expect(snapshot.controlSessionId).not.toBe(snapshot.conversationSessionId);
    expect(snapshot.revision).toBeGreaterThan(0);
    expect(snapshot.transcriptRole).toBe('user');
    expect(snapshot.inputAudioLevel).toBe(0.4);
  });

  it('uses typed unavailable, unsupported, and operation-failed errors', () => {
    const unavailable = new VoiceSessionError('unavailable', 'No adapter');
    const unsupported = new VoiceSessionError('unsupported', 'No interrupt');
    const failed = new VoiceSessionError('operation-failed', 'Provider failed');
    const result: VoiceSessionOperationResult = {
      ok: false,
      error: unavailable,
    };

    expect([unavailable.code, unsupported.code, failed.code]).toEqual([
      'unavailable',
      'unsupported',
      'operation-failed',
    ]);
    expect(result.ok).toBe(false);
  });
});
