import { test } from 'vitest';
import { runReservedInputScenario } from './reserved-input-fixture.js';

test.each([
  'answer',
  'entry-contention',
  'open-contention',
  'reply-contention',
  'reply-revocation',
  'commit-wait',
  'queued-abort',
  'queued-revocation',
  'abort-before-open',
  'invocation-abort-before-open',
  'invocation-abort-after-open',
] as const)(
  'reserved accounted input holds its actual turn through canonical settlement: %s',
  runReservedInputScenario,
);
