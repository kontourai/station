import { describe, expectTypeOf, it } from 'vitest';
import type { ExecutionConfinementRecord } from '../execution-confinement.js';
import type { ExecutionResolutionReceipt } from '../execution-target.js';

// Type assertions, checked by `typecheck:contracts`. The record rides the
// resolution receipt, whose recursive access/credential/transport ban lives
// in execution-target.test.ts; this pins the record's own finite key set.
describe('execution confinement contract', () => {
  it('keeps the confinement record to its eight content-free fields', () => {
    expectTypeOf<keyof ExecutionConfinementRecord>().toEqualTypeOf<
      | 'level'
      | 'required'
      | 'posture'
      | 'mechanism'
      | 'workspaceAccess'
      | 'policyBasis'
      | 'writeGrants'
      | 'fallback'
    >();
  });

  it('places the record on the resolution receipt as an optional, post-start field', () => {
    expectTypeOf<ExecutionResolutionReceipt['confinement']>().toEqualTypeOf<
      ExecutionConfinementRecord | undefined
    >();
  });
});
