/**
 * archive#1398 — the SERVING Station's own receipt log
 * (`docs/design/inference-fleet.md` §3.4 "Both sides record").
 *
 * A consumer-authored record of a producer's behavior is a claim, not
 * evidence. The routing envelope on Station A says where A decided to send a
 * turn; this file is B's independent account of what it actually served, to
 * which peer, and how it ended. The two can be compared, which is the whole
 * point of both existing.
 *
 * **It is readable, because the doc's own rule applies to it too** (security
 * review, M-2): "an NDJSON file under `~/.station` that no surface reads is
 * not a receipt, it is a log." {@link readFleetServeReceipts} carries the
 * SAME three-state chain verdict as the routing log — same substrate, same
 * vocabulary, same head anchor — and the monitoring surface renders both.
 * A serve log only the filesystem could see was ceremony dressed as
 * provenance.
 *
 * Digests, never content: no prompt text, no completion text, no upstream
 * error string, and the peer identified by a credential FINGERPRINT rather
 * than the credential.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  FleetServeReceipt,
  FleetServeReceiptPage,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  FLEET_ROUTING_RECEIPT_READ_LIMITS,
  FLEET_SERVE_RECEIPT_SCHEMA_VERSION,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { FLEET_ROUTING_RECEIPT_DIRECTORY } from '../../runtime/conversation/fleet-routing-receipt-log.js';
import {
  canonicalize,
  HashChainedReceiptLog,
  readChainedReceipts,
} from '../../runtime/conversation/receipt-chain.js';
import { fleetServeReceiptsTotal } from '../../telemetry/metrics.js';

export const FLEET_SERVE_RECEIPT_FILE = 'fleet-serve-receipts.ndjson';

export type UnsealedFleetServeReceipt = Omit<
  FleetServeReceipt,
  'receiptId' | 'previousReceiptId' | 'schemaVersion' | 'signature'
>;

export type { FleetServeReceiptPage };

export function fleetServeReceiptPath(projectHomeDir: string): string {
  return join(
    projectHomeDir,
    FLEET_ROUTING_RECEIPT_DIRECTORY,
    FLEET_SERVE_RECEIPT_FILE,
  );
}

/**
 * `SHA-256(credential)`. Never the credential itself: this file lives on the
 * serving operator's disk, and a log that stores a peer's bearer token turns
 * a routing record into a credential store.
 */
export function peerFingerprint(
  authorizationHeader: string | null | undefined,
): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match?.[1]) return null;
  return createHash('sha256').update(match[1]).digest('hex');
}

/** SHA-256 over the canonicalized request messages. Never the messages. */
export function promptDigest(messages: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(messages)) ?? 'null')
    .digest('hex');
}

export class FleetServeReceiptLog {
  readonly #log: HashChainedReceiptLog<FleetServeReceipt>;

  constructor(projectHomeDir: string) {
    this.#log = new HashChainedReceiptLog(
      fleetServeReceiptPath(projectHomeDir),
      join(projectHomeDir, FLEET_ROUTING_RECEIPT_DIRECTORY),
    );
  }

  async append(receipt: UnsealedFleetServeReceipt): Promise<FleetServeReceipt> {
    const sealed = await this.#log.append(
      {
        ...receipt,
        schemaVersion: FLEET_SERVE_RECEIPT_SCHEMA_VERSION,
        signature: null,
      },
      (body, receiptId) => ({ ...body, receiptId }),
    );
    // Success-only counter, and it is named as such. The failure path has its
    // own counter plus a logger.error at the call site — a metric that only
    // ever increments on success cannot be "the observable signal" for a
    // failure, which is what the first cut of the route claimed it was
    // (security review, M-2).
    fleetServeReceiptsTotal.add(1, {
      outcome: sealed.outcome,
      ...(sealed.refusalCode ? { code: sealed.refusalCode } : {}),
    });
    return sealed;
  }
}

export async function readFleetServeReceipts(
  projectHomeDir: string,
  limit: number = FLEET_ROUTING_RECEIPT_READ_LIMITS.defaultLimit,
): Promise<FleetServeReceiptPage> {
  const bounded = Math.max(
    1,
    Math.min(limit, FLEET_ROUTING_RECEIPT_READ_LIMITS.maxLimit),
  );
  const page = await readChainedReceipts<FleetServeReceipt>(
    fleetServeReceiptPath(projectHomeDir),
    bounded,
    FLEET_ROUTING_RECEIPT_READ_LIMITS.maxScannedRecords,
    'This Station has not served any fleet inference yet.',
  );
  return {
    schemaVersion: FLEET_SERVE_RECEIPT_SCHEMA_VERSION,
    receipts: page.receipts,
    totalRecords: page.totalRecords,
    chain: page.verdict,
  };
}
