import { describe, expect, it } from 'vitest';
import { chunkVoiceText } from '../voice/tts-chunker.js';

describe('chunkVoiceText', () => {
  it('prefers complete sentences while enforcing the maximum chunk length', () => {
    expect(
      chunkVoiceText('First sentence. Second sentence is longer. Third.', 28),
    ).toEqual(['First sentence.', 'Second sentence is longer.', 'Third.']);
    expect(chunkVoiceText('one two three four five', 8)).toEqual([
      'one two',
      'three',
      'four',
      'five',
    ]);
  });
});
