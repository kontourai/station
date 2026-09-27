import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ExecutionResolutionReceipt,
  type ExecutionTarget,
  environmentId,
  type ResolvedExecutionEngine,
} from '../execution-target.js';

// The first two are type assertions, checked by `typecheck:contracts`: a
// runtime assertion on a literal the test wrote cannot see an optional field
// added to the type. The resolver suite owns the runtime receipt.
describe('execution target contract', () => {
  it('addresses execution through Environment, Agent, model, and workspace only', () => {
    expectTypeOf<keyof ExecutionTarget>().toEqualTypeOf<
      'environment' | 'agent' | 'model' | 'workspace'
    >();
  });

  it('keeps access, credential, and connection state out of the resolution receipt', () => {
    expectTypeOf<
      Extract<
        keyof ExecutionResolutionReceipt,
        | 'apiBase'
        | 'connection'
        | 'credential'
        | 'endpoint'
        | 'ssh'
        | 'transport'
      >
    >().toBeNever();
    // The built-in Station engine has no connection identity to invent.
    expectTypeOf<
      Extract<ResolvedExecutionEngine, { kind: 'station' }>
    >().toEqualTypeOf<{ kind: 'station' }>();
  });

  it('brands non-empty opaque Environment identities', () => {
    expect(environmentId('  71b450c9-1440-4b15-86b1-b0e28e6d347f  ')).toBe(
      '71b450c9-1440-4b15-86b1-b0e28e6d347f',
    );
    expect(() => environmentId('  ')).toThrow('must not be empty');
  });
});
