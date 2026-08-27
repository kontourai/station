import { describe, expect, test } from 'vitest';
import {
  base64ToInt16,
  downsample,
  float32ToInt16,
  int16ToBase64,
  int16ToFloat32,
} from '../hooks/voiceSessionAudio';

describe('voiceSessionAudio', () => {
  test('float32ToInt16 clamps and converts samples', () => {
    expect(
      Array.from(float32ToInt16(new Float32Array([-2, -1, 0, 1, 2]))),
    ).toEqual([-32768, -32768, 0, 32767, 32767]);
  });

  test('downsample reduces sample count when rates differ', () => {
    expect(
      Array.from(downsample(new Float32Array([0, 1, 2, 3]), 4, 2)),
    ).toEqual([0, 2]);
  });

  test('int16 base64 helpers round-trip sample data', () => {
    const input = new Int16Array([-32768, -1, 0, 1, 32767]);
    expect(Array.from(base64ToInt16(int16ToBase64(input)))).toEqual(
      Array.from(input),
    );
  });

  test('int16ToFloat32 converts signed ranges back to float audio', () => {
    expect(
      Array.from(int16ToFloat32(new Int16Array([-32768, 0, 32767]))),
    ).toEqual([-1, 0, 1]);
  });
});
