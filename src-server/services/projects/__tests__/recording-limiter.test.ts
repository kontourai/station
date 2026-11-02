import { expect, test } from 'vitest';
import { RecordingLimiter } from '../recording-limiter.js';

test('bounds active work globally and per owner, and releases exactly once', () => {
  const limiter = new RecordingLimiter();
  const a = limiter.acquire('alice')!;
  const b = limiter.acquire('alice')!;
  expect(limiter.acquire('alice')).toBeUndefined();
  const c = limiter.acquire('bob')!;
  const d = limiter.acquire('carol')!;
  expect(limiter.acquire('dana')).toBeUndefined();
  a();
  a();
  const e = limiter.acquire('dana');
  expect(e).toBeDefined();
  expect(limiter.acquire('erin')).toBeUndefined();
  b();
  c();
  d();
  e?.();
  expect(limiter.acquire('alice')).toBeDefined();
});
