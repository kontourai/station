import { expect } from 'vitest';

export function expectCanonicalSessionLifecycle(methods: string[]): void {
  expect(methods.slice(0, 2)).toEqual([
    'session.started',
    'session.configured',
  ]);
  expect(methods).toContain('turn.started');
}
