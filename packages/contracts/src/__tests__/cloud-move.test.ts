import { expect, test } from 'vitest';
import type {
  HomeControlSessionInspectionObservation,
  HomeControlSessionOpenObservation,
  HomeControlSessionRetirementObservation,
} from '../cloud-move.js';

/**
 * These are TYPE assertions, deliberately, and the distinction matters.
 *
 * The first version of this file built three observation literals and then
 * asserted things about the literals it had just written — that `inspected`
 * has no `token`, that `opened`'s key set is the five keys the same statement
 * had spelled out. Reverting the entire route layer left it green, and adding
 * an optional `token` to the inspection type left it green too. It advertised
 * contract coverage that did not exist (`tests/AGENTS.md`: a test must fail
 * when the behavior it names breaks).
 *
 * The runtime half of that job is already done, on real data: the route suite
 * asserts the HTTP body of a real inspection with `toEqual`, so an added or
 * removed field fails there against a value the server actually produced.
 *
 * What a runtime test CANNOT see is a field that exists on the type and
 * happens not to be populated — an optional `token?: string` on the
 * inspection observation would pass every runtime assertion in the repo while
 * making a leak expressible. That is the property below, and it is checked by
 * the compiler: `typecheck:contracts` fails, not this file.
 */

/** True only when `K` is a key of `T`, including an optional one. */
type HasKey<T, K extends string> = K extends keyof T ? true : false;

// The inspection observation must never be able to carry the capability or a
// digest of it. If either becomes expressible, these stop being `false`.
const inspectionCannotCarryToken: HasKey<
  HomeControlSessionInspectionObservation,
  'token'
> = false;
const inspectionCannotCarryDigest: HasKey<
  HomeControlSessionInspectionObservation,
  'capabilityDigest'
> = false;
const inspectionCannotCarryCapability: HasKey<
  HomeControlSessionInspectionObservation,
  'capability'
> = false;
// Retirement identifies a generation, not an open. An `openId` here would let
// a retirement receipt name the open it retired.
const retirementCannotCarryOpenId: HasKey<
  HomeControlSessionRetirementObservation,
  'openId'
> = false;

// `Record<keyof T, true>` fails both ways: a new key on the observation is a
// missing property here, and a removed key is an excess one.
const openObservationKeys: Record<
  keyof HomeControlSessionOpenObservation,
  true
> = {
  schemaVersion: true,
  capability: true,
  replayed: true,
  executionAuthorityTransferred: true,
  executionResumeAvailable: true,
};

test('home control session observations keep authority limits expressible only where they belong', () => {
  // The compiler has already decided all of this; the runtime assertions
  // exist so the file is a test rather than an unreferenced declaration the
  // dead-code gate would remove.
  expect(inspectionCannotCarryToken).toBe(false);
  expect(inspectionCannotCarryDigest).toBe(false);
  expect(inspectionCannotCarryCapability).toBe(false);
  expect(retirementCannotCarryOpenId).toBe(false);
  expect(Object.keys(openObservationKeys).sort()).toEqual([
    'capability',
    'executionAuthorityTransferred',
    'executionResumeAvailable',
    'replayed',
    'schemaVersion',
  ]);
});
