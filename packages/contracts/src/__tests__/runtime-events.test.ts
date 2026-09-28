import { describe, expectTypeOf, test } from 'vitest';
import type {
  CanonicalRuntimeEvent,
  ExtensionEvent,
  PlanEntry,
  PlanUpdatedEvent,
} from '../runtime-events.js';

// Type assertions, checked by `typecheck:contracts`.
describe('runtime-events contract: plan update + extension (archive#147, AC1)', () => {
  test('AC1: plan.updated and extension.notification narrow to their own event types', () => {
    expectTypeOf<
      Extract<CanonicalRuntimeEvent, { method: 'plan.updated' }>
    >().toEqualTypeOf<PlanUpdatedEvent>();
    expectTypeOf<
      Extract<CanonicalRuntimeEvent, { method: 'extension.notification' }>
    >().toEqualTypeOf<ExtensionEvent>();
  });

  test('PlanEntry status is restricted to the three canonical states', () => {
    expectTypeOf<PlanEntry['status']>().toEqualTypeOf<
      'pending' | 'in_progress' | 'completed'
    >();
  });
});
