/**
 * Outbound (client→agent) ACP extension channel.
 *
 * The inbound half (`acp-inbound-extension-policy.ts`) decides how Station
 * answers the agent's extension requests. This module is the symmetric other
 * direction: a typed, declared-list-gated pass-through for Station calling the
 * agent's `_`-prefixed extension methods. See ADR 0013 (Layer 1).
 *
 * ## The gate
 *
 * Every outbound call is gated on the LIVE session's own handshake —
 * `target.initResult.agentCapabilities._meta` — never a compiled-in constant,
 * never a stored or probe-cached observation, never a version string. A method
 * absent from that live list is a distinct, receipt-carrying non-event
 * (`not-declared`): NO wire call is made. This is the primary protection.
 *
 * The declared list lives at `agentCapabilities._meta.<vendorKey>.extensionMethods`,
 * where `<vendorKey>` is vendor-chosen (`kiro` is one observed value and is
 * deliberately not hardcoded here). Every key under `_meta` is scanned for an
 * `extensionMethods` string array, except the W3C trace-context keys
 * (`traceparent`/`tracestate`/`baggage`), which are reserved and never read or
 * mutated.
 *
 * ## The outcome vocabulary
 *
 * Derived from wire facts only (ADR 0013, "What the wire actually does"):
 *
 * - `not-declared` — the method was absent from the live declared list. No wire
 *   call. Carries a receipt of what *was* declared.
 * - `answered` — the agent returned a JSON-RPC result. ANY result, including a
 *   `{success: false}` envelope, which is a *result* on the wire, not a
 *   failure. Deciding what "working" means is each binding's conformance probe
 *   (Layer 3); this layer makes no such claim.
 * - `unsupported` — JSON-RPC error `-32601` (Method not found).
 * - `failed` — any other error: `-32603` (Kiro v3 returns this for undeclared
 *   methods with vendor-internal detail), `-32000`, vendor dialects, transport
 *   errors, timeouts.
 *
 * `-32601` is the one error code this layer classifies by name, and it is the
 * SECONDARY signal: the declared-list gate above is the protection. Live
 * evidence shows the code is not a reliable discriminator even within one
 * binary — Kiro v3 answers `-32603` for unknown methods and was observed
 * answering `-32601` for a *core* method in the same session — so only this
 * single spec-defined code earns its own outcome; everything else is `failed`.
 *
 * ## `_meta` discipline
 *
 * Per the ACP extensibility spec, no custom fields are added at the root of any
 * spec-defined type. This module only *reads* `_meta` and passes caller-supplied
 * `params` through verbatim; it adds nothing to either.
 */
import { RequestError } from '@agentclientprotocol/sdk';
import {
  acpOutboundExtensionNotifications,
  acpOutboundExtensionRequests,
} from '../../telemetry/metrics.js';

/**
 * W3C trace-context keys reserved at `_meta` root. Never read as a declared
 * list, never mutated. (ACP extensibility spec; ADR 0013.)
 */
const W3C_TRACE_KEYS = new Set(['traceparent', 'tracestate', 'baggage']);

/**
 * The handshake shape the gate reads. A structural slice of the SDK's
 * `InitializeResult` — enough to type the `_meta` walk without coupling this
 * module to the full type.
 */
export interface AcpExtensionHandshakeMeta {
  agentCapabilities?: { _meta?: Record<string, unknown> | null } | null;
}

/**
 * The surface the channel calls through. `ACPProcess` satisfies this directly
 * (its `extMethod`, `extNotification`, and `initResult`); tests pass a fake so
 * the gate and outcome classification are exercised without a real child
 * process. Reading `initResult` live on every call — rather than capturing it
 * once — is what makes the gate reflect the session's *current* handshake.
 */
export interface AcpOutboundExtensionTarget {
  extMethod(method: string, params: Record<string, unknown>): Promise<unknown>;
  extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void>;
  readonly initResult: AcpExtensionHandshakeMeta | null;
}

/**
 * Records what the live session declared at the moment a call was refused, so a
 * caller can explain the non-event (and a binding can render an affordance
 * absent with a receipt, per ADR 0013's trip-wire rule).
 */
export interface AcpOutboundExtensionReceipt {
  declaredMethods: string[];
}

/**
 * The outcome of an outbound extension request. `error` is the raw thrown
 * value for `unsupported`/`failed` — the channel does not normalise it, so the
 * caller retains the full vendor-internal detail (`-32603` messages carry it).
 */
export type AcpOutboundExtensionCallOutcome =
  | {
      outcome: 'not-declared';
      method: string;
      receipt: AcpOutboundExtensionReceipt;
    }
  | { outcome: 'answered'; method: string; result: unknown }
  | { outcome: 'unsupported'; method: string; error: unknown }
  | { outcome: 'failed'; method: string; error: unknown };

/**
 * The outcome of an outbound extension notification. Fire-and-forget: there is
 * no response to classify, so no `answered`/`unsupported` distinction — only
 * `sent`, `not-declared`, or a transport `failed`.
 */
export type AcpOutboundExtensionNotifyOutcome =
  | {
      outcome: 'not-declared';
      method: string;
      receipt: AcpOutboundExtensionReceipt;
    }
  | { outcome: 'sent'; method: string }
  | { outcome: 'failed'; method: string; error: unknown };

/**
 * Read the declared extension methods from a session's live handshake.
 *
 * Returns the empty list when the session is not initialised
 * (`initResult` is null) — such a session declares nothing, and every call
 * through the channel is `not-declared`. Exported so a binding can render a
 * declared set with provenance (ADR 0013 Layer 2) without re-deriving the walk.
 */
export function readDeclaredExtensionMethods(
  initResult: AcpExtensionHandshakeMeta | null,
): string[] {
  if (!initResult) return [];
  const meta = initResult.agentCapabilities?._meta;
  if (!meta || typeof meta !== 'object') return [];
  const declared = new Set<string>();
  for (const [key, value] of Object.entries(meta)) {
    if (W3C_TRACE_KEYS.has(key)) continue;
    if (
      value &&
      typeof value === 'object' &&
      Array.isArray((value as { extensionMethods?: unknown }).extensionMethods)
    ) {
      for (const method of (value as { extensionMethods: unknown[] })
        .extensionMethods) {
        if (typeof method === 'string') declared.add(method);
      }
    }
  }
  return [...declared];
}

/**
 * Outbound ACP extension channel. Construct one per `ACPProcess` (per session);
 * the gate reads that process's live `initResult` on every call, so two
 * sessions against two different handshakes get two different gates.
 */
export class AcpOutboundExtensionChannel {
  constructor(private readonly target: AcpOutboundExtensionTarget) {}

  /** The methods the live session declares right now. */
  get declaredMethods(): string[] {
    return readDeclaredExtensionMethods(this.target.initResult);
  }

  /**
   * Call an extension method on the agent, gated on the live handshake. See the
   * module header for the outcome vocabulary.
   */
  async call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<AcpOutboundExtensionCallOutcome> {
    const declared = this.declaredMethods;
    if (!declared.includes(method)) {
      acpOutboundExtensionRequests.add(1, { disposition: 'not-declared' });
      return {
        outcome: 'not-declared',
        method,
        receipt: { declaredMethods: declared },
      };
    }
    try {
      const result = await this.target.extMethod(method, params);
      acpOutboundExtensionRequests.add(1, { disposition: 'answered' });
      return { outcome: 'answered', method, result };
    } catch (error) {
      if (error instanceof RequestError && error.code === -32601) {
        acpOutboundExtensionRequests.add(1, { disposition: 'unsupported' });
        return { outcome: 'unsupported', method, error };
      }
      acpOutboundExtensionRequests.add(1, { disposition: 'failed' });
      return { outcome: 'failed', method, error };
    }
  }

  /**
   * Send an extension notification, gated on the live handshake. An undeclared
   * notification makes no wire call, exactly like an undeclared request.
   */
  async notify(
    method: string,
    params: Record<string, unknown>,
  ): Promise<AcpOutboundExtensionNotifyOutcome> {
    const declared = this.declaredMethods;
    if (!declared.includes(method)) {
      acpOutboundExtensionNotifications.add(1, { disposition: 'not-declared' });
      return {
        outcome: 'not-declared',
        method,
        receipt: { declaredMethods: declared },
      };
    }
    try {
      await this.target.extNotification(method, params);
      acpOutboundExtensionNotifications.add(1, { disposition: 'sent' });
      return { outcome: 'sent', method };
    } catch (error) {
      acpOutboundExtensionNotifications.add(1, { disposition: 'failed' });
      return { outcome: 'failed', method, error };
    }
  }
}
