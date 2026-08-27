import { describe, expect, it } from 'vitest';
import { FinalVoiceEndpointDetector } from '../voice/endpoint-detector.js';

describe('FinalVoiceEndpointDetector', () => {
  it('emits exactly one utterance for repeated finals in an input epoch', () => {
    const detector = new FinalVoiceEndpointDetector();
    expect(
      detector.consume({ type: 'interim', epoch: 1, transcript: 'hello' }),
    ).toBeUndefined();
    expect(
      detector.consume({ type: 'final', epoch: 1, transcript: 'hello world' }),
    ).toEqual({
      epoch: 1,
      transcript: 'hello world',
    });
    expect(
      detector.consume({ type: 'final', epoch: 1, transcript: 'hello world' }),
    ).toBeUndefined();
    expect(
      detector.consume({ type: 'final', epoch: 2, transcript: 'next turn' }),
    ).toEqual({
      epoch: 2,
      transcript: 'next turn',
    });
  });

  it('bounds duplicate epoch memory while rejecting replays after eviction', () => {
    const detector = new FinalVoiceEndpointDetector({ completedEpochLimit: 2 });
    detector.consume({ type: 'final', epoch: 1, transcript: 'one' });
    detector.consume({ type: 'final', epoch: 2, transcript: 'two' });
    detector.consume({ type: 'final', epoch: 3, transcript: 'three' });
    expect(detector.completedEpochCount).toBe(2);
    expect(
      detector.consume({ type: 'final', epoch: 3, transcript: 'three' }),
    ).toBeUndefined();
    expect(
      detector.consume({ type: 'final', epoch: 1, transcript: 'replayed' }),
    ).toBeUndefined();
  });

  it('rejects invalid duplicate-retention limits', () => {
    expect(
      () => new FinalVoiceEndpointDetector({ completedEpochLimit: 0 }),
    ).toThrow('completedEpochLimit must be a positive integer');
    expect(
      () => new FinalVoiceEndpointDetector({ completedEpochLimit: 1.5 }),
    ).toThrow('completedEpochLimit must be a positive integer');
  });
});
