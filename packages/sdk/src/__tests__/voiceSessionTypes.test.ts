import { describe, expect, it } from 'vitest';
import { VOICE_SESSION_LIFECYCLE_STATES } from '../voice/session-types.js';

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
});
