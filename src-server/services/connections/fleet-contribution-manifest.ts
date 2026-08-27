/**
 * station#1398 slice 1 — the contributed-subset projection
 * (`docs/design/inference-fleet.md` §4.2, §11 slice 1).
 *
 * Turns the Station's own `station.model-inventory/v2` plus the operator's
 * opt-in into a `station.fleet-contribution/v1` manifest. It is a pure
 * function on purpose: the only inputs are the inventory the Station already
 * publishes locally and the persisted allowlist, so nothing here can invent
 * a capability the local inventory did not observe.
 *
 * The rule this module exists to enforce: **a contributed connection that
 * yields no model produces a named diagnostic, never a shorter list.** The
 * reference mesh's stale-status filter drops a node silently and that is the
 * behavior §4.5 bans outright.
 */

import type {
  FleetCarriedInventoryDiagnosticCode,
  FleetContributedModel,
  FleetContributionConfig,
  FleetContributionDiagnostic,
  FleetContributionManifest,
  FleetContributionParticipation,
} from '@kontourai/station-contracts/fleet-contribution';
import {
  declaredContributionConnectionIds,
  FLEET_CARRIED_INVENTORY_DIAGNOSTIC_CODES,
  FLEET_CONTRIBUTION_DIAGNOSTIC_ID,
  FLEET_CONTRIBUTION_MANIFEST_SCHEMA_VERSION,
  isFleetContributionEnabled,
} from '@kontourai/station-contracts/fleet-contribution';
import type {
  LaunchableModelInventory,
  LaunchableModelRecord,
  ModelInventoryDiagnostic,
} from '@kontourai/station-contracts/model-inventory';

/**
 * The aggregate-diagnostic id `launchable-model-inventory.ts` stamps on
 * inventory-wide (not connection-scoped) diagnostics.
 */
const MODEL_INVENTORY_DIAGNOSTIC_ID = 'station:model-inventory';

const CARRIED_CODES = new Set<string>(FLEET_CARRIED_INVENTORY_DIAGNOSTIC_CODES);

/**
 * Narrows a source-inventory code onto the frozen wire vocabulary. An
 * unrecognized code is renamed rather than passed through (a peer-facing
 * enum must not widen because an internal one did) and rather than dropped
 * (never a silent omission) — the original code stays in the message.
 */
function carriedDiagnostic(
  connectionId: string,
  item: ModelInventoryDiagnostic,
): FleetContributionDiagnostic {
  if (CARRIED_CODES.has(item.code)) {
    return {
      connectionId,
      code: item.code as FleetCarriedInventoryDiagnosticCode,
      message: item.message,
    };
  }
  return {
    connectionId,
    code: 'inventory-diagnostic-unrecognized',
    message: `This Station reported '${item.code}', which this manifest version cannot name: ${item.message}`,
  };
}

export interface FleetContributionProjectionInput {
  /** Wall-clock time this projection is being produced (never an age). */
  projectedAt: string;
  /** The persisted opt-in; `undefined` is the default-off state. */
  config: FleetContributionConfig | undefined;
  /**
   * The Station's own launchable-model inventory, or `null` when it could
   * not be read at all. `null` is reported as `inventory-unavailable`, never
   * as an empty contribution.
   */
  inventory: LaunchableModelInventory | null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contributedModel(
  record: LaunchableModelRecord,
): FleetContributedModel {
  return {
    id: record.id,
    connectionId: record.connectionId,
    providerModel: record.providerModel,
    model: record.model,
    aliases: record.aliases,
    displayName: record.displayName,
    locality: record.locality,
    availability: record.availability,
    freshness: record.freshness,
    observedAt: record.observedAt,
    effectiveContextTokens: record.effectiveContextTokens,
    toolSurface: record.toolSurface,
    supportsVision: record.supportsVision,
  };
}

function sortDiagnostics(
  diagnostics: FleetContributionDiagnostic[],
): FleetContributionDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((item) => [
        `${item.connectionId}\u0000${item.code}\u0000${item.message}`,
        item,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.connectionId, right.connectionId) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );
}

function manifest(options: {
  projectedAt: string;
  sourceObservedAt: string | null;
  participation: FleetContributionParticipation;
  models: FleetContributedModel[];
  diagnostics: FleetContributionDiagnostic[];
}): FleetContributionManifest {
  return {
    schemaVersion: FLEET_CONTRIBUTION_MANIFEST_SCHEMA_VERSION,
    projectedAt: options.projectedAt,
    sourceObservedAt: options.sourceObservedAt,
    participation: options.participation,
    models: [...options.models].sort((left, right) =>
      compareText(left.id, right.id),
    ),
    diagnostics: sortDiagnostics(options.diagnostics),
  };
}

export function projectFleetContributionManifest(
  input: FleetContributionProjectionInput,
): FleetContributionManifest {
  const declared = declaredContributionConnectionIds(input.config);
  const sourceObservedAt = input.inventory?.observedAt ?? null;

  if (!isFleetContributionEnabled(input.config)) {
    return manifest({
      projectedAt: input.projectedAt,
      sourceObservedAt,
      participation: 'disabled',
      models: [],
      diagnostics: [
        {
          connectionId: FLEET_CONTRIBUTION_DIAGNOSTIC_ID,
          code: 'contribution-disabled',
          message:
            declared.length > 0
              ? `Fleet contribution is turned off for this Station. ${declared.length} marked ${declared.length === 1 ? 'connection is' : 'connections are'} not being offered.`
              : 'Fleet contribution is turned off for this Station. No local models are offered to the fleet.',
        },
      ],
    });
  }

  if (declared.length === 0) {
    return manifest({
      projectedAt: input.projectedAt,
      sourceObservedAt,
      participation: 'nothing-contributed',
      models: [],
      diagnostics: [
        {
          connectionId: FLEET_CONTRIBUTION_DIAGNOSTIC_ID,
          code: 'contribution-empty',
          message:
            'Fleet contribution is turned on, but no model connection is marked as contributed.',
        },
      ],
    });
  }

  const inventory = input.inventory;
  if (!inventory) {
    return manifest({
      projectedAt: input.projectedAt,
      sourceObservedAt: null,
      participation: 'contributed-unavailable',
      models: [],
      diagnostics: [
        {
          connectionId: FLEET_CONTRIBUTION_DIAGNOSTIC_ID,
          code: 'inventory-unavailable',
          message:
            'This Station could not read its own launchable-model inventory, so what it currently contributes is unknown rather than empty.',
        },
      ],
    });
  }

  const models: FleetContributedModel[] = [];
  const diagnostics: FleetContributionDiagnostic[] = [];

  // Whole-Station (not connection-scoped) inventory diagnostics. EVERY one
  // is carried, not just truncation: `refresh-unavailable` means this
  // manifest is built from the last successful snapshot rather than a live
  // read, and dropping it renders an enabled-but-broken Station as a healthy
  // `contributing` with no diagnostics — the exact silent-degradation class
  // §4.5 bans. `discovery-limited` is renamed to the fleet vocabulary
  // because at Station scope it means "this subset may be incomplete";
  // everything else keeps the local code and message an operator would
  // already recognize from the Connections surface.
  let truncated = false;
  for (const item of inventory.diagnostics) {
    if (item.connectionId !== MODEL_INVENTORY_DIAGNOSTIC_ID) continue;
    if (item.code === 'discovery-limited') {
      truncated = true;
      diagnostics.push({
        connectionId: FLEET_CONTRIBUTION_DIAGNOSTIC_ID,
        code: 'inventory-truncated',
        message:
          'The source model inventory hit its bounded limits, so this contributed subset may be incomplete for reasons unrelated to any connection’s own health.',
      });
      continue;
    }
    diagnostics.push(carriedDiagnostic(FLEET_CONTRIBUTION_DIAGNOSTIC_ID, item));
  }

  for (const connectionId of declared) {
    const records = inventory.models.filter(
      (record) => record.connectionId === connectionId,
    );
    const modelRecords = records.filter(
      (record) => record.connectionKind === 'model',
    );

    // Carried through whether or not models were projected: a `stale-catalog`
    // on a connection that still yields models is exactly the degraded state
    // the consumer must see.
    for (const item of inventory.diagnostics) {
      if (item.connectionId !== connectionId) continue;
      diagnostics.push(carriedDiagnostic(connectionId, item));
    }

    if (modelRecords.length > 0) {
      models.push(...modelRecords.map(contributedModel));
      // One diagnostic per DISTINCT non-local locality, not just the first
      // found: a connection reporting both `remote` and `unknown` is making
      // two different unverifiable claims, and naming only one of them hides
      // the other.
      const nonLocalLocalities = [
        ...new Set(
          modelRecords
            .map((record) => record.locality)
            .filter((locality) => locality !== 'local'),
        ),
      ].sort(compareText);
      for (const locality of nonLocalLocalities) {
        diagnostics.push({
          connectionId,
          code: 'contribution-not-local',
          message: `Contributed models on this connection report locality '${locality}'. This Station holds a reference to a model it does not execute itself, so a local-capability check cannot verify it.`,
        });
      }
      continue;
    }

    // `records.length > 0` with no model-kind record means the id resolved
    // to an agent/engine connection. The invariant this depends on:
    // `LaunchableModelRecord.connectionKind` is exactly `'model' | 'agent'`
    // (`model-inventory.ts`), so "resolved but not contributable" and "did
    // not resolve at all" are exhaustive here. A third kind would land in
    // the unknown-connection branch below and read as "no such connection",
    // which would be wrong — revisit both branches if the union grows.
    if (records.length > 0) {
      diagnostics.push({
        connectionId,
        code: 'contribution-unsupported-connection',
        message:
          'This connection is marked as contributed but is not a model connection. Fleet contribution covers model connections only.',
      });
      continue;
    }

    const hasSourceDiagnostic = inventory.diagnostics.some(
      (item) => item.connectionId === connectionId,
    );
    if (hasSourceDiagnostic) continue;

    diagnostics.push(
      truncated
        ? {
            connectionId,
            code: 'inventory-truncated',
            message:
              'This connection is marked as contributed but did not appear in the source inventory, which was truncated by its bounded limits.',
          }
        : {
            connectionId,
            code: 'contribution-unknown-connection',
            message:
              'This connection is marked as contributed but no such connection exists on this Station.',
          },
    );
  }

  return manifest({
    projectedAt: input.projectedAt,
    sourceObservedAt,
    participation:
      models.length > 0 ? 'contributing' : 'contributed-unavailable',
    models,
    diagnostics,
  });
}
