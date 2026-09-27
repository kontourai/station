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
/** Every property key at any depth of `T`, across union arms and arrays. */
type ReceiptKeys<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? never
  : T extends readonly (infer U)[]
    ? ReceiptKeys<U>
    : T extends object
      ? { [K in keyof T]-?: K | ReceiptKeys<T[K]> }[keyof T]
      : never;

describe('execution target contract', () => {
  it('addresses execution through Environment, Agent, model, and workspace only', () => {
    expectTypeOf<keyof ExecutionTarget>().toEqualTypeOf<
      'environment' | 'agent' | 'model' | 'workspace'
    >();
  });

  it('keeps access, credential, and transport state out of every level of the resolution receipt', () => {
    // Recursive: a field nested under `engine`, `modelLaunchPlan` or
    // `workspace` leaks just as surely as a top-level one. Engine and model
    // connection *identities* (`connectionId`, `modelConnectionId`) are safe
    // by design, so the forbidden set names access state, not identities.
    expectTypeOf<
      Extract<
        ReceiptKeys<ExecutionResolutionReceipt>,
        | 'apiBase'
        | 'baseUrl'
        | 'url'
        | 'endpoint'
        | 'host'
        | 'ssh'
        | 'credential'
        | 'credentials'
        | 'token'
        | 'secret'
        | 'password'
        | 'connection'
        | 'transport'
      >
    >().toBeNever();
    // An index-signature field (e.g. `Record<string, unknown>`) widens the key
    // set to `string`, absorbing every literal and turning the Extract above
    // into `never` whatever leaks. The receipt's keys must stay a finite set.
    expectTypeOf<string>().not.toMatchTypeOf<
      ReceiptKeys<ExecutionResolutionReceipt>
    >();
    // The walker must actually descend: these nested keys are real today.
    expectTypeOf<'connectionId'>().toMatchTypeOf<
      ReceiptKeys<ExecutionResolutionReceipt>
    >();
    expectTypeOf<'modelConnectionId'>().toMatchTypeOf<
      ReceiptKeys<ExecutionResolutionReceipt>
    >();
    expectTypeOf<'mode'>().toMatchTypeOf<
      ReceiptKeys<ExecutionResolutionReceipt>
    >();
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
