/**
 * archive#1398/4 — the consuming Station's LOCAL-ONLY routing-receipt
 * log (`docs/design/inference-fleet.md` §3.4, §10 OQ-3/OQ-4, §11 slices 3–4).
 *
 * The integrity machinery — content-addressed ids, the backward chain, the
 * head anchor that makes tail truncation visible, and the three-state read
 * verdict — lives in `receipt-chain.ts` and is shared byte-for-byte with the
 * serving side's log (archive#1398 security review, M-2/M-6). This module is
 * the routing-specific shell around it.
 *
 * **Local-only (§10 OQ-4).** Written by the deciding Station, mode 0600 in a
 * 0700 directory, never replicated to a peer.
 *
 * **A receipt nobody can read is a log, not a receipt** (§3.4). Hence
 * {@link readFleetRoutingReceipts}, which slice 4's route and both surfaces
 * consume — bounded from the tail so an append-only file cannot turn the
 * Station's own UI into a full-file parse.
 */

import { join } from 'node:path';
import type {
  FleetRoutingReceiptEnvelope,
  FleetRoutingReceiptPage,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  FLEET_ROUTING_RECEIPT_READ_LIMITS,
  FLEET_ROUTING_RECEIPT_SCHEMA_VERSION,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  canonicalize,
  computeChainedReceiptId,
  HashChainedReceiptLog,
  readChainedReceipts,
} from './receipt-chain.js';

export { canonicalize };

export const FLEET_ROUTING_RECEIPT_DIRECTORY = 'monitoring';
export const FLEET_ROUTING_RECEIPT_FILE = 'fleet-routing-receipts.ndjson';

export function fleetRoutingReceiptPath(projectHomeDir: string): string {
  return join(
    projectHomeDir,
    FLEET_ROUTING_RECEIPT_DIRECTORY,
    FLEET_ROUTING_RECEIPT_FILE,
  );
}

/**
 * The content address of an envelope. Exported because a reader recomputing
 * it is the whole point of content addressing — a receipt whose id only its
 * writer can reproduce is a serial number.
 */
export function computeReceiptId(
  envelope: Omit<FleetRoutingReceiptEnvelope, 'receiptId'>,
): string {
  return computeChainedReceiptId(
    envelope as unknown as Record<string, unknown>,
  );
}

export class FleetRoutingReceiptLog {
  readonly #log: HashChainedReceiptLog<FleetRoutingReceiptEnvelope>;

  constructor(projectHomeDir: string) {
    this.#log = new HashChainedReceiptLog(
      fleetRoutingReceiptPath(projectHomeDir),
      join(projectHomeDir, FLEET_ROUTING_RECEIPT_DIRECTORY),
    );
  }

  async append(
    envelope: Omit<
      FleetRoutingReceiptEnvelope,
      'receiptId' | 'previousReceiptId' | 'schemaVersion' | 'signature'
    >,
  ): Promise<FleetRoutingReceiptEnvelope> {
    return this.#log.append(
      {
        ...envelope,
        schemaVersion: FLEET_ROUTING_RECEIPT_SCHEMA_VERSION,
        signature: null,
      },
      (body, receiptId) => ({ ...body, receiptId }),
    );
  }
}

export async function readFleetRoutingReceipts(
  projectHomeDir: string,
  limit: number = FLEET_ROUTING_RECEIPT_READ_LIMITS.defaultLimit,
): Promise<FleetRoutingReceiptPage> {
  const bounded = Math.max(
    1,
    Math.min(limit, FLEET_ROUTING_RECEIPT_READ_LIMITS.maxLimit),
  );
  const page = await readChainedReceipts<FleetRoutingReceiptEnvelope>(
    fleetRoutingReceiptPath(projectHomeDir),
    bounded,
    FLEET_ROUTING_RECEIPT_READ_LIMITS.maxScannedRecords,
    'No fleet routing has been receipted on this Station yet.',
  );
  return {
    schemaVersion: FLEET_ROUTING_RECEIPT_SCHEMA_VERSION,
    receipts: page.receipts,
    totalRecords: page.totalRecords,
    chain: page.verdict,
  };
}
