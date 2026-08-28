/**
 * Unreachable-gate diagnostic (archive#189 S2).
 *
 * A Flow definition declares the claim types its gates expect; the
 * command-evidence routing policy declares the claim types it can produce from
 * an already-run command line. Where those two do not meet, every command an
 * agent runs routes `no-route` and the gate can never be satisfied by
 * Station-collected evidence — silently, because `no-route` is the same
 * outcome as "this command was irrelevant".
 *
 * The shipped `station-delivery` definition was in that state for its whole
 * life, with no gate reachable at all. The likelier future regression is
 * narrower: one gate's claim type stops being producible while the others
 * still are, and the definition keeps looking healthy in aggregate. So the
 * check reports per gate, and grades the two cases differently — `all` when
 * nothing on the definition is reachable, `partial` when some gate is not.
 */

import type { FlowDefinition } from '@kontourai/flow';
import {
  type CommandEvidenceRoutingPolicy,
  definitionExpectedClaimTypesByGate,
} from '../evidence/command-evidence-routing-policy.js';

/** Warning code carried on the emitted `runtime.warning` event. */
export const UNREACHABLE_GATE_CLAIMS_CODE = 'flow.unreachable-gate-claims';

export interface UnreachableGate {
  gateId: string;
  /** The gate's expected claim types, none of which the policy can produce. */
  unproducibleClaimTypes: string[];
}

export interface UnreachableGateClaims {
  /** Discriminates this conclusive result from `reachability-not-evaluable`. */
  kind?: undefined;
  definitionId: string;
  /**
   * `all` — no claim type anywhere on the definition is producible.
   * `partial` — some gates are reachable, at least one is not.
   */
  severity: 'all' | 'partial';
  /** Claim types the definition's gates expect. */
  expectedClaimTypes: string[];
  /** Claim types the routing policy can produce from a command line. */
  routableClaimTypes: string[];
  /** Every gate whose expected claim types are all unproducible. */
  unreachableGates: UnreachableGate[];
}

/**
 * The policy capability needed to evaluate reachability is unavailable or did
 * not return its synchronous `string[]` contract. This is deliberately not an
 * `all` result: `all` is a conclusive statement that every gate is
 * unreachable, while this result states that Station could not evaluate that
 * question at all.
 *
 * Keep this payload fixed and redacted. A policy implementation is outside
 * this diagnostic's trust boundary, so its errors, return values, and claim
 * names must never be reflected into a runtime warning.
 */
export interface ReachabilityNotEvaluable {
  kind: 'reachability-not-evaluable';
  severity: 'not-evaluable';
  reason: 'routable-claim-types-unavailable';
}

export type GateReachabilityDiagnostic =
  | UnreachableGateClaims
  | ReachabilityNotEvaluable;

const MAX_POLICY_PROTOTYPE_DEPTH = 8;
const MAX_ROUTABLE_CLAIM_TYPES = 1024;
const MAX_ROUTABLE_CLAIM_TYPE_LENGTH = 128;
const CANONICAL_CLAIM_TYPE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/**
 * Return a fresh immutable fixed diagnostic, so a caller cannot poison a
 * subsequent warning by mutating a shared object. All fields are scalars, so
 * freezing this record contains the complete payload.
 */
function reachabilityNotEvaluable(): Readonly<ReachabilityNotEvaluable> {
  return Object.freeze({
    kind: 'reachability-not-evaluable' as const,
    severity: 'not-evaluable' as const,
    reason: 'routable-claim-types-unavailable' as const,
  });
}

/**
 * Read the optional capability without invoking getters or coercing an
 * untrusted policy. The published policy interface is synchronous; a Promise
 * or any other result shape is therefore not an evaluable inventory.
 */
function readRoutableClaimTypes(policy: unknown): string[] | null {
  try {
    if (
      policy === null ||
      (typeof policy !== 'object' && typeof policy !== 'function')
    ) {
      return null;
    }

    let candidate: object | null = policy;
    let capability: (() => unknown) | null = null;
    for (let depth = 0; candidate !== null; depth += 1) {
      if (depth >= MAX_POLICY_PROTOTYPE_DEPTH) return null;
      const descriptor = Object.getOwnPropertyDescriptor(
        candidate,
        'routableClaimTypes',
      );
      if (descriptor) {
        // Accessors can execute arbitrary policy code merely by inspecting the
        // capability. Require a data-property function instead.
        if (
          !('value' in descriptor) ||
          typeof descriptor.value !== 'function'
        ) {
          return null;
        }
        capability = descriptor.value as () => unknown;
        break;
      }
      candidate = Object.getPrototypeOf(candidate);
    }
    if (capability === null) return null;

    const reported = Reflect.apply(capability, policy, []);
    return validateRoutableClaimTypes(reported);
  } catch {
    return null;
  }
}

/**
 * Flow's schema requires a non-empty string for a claim type, while Station's
 * source-owned routing policy declares canonical lower-case dot/hyphen names
 * (for example `quality.tests`). This untrusted inventory is stricter: a
 * dense bounded array of unique canonical primitive strings. Reading
 * descriptors rather than indexing prevents element getters or coercion from
 * leaking hostile values into the diagnostic or its warning payload.
 */
function validateRoutableClaimTypes(value: unknown): string[] | null {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_ROUTABLE_CLAIM_TYPES ||
      Reflect.ownKeys(descriptors).length !== length + 1
    ) {
      return null;
    }

    const claimTypes: string[] = [];
    const uniqueClaimTypes = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string' ||
        descriptor.value.length === 0 ||
        descriptor.value.length > MAX_ROUTABLE_CLAIM_TYPE_LENGTH ||
        !CANONICAL_CLAIM_TYPE.test(descriptor.value) ||
        uniqueClaimTypes.has(descriptor.value)
      ) {
        return null;
      }
      uniqueClaimTypes.add(descriptor.value);
      claimTypes.push(descriptor.value);
    }
    return claimTypes;
  } catch {
    return null;
  }
}

/**
 * Null when every gate that expects trust.bundle claims can be reached, or
 * when the definition expects no such claims at all (nothing to route, so
 * nothing is unreachable). A policy whose capability cannot be safely
 * evaluated returns an explicit `reachability-not-evaluable` diagnostic.
 */
export function detectUnreachableGateClaims(
  definition: FlowDefinition,
  policy: CommandEvidenceRoutingPolicy,
): GateReachabilityDiagnostic | null {
  const routableClaimTypes = readRoutableClaimTypes(policy);
  if (routableClaimTypes === null) return reachabilityNotEvaluable();

  const routable = new Set(routableClaimTypes);
  const gates = definitionExpectedClaimTypesByGate(definition).filter(
    (gate) => gate.claimTypes.length > 0,
  );
  if (gates.length === 0) return null;

  const unreachableGates = gates
    .filter((gate) =>
      gate.claimTypes.every((claimType) => !routable.has(claimType)),
    )
    .map((gate) => ({
      gateId: gate.gateId,
      unproducibleClaimTypes: gate.claimTypes,
    }));
  if (unreachableGates.length === 0) return null;

  return {
    definitionId: definition.id,
    severity: unreachableGates.length === gates.length ? 'all' : 'partial',
    expectedClaimTypes: [...new Set(gates.flatMap((gate) => gate.claimTypes))],
    routableClaimTypes: [...routableClaimTypes],
    unreachableGates,
  };
}

/** Operator-readable warning text naming both sets and the affected gates. */
export function describeUnreachableGateClaims(
  diagnostic: GateReachabilityDiagnostic,
): string {
  if (diagnostic.kind === 'reachability-not-evaluable') {
    return 'Flow gate reachability is not evaluable because the command-evidence routing policy cannot provide a valid routable claim-type inventory.';
  }
  const scope =
    diagnostic.severity === 'all'
      ? 'expects no claim type that any command-evidence routing pattern can produce, so NO gate on it can be satisfied by collected command evidence'
      : 'has gates expecting claim types no command-evidence routing pattern can produce, so those gates can never be satisfied by collected command evidence';
  const gates = diagnostic.unreachableGates
    .map((gate) => `${gate.gateId} (${gate.unproducibleClaimTypes.join(', ')})`)
    .join('; ');
  return (
    `Flow definition "${diagnostic.definitionId}" ${scope}. ` +
    `Unreachable gates: ${gates}. ` +
    `Expected by gates: ${diagnostic.expectedClaimTypes.join(', ')}. ` +
    `Producible by policy: ${diagnostic.routableClaimTypes.join(', ')}.`
  );
}
