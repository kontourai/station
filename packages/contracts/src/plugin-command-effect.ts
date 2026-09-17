/**
 * Plugin command effects (kontourai/station#1418, #1419).
 *
 * A palette row is not authority. Station admits one local effect for one
 * browser document, records it durably, and learns how that document settled
 * it. Withdrawing a plugin's authority (removal, update, `plugin.server`
 * withdrawal) commits immediately; its status reports `completed` only when
 * every effect it captured was settled with proof.
 */

/** Operational event type and payload schema for admissions and settlements. */
export const PLUGIN_COMMAND_EFFECT_EVENT_SCHEMA =
  'station.plugin-command.execution/v1' as const;

/** A settlement names how one document ended one effect. */
export const PLUGIN_COMMAND_EFFECT_OUTCOMES = [
  'applied',
  'aborted',
  'cancelled',
  'abandoned',
] as const;
export type PluginCommandEffectOutcome =
  (typeof PLUGIN_COMMAND_EFFECT_OUTCOMES)[number];
export type PluginCommandEffectState = 'admitted' | PluginCommandEffectOutcome;

/**
 * Who proved a terminal state. `document` is the browser document that
 * requested the effect; `operator` accepted an indeterminate withdrawal;
 * `station` cancelled an admission whose receipt was never released.
 */
export type PluginCommandEffectSettledBy = 'document' | 'operator' | 'station';

/** The host target an effect is bound to. Destination ids are not routes. */
export type PluginCommandEffectTarget =
  | { kind: 'destination'; destinationId: string }
  | { kind: 'composer'; sessionId: string };

export interface PluginCommandEffectAdmissionRequest {
  /** Random per-document id; stable for the document's lifetime. */
  documentId: string;
  /** Random per-document secret held in memory only; Station stores a digest. */
  documentKey: string;
  /** Client-chosen id; admission is idempotent on (documentId, requestId). */
  requestId: string;
  /** The inventory's opaque generation for the installation the row came from. */
  installationGeneration: string;
  commandId: string;
  target: PluginCommandEffectTarget;
}

/** Effect content always comes from the receipt, never from a cached row. */
export type PluginCommandEffectContent =
  | { kind: 'navigate'; destinationId: string }
  | { kind: 'seed-composer'; sessionId: string; text: string };

export interface PluginCommandEffectReceipt {
  effectId: string;
  requestId: string;
  pluginId: string;
  commandId: string;
  installationGeneration: string;
  effect: PluginCommandEffectContent;
}

export type PluginCommandEffectRefusalReason =
  | 'invalid-request'
  | 'not-found'
  | 'generation-changed'
  | 'command-not-declared'
  | 'command-not-executable'
  | 'target-mismatch'
  | 'requirement-not-satisfied'
  | 'permission-unavailable'
  | 'capacity'
  | 'cancelled'
  | 'request-conflict'
  | 'unavailable';

export const PLUGIN_COMMAND_EFFECT_MAX_SETTLEMENT_ITEMS = 16;

export interface PluginCommandEffectSettlementItem {
  requestId: string;
  /** Omitted when the document abandoned the request before any receipt. */
  effectId?: string;
  outcome: PluginCommandEffectOutcome;
}

export interface PluginCommandEffectSettlementRequest {
  documentId: string;
  documentKey: string;
  items: PluginCommandEffectSettlementItem[];
}

/**
 * - `settled`: this item recorded the effect's first terminal state.
 * - `already-settled`: the same outcome was already recorded.
 * - `cancel-recorded`: no admission exists yet; a later one will be refused.
 * - `recorded-late`: the operator already closed the effect; counted, not applied.
 * - `conflict`: a different terminal outcome was already recorded.
 * - `not-found`: no effect for this document and request (or key mismatch).
 */
export type PluginCommandEffectSettlementStatus =
  | 'settled'
  | 'already-settled'
  | 'cancel-recorded'
  | 'recorded-late'
  | 'conflict'
  | 'not-found';

export interface PluginCommandEffectSettlementResult {
  requestId: string;
  status: PluginCommandEffectSettlementStatus;
}

export type PluginCommandWithdrawalCause =
  | 'removal'
  | 'update'
  | 'grant-withdrawal';

/**
 * Derived, never stored:
 * - `completed`: every captured effect was settled with document or station proof.
 * - `winding-down`: some are outstanding and the withdrawal is still young.
 * - `indeterminate`: some are outstanding past the wait; not terminal.
 * - `closed-indeterminate`: an operator accepted the unknown outcome. This is
 *   never a completed or withdrawn state.
 */
export type PluginCommandWithdrawalStatus =
  | 'completed'
  | 'winding-down'
  | 'indeterminate'
  | 'closed-indeterminate';

export const PLUGIN_COMMAND_WITHDRAWAL_MAX_LISTED_EFFECTS = 16;

/** What a lifecycle response carries about the effects its change withdrew. */
export interface PluginCommandEffectsWithdrawalSummary {
  withdrawalId: string;
  status: PluginCommandWithdrawalStatus;
  outstanding: number;
}

export interface PluginCommandWithdrawalProjection
  extends PluginCommandEffectsWithdrawalSummary {
  pluginId: string;
  cause: PluginCommandWithdrawalCause;
  createdAt: string;
  /** At most {@link PLUGIN_COMMAND_WITHDRAWAL_MAX_LISTED_EFFECTS} ids. */
  outstandingEffectIds: string[];
}

export const PLUGIN_COMMAND_WITHDRAWAL_RESOLVE_DISPOSITION =
  'accept-indeterminate' as const;
