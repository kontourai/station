/**
 * Adversarial behavior tests for `@kontourai/console-core`'s published
 * `resolveIntentBinding`/`intentBindingFromCommand` (console#238), AS
 * CONSUMED BY STATION (roadmap archive#585/#586, part of epic archive#580, S5/S6).
 *
 * Test cases below are ported 1:1 from console-core's own
 * `console-core/test/intent-binding.test.ts`, run here against the REAL
 * installed package (not a mirror) — this repo's own proof that the
 * published contract's fail-closed/never-authority behavior is exactly what
 * `station-intent-bindings.ts`/`createStationHostIntentBindings` build on.
 *
 * History: prior to console-core@0.3.0 (published 2026-07-22), this
 * contract was not yet published, so station carried a byte-for-byte
 * BEHAVIORAL mirror (`intent-binding-mirror.ts`) with its own trip-wire
 * test. console-core@0.3.0 started shipping the real exports, the
 * trip-wire fired as designed, and both the mirror file and its dedicated
 * trip-wire describe block were deleted here — this file is what remains:
 * the SAME adversarial cases, now exercising the real import directly.
 */

import {
  type HostIntentBinding,
  intentBindingFromCommand,
  resolveIntentBinding,
} from '@kontourai/console-core';
import type { ProductCapabilityDescriptor } from '@kontourai/console-core/product-capability-descriptor';
import { describe, expect, test } from 'vitest';

function intent(product: string, command: string) {
  return { authority: { product, command } };
}

describe('resolveIntentBinding (@kontourai/console-core, real import)', () => {
  test('unique matching binding resolves bound, with the EXACT execute reference supplied', () => {
    const execute = () => {};
    const bindings: HostIntentBinding[] = [
      {
        product: 'flow',
        command: 'cancel',
        sideEffect: 'write-local',
        confirmation: 'user-request',
        execute,
      },
    ];

    const result = resolveIntentBinding(intent('flow', 'cancel'), bindings);

    expect(result.bound).toBe(true);
    if (!result.bound) throw new Error('unreachable');
    expect(result.product).toBe('flow');
    expect(result.command).toBe('cancel');
    expect(result.sideEffect).toBe('write-local');
    expect(result.confirmation).toBe('user-request');
    // Identity, not a wrapped/rebuilt function.
    expect(result.execute).toBe(execute);
  });

  test('an intent with no authority never resolves bound', () => {
    const bindings: HostIntentBinding[] = [
      {
        product: 'flow',
        command: 'cancel',
        sideEffect: 'write-local',
        confirmation: 'user-request',
        execute: () => {},
      },
    ];

    expect(resolveIntentBinding({}, bindings)).toEqual({
      bound: false,
      reason: 'missing-authority',
    });
    expect(resolveIntentBinding({ authority: {} }, bindings)).toEqual({
      bound: false,
      reason: 'missing-authority',
    });
    expect(
      resolveIntentBinding({ authority: { product: 'flow' } }, bindings),
    ).toEqual({ bound: false, reason: 'missing-authority' });
  });

  test('never-authority invariant: a host binding for a DIFFERENT authority never binds an unrelated intent', () => {
    const bindings: HostIntentBinding[] = [
      {
        product: 'console',
        command: 'board.select-card',
        sideEffect: 'none',
        confirmation: 'never',
        execute: () => {},
      },
    ];

    const result = resolveIntentBinding(intent('flow', 'cancel'), bindings);
    expect(result).toEqual({
      bound: false,
      reason: 'no-matching-binding',
      product: 'flow',
      command: 'cancel',
    });
    expect('execute' in result).toBe(false);
  });

  test('never-authority invariant: an empty binding set never binds anything', () => {
    const result = resolveIntentBinding(intent('flow', 'cancel'), []);
    expect(result).toEqual({
      bound: false,
      reason: 'no-matching-binding',
      product: 'flow',
      command: 'cancel',
    });
  });

  test("never-authority invariant: two bindings claiming the same authority resolve unbound, not 'first wins'", () => {
    const first = () => {};
    const second = () => {};
    const bindings: HostIntentBinding[] = [
      {
        product: 'flow',
        command: 'cancel',
        sideEffect: 'write-local',
        confirmation: 'user-request',
        execute: first,
      },
      {
        product: 'flow',
        command: 'cancel',
        sideEffect: 'write-local',
        confirmation: 'never',
        execute: second,
      },
    ];

    const result = resolveIntentBinding(intent('flow', 'cancel'), bindings);
    expect(result).toEqual({
      bound: false,
      reason: 'ambiguous-binding',
      product: 'flow',
      command: 'cancel',
    });
  });

  test('malformed consent metadata on the matched binding fails closed, not silently accepted', () => {
    const bindings: HostIntentBinding[] = [
      {
        product: 'flow',
        command: 'cancel',
        sideEffect: 'delete-everything' as never,
        confirmation: 'user-request',
        execute: () => {},
      },
    ];

    const result = resolveIntentBinding(intent('flow', 'cancel'), bindings);
    expect(result).toEqual({
      bound: false,
      reason: 'invalid-consent-metadata',
      product: 'flow',
      command: 'cancel',
    });
  });

  test("read-only, never-confirmation bindings resolve bound with confirmation 'never'", () => {
    const execute = () => {};
    const bindings: HostIntentBinding[] = [
      {
        product: 'console',
        command: 'board.select-card',
        sideEffect: 'none',
        confirmation: 'never',
        execute,
      },
    ];

    const result = resolveIntentBinding(
      intent('console', 'board.select-card'),
      bindings,
    );
    expect(result.bound).toBe(true);
    if (!result.bound) throw new Error('unreachable');
    expect(result.sideEffect).toBe('none');
    expect(result.confirmation).toBe('never');
  });
});

describe('intentBindingFromCommand (@kontourai/console-core, real import)', () => {
  const descriptor: ProductCapabilityDescriptor = {
    schemaVersion: '1.0.0',
    protocolVersion: '1.0.0',
    product: {
      id: 'flow',
      displayName: 'Flow',
      packageName: '@kontourai/flow',
    },
    executables: [{ id: 'flow-cli', packageBin: 'flow' }],
    commands: [
      {
        path: ['cancel'],
        summary: 'Request cancellation of a product-owned Flow run.',
        executableId: 'flow-cli',
        argv: ['cancel'],
        sideEffect: 'write-local',
        authority: {
          kind: 'product',
          productId: 'flow',
          confirmation: 'user-request',
        },
      },
      {
        path: ['workflow', 'status'],
        summary: 'Read the current Builder workflow state.',
        executableId: 'flow-cli',
        argv: ['workflow', 'status'],
        sideEffect: 'read-local',
        authority: {
          kind: 'product',
          productId: 'flow',
          confirmation: 'never',
        },
      },
    ],
    artifacts: [],
    projections: [],
  };

  test('derives product/command/sideEffect/confirmation from a command actually IN the descriptor, unchanged', () => {
    const execute = () => {};
    const result = intentBindingFromCommand(descriptor, ['cancel'], execute);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.binding).toEqual({
      product: 'flow',
      command: 'cancel',
      sideEffect: 'write-local',
      confirmation: 'user-request',
      execute,
    });

    const resolution = resolveIntentBinding(intent('flow', 'cancel'), [
      result.binding,
    ]);
    expect(resolution.bound).toBe(true);
    if (!resolution.bound) throw new Error('unreachable');
    expect(resolution.execute).toBe(execute);
  });

  test('a multi-segment command path joins with a single space', () => {
    const result = intentBindingFromCommand(
      descriptor,
      ['workflow', 'status'],
      () => {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.binding.command).toBe('workflow status');
  });

  test('a command path not present in the descriptor produces NO binding', () => {
    const result = intentBindingFromCommand(
      descriptor,
      ['does-not-exist'],
      () => {},
    );
    expect(result).toEqual({ ok: false, error: 'command-not-found' });
  });

  test('cross-product laundering invariant: a command whose authority.productId differs from the descriptor product is rejected', () => {
    const cancelCommand = descriptor.commands.find(
      (c) => c.path.join(' ') === 'cancel',
    );
    if (!cancelCommand) throw new Error('fixture missing cancel command');

    const laundered: ProductCapabilityDescriptor = {
      ...descriptor,
      commands: [
        ...descriptor.commands,
        {
          ...cancelCommand,
          path: ['destroy'],
          authority: {
            kind: 'product',
            productId: 'surface',
            confirmation: 'never',
          },
        },
      ],
    };

    const result = intentBindingFromCommand(laundered, ['destroy'], () => {});
    expect(result).toEqual({ ok: false, error: 'authority-mismatch' });

    // The legitimate command on the same (otherwise laundered) descriptor is
    // unaffected — a per-command check, not a whole-descriptor poison.
    const legitimate = intentBindingFromCommand(
      laundered,
      ['cancel'],
      () => {},
    );
    expect(legitimate.ok).toBe(true);
  });
});
