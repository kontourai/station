import { test } from 'vitest';
import { runReservedInputScenario } from './reserved-input-fixture.js';

// Service/security boundary; runtime HTTP ingress is not exercised here.
test.each(['service-answer-current', 'service-answer-revocation'] as const)(
  'reserved canonical answer preserves the live authenticated responder: %s',
  runReservedInputScenario,
);
