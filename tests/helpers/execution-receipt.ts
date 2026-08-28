import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import {
  EXECUTION_RESOLUTION_RECEIPT_SCHEMA_VERSION,
  type ExecutionResolutionReceipt,
  environmentId,
} from '@kontourai/station-contracts/execution-target';
import type { ForegroundMessageReceipt } from '@kontourai/station-sdk/client';

/**
 * The one fixture for an ACCEPTED `POST /api/orchestration/chat` (and
 * `.../:conversationId/continue`) response.
 *
 * archive#3800: the shape is not decorative. `readExecutionReceipt`
 * (`packages/sdk/src/client/execution.ts:126-137`) refuses any body without a
 * non-empty `providerTurnId` as `foreground_message_indeterminate` — the same
 * verdict the server itself returns (409, `orchestration.ts:689-701`) rather
 * than call a turn accepted without the exact provider turn identity. A mock
 * that omitted it therefore sent EVERY send in that spec down the
 * indeterminate branch, where the UI shows "Session start needs confirmation"
 * and nothing promotes the chat — so a green "send succeeds" assertion was
 * proving the failure path. The envelope matters for the same reason: the SDK
 * reads `success`/`data`, so a bare `{ conversationId, ... }` body is a
 * refusal too.
 *
 * The return type is the SDK's own `ForegroundMessageReceipt`, so this fixture
 * cannot drift from the contract the product code reads.
 */
export interface ForegroundMessageReceiptInput {
  conversationId: string;
  /** Defaults to the conversation id, as the server's handle does. */
  sessionId?: string;
  /** Defaults to a unique `provider-turn-<n>` for this worker process. */
  providerTurnId?: string;
  /** Agent slug the turn resolved to. */
  agent?: string;
  /** Overrides merged onto the default resolution receipt. */
  resolution?: Partial<ExecutionResolutionReceipt>;
}

let turnOrdinal = 0;

function defaultResolution(agent: string): ExecutionResolutionReceipt {
  return {
    schemaVersion: EXECUTION_RESOLUTION_RECEIPT_SCHEMA_VERSION,
    resolvedAt: '2026-01-01T00:00:00.000Z',
    environmentId: environmentId('environment-current'),
    // Fixtures mirror the JSON the route emits, where identities are plain
    // strings; `agentId()` would reject the non-slug ids some specs use for
    // their own readability (for example `agent:station`).
    agentId: agent as AgentId,
    engine: { kind: 'station' },
    provider: agent,
    modelLaunchPlan: { kind: 'engine-selected', evidence: 'adapter-declared' },
  };
}

/** An accepted foreground receipt, exactly as the route emits one. */
export function foregroundMessageReceipt(
  input: ForegroundMessageReceiptInput,
): ForegroundMessageReceipt {
  const agent = input.agent ?? 'station';
  turnOrdinal += 1;
  return {
    conversationId: input.conversationId,
    sessionId: input.sessionId ?? input.conversationId,
    providerTurnId: input.providerTurnId ?? `provider-turn-${turnOrdinal}`,
    target: { kind: 'agent', id: agent as AgentId },
    resolution: { ...defaultResolution(agent), ...input.resolution },
  };
}

/** The full API envelope a chat-route mock must fulfil. */
export function foregroundMessageReceiptEnvelope(
  input: ForegroundMessageReceiptInput,
): { success: true; data: ForegroundMessageReceipt } {
  return { success: true, data: foregroundMessageReceipt(input) };
}
