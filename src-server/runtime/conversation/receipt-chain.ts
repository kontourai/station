/**
 * station#1398 — the hash-chained receipt substrate shared by BOTH sides
 * (`docs/design/inference-fleet.md` §3.4, §10 OQ-3/OQ-4).
 *
 * Extracted in the security-review round for two reasons that are the same
 * reason: the consuming Station's routing log and the serving Station's
 * serve log must make the SAME integrity claims, and they must be readable
 * with the same verdict vocabulary. Two hand-written chains drift, and a
 * chain whose verdict means something slightly different on each surface is
 * worse than no verdict.
 *
 * **"Receipted", not "signed" (§10 OQ-3).** Nothing in the building-block
 * layer signs anything — Dispatch, Relay, Bearing, Datum and Conduit all
 * integrity-protect with SHA-256 content digests and nothing else. This
 * extends that discipline: `receiptId` is the digest of the record's own
 * canonicalized content, `previousReceiptId` links it to the one before, and
 * `signature` stays `null`.
 *
 * **What the chain alone cannot see, and the anchor fixes** (security review,
 * M-6). A per-record digest catches an edit. A backward link catches a
 * DELETED middle record, because the record after it no longer links. Neither
 * catches TAIL truncation: drop the newest N records and every survivor still
 * matches its own digest and still links to its predecessor, so a naive
 * verifier reports `intact` for a log somebody just trimmed — which is the
 * easiest tampering to perform and the one a receipt most needs to resist.
 * So each log keeps a small head anchor beside it ({@link ReceiptChainAnchor}:
 * the newest `receiptId` and the record count), rewritten atomically after
 * every append and checked on every read.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { canonicalizeForDigest } from '@kontourai/station-contracts/fleet-routing-receipt';

export { canonicalizeForDigest as canonicalize };

/** Every chained receipt carries these; the payload above them is the log's own. */
export interface ChainedReceipt {
  receiptId: string;
  previousReceiptId: string | null;
}

/**
 * The head anchor. Deliberately tiny and deliberately NOT chained itself:
 * it is a tripwire, not a second source of truth. An attacker who can edit
 * the log can also edit the anchor — the anchor's job is to make truncation
 * take two coordinated edits instead of one `head -n -1`, and to make an
 * anchor that has been removed report `unknown` rather than `intact`.
 */
export interface ReceiptChainAnchor {
  lastReceiptId: string;
  recordCount: number;
}

/** Three-state, because "we did not check" must never render as "it verified". */
export type ReceiptChainStatus = 'intact' | 'broken' | 'unknown';

export interface ReceiptChainVerdict {
  status: ReceiptChainStatus;
  brokenAtReceiptId: string | null;
  message: string;
}

/** SHA-256 over the canonicalized record with `receiptId` removed. */
export function computeChainedReceiptId(
  record: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForDigest(record)))
    .digest('hex');
}

function anchorPathFor(logPath: string): string {
  return `${logPath}.anchor.json`;
}

/**
 * Atomic anchor write: temp file, fsync, rename. The same shape
 * `SshEnvironmentProfileStore` and `PeerCredentialStore` use — a torn anchor
 * would report `broken` on a perfectly good log, which trains readers to
 * ignore the verdict.
 */
function writeAnchorSync(logPath: string, anchor: ReceiptChainAnchor): void {
  const target = anchorPathFor(logPath);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(anchor)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const handle = openSync(temp, 'r');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Best-effort cleanup; the throw below is the signal that matters.
    }
    throw error;
  }
}

async function readAnchor(
  logPath: string,
): Promise<ReceiptChainAnchor | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(anchorPathFor(logPath), 'utf8'),
    ) as ReceiptChainAnchor;
    if (
      typeof parsed?.lastReceiptId !== 'string' ||
      typeof parsed?.recordCount !== 'number'
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Appends one sealed record and re-anchors the head.
 *
 * The chain head is recovered from the FILE on the first append of a process,
 * never assumed empty: a restart that started a second chain would verify in
 * isolation while hiding everything written before it.
 */
export class HashChainedReceiptLog<TSealed extends ChainedReceipt> {
  readonly #path: string;
  readonly #directory: string;
  #head: string | null | undefined;
  #count: number | undefined;

  constructor(path: string, directory: string) {
    this.#path = path;
    this.#directory = directory;
  }

  async append(
    unsealed: Omit<TSealed, 'receiptId' | 'previousReceiptId'>,
    seal: (
      body: Omit<TSealed, 'receiptId'> & { previousReceiptId: string | null },
      receiptId: string,
    ) => TSealed,
  ): Promise<TSealed> {
    if (this.#head === undefined || this.#count === undefined) {
      const recovered = await this.#recoverHead();
      this.#head = recovered.lastReceiptId;
      this.#count = recovered.recordCount;
    }
    const body = {
      ...unsealed,
      previousReceiptId: this.#head,
    } as Omit<TSealed, 'receiptId'> & { previousReceiptId: string | null };
    const sealed = seal(
      body,
      computeChainedReceiptId(body as unknown as Record<string, unknown>),
    );

    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await appendFile(this.#path, `${JSON.stringify(sealed)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    this.#head = sealed.receiptId;
    this.#count += 1;
    writeAnchorSync(this.#path, {
      lastReceiptId: sealed.receiptId,
      recordCount: this.#count,
    });
    return sealed;
  }

  async #recoverHead(): Promise<{
    lastReceiptId: string | null;
    recordCount: number;
  }> {
    try {
      const lines = (await readFile(this.#path, 'utf8'))
        .split('\n')
        .filter((line) => line.trim().length > 0);
      const last = lines[lines.length - 1];
      if (!last) return { lastReceiptId: null, recordCount: 0 };
      const parsed = JSON.parse(last) as ChainedReceipt;
      return {
        lastReceiptId:
          typeof parsed.receiptId === 'string' ? parsed.receiptId : null,
        recordCount: lines.length,
      };
    } catch {
      return { lastReceiptId: null, recordCount: 0 };
    }
  }
}

export interface ChainedReceiptPage<TSealed extends ChainedReceipt> {
  receipts: TSealed[];
  totalRecords: number;
  verdict: ReceiptChainVerdict;
}

/**
 * Reads the newest `limit` records, newest first, and verifies the chain.
 *
 * **The verification window and the display window are different, on
 * purpose.** Verification runs over every record this read parsed (bounded by
 * `maxScannedRecords`); `limit` only bounds how many are RETURNED, and the
 * message states how many were actually checked rather than implying it
 * checked what it displayed.
 *
 * Verdict order is deliberate — the most specific true statement wins:
 * truncation (anchor says there were more) before a per-record digest
 * mismatch before a broken link before an unreadable record, and `unknown`
 * for every case where the read genuinely could not see enough: a log with no
 * anchor beside it (truncation of the newest records cannot be ruled out), or
 * a scan that did not reach the first record.
 */
export async function readChainedReceipts<TSealed extends ChainedReceipt>(
  logPath: string,
  limit: number,
  maxScannedRecords: number,
  emptyMessage: string,
): Promise<ChainedReceiptPage<TSealed>> {
  // ORDER MATTERS, and it is the safe direction (security review round 2,
  // M-2). Reading the log first and the anchor second lets a concurrent
  // append land between the two reads, so a healthy log is compared against
  // an anchor that has already counted the new record — and reports
  // "truncated" for a log nobody touched. A false alarm on a tamper-detection
  // verdict is the thing this module's own docblock says trains readers to
  // ignore verdicts.
  //
  // Anchor-then-log skews the only way that stays honest: a concurrent append
  // makes the LOG the longer of the two, and `totalRecords >= recordCount`
  // never trips the truncation branch. The extra record simply sits past the
  // anchored position, where the per-record digest and link checks still
  // cover it and the verdict lands on `intact`/`unknown` rather than
  // `broken`. Under-claiming during a race is survivable; crying tamper is
  // not.
  const anchor = await readAnchor(logPath);

  let raw: string;
  try {
    raw = await readFile(logPath, 'utf8');
  } catch {
    return {
      receipts: [],
      totalRecords: 0,
      verdict: {
        status: 'intact',
        brokenAtReceiptId: null,
        message: emptyMessage,
      },
    };
  }

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const totalRecords = lines.length;
  const scanned = lines.slice(-maxScannedRecords);
  const firstScannedIndex = totalRecords - scanned.length;
  const parsed: TSealed[] = [];
  let malformed = 0;
  for (const line of scanned) {
    try {
      parsed.push(JSON.parse(line) as TSealed);
    } catch {
      malformed += 1;
    }
  }

  const verdict = verifyChain({
    parsed,
    firstScannedIndex,
    totalRecords,
    malformed,
    anchor,
  });
  return { receipts: parsed.slice(-limit).reverse(), totalRecords, verdict };
}

export function verifyChain<TSealed extends ChainedReceipt>(input: {
  parsed: TSealed[];
  firstScannedIndex: number;
  totalRecords: number;
  malformed: number;
  anchor: ReceiptChainAnchor | undefined;
}): ReceiptChainVerdict {
  const { parsed, firstScannedIndex, totalRecords, malformed, anchor } = input;

  // 1. Truncation, checked FIRST: it is the only tampering every other check
  //    below reports as `intact`, so a later check "passing" must never get
  //    to speak before this one.
  if (anchor) {
    if (totalRecords < anchor.recordCount) {
      return {
        status: 'broken',
        brokenAtReceiptId: anchor.lastReceiptId,
        message: `This receipt log has been truncated: its head anchor records ${anchor.recordCount} record(s) and only ${totalRecords} remain.`,
      };
    }
    const anchoredOffset = anchor.recordCount - 1 - firstScannedIndex;
    const anchored = parsed[anchoredOffset];
    if (
      anchoredOffset >= 0 &&
      anchoredOffset < parsed.length &&
      anchored &&
      anchored.receiptId !== anchor.lastReceiptId
    ) {
      return {
        status: 'broken',
        brokenAtReceiptId: anchor.lastReceiptId,
        message:
          'This receipt log does not match its head anchor: the record the anchor names has been replaced.',
      };
    }
  }

  for (let index = 0; index < parsed.length; index += 1) {
    const record = parsed[index]!;
    const { receiptId, ...rest } = record;
    if (
      computeChainedReceiptId(rest as Record<string, unknown>) !== receiptId
    ) {
      return {
        status: 'broken',
        brokenAtReceiptId: receiptId,
        message:
          'This receipt log has been edited: a record does not match its own content digest.',
      };
    }
    const previous = parsed[index - 1];
    if (previous && record.previousReceiptId !== previous.receiptId) {
      return {
        status: 'broken',
        brokenAtReceiptId: receiptId,
        message:
          'This receipt log has been edited or truncated: a record does not link to the one before it.',
      };
    }
  }

  if (malformed > 0) {
    return {
      status: 'broken',
      brokenAtReceiptId: null,
      message: `This receipt log contains ${malformed} record(s) that could not be read, so the chain cannot be verified across them.`,
    };
  }

  if (!anchor) {
    // No anchor beside a non-empty log. Every record checked out, but tail
    // truncation is exactly the case the records cannot self-report, so this
    // is `unknown` — not `intact`.
    return {
      status: 'unknown',
      brokenAtReceiptId: null,
      message: `All ${parsed.length} record(s) read match their own content digest and link correctly, but this log has no head anchor, so records removed from the end cannot be ruled out.`,
    };
  }

  if (firstScannedIndex > 0) {
    return {
      status: 'unknown',
      brokenAtReceiptId: null,
      message: `The chain verified across the ${parsed.length} most recent record(s) and matches this log's head anchor, but older records were not read, so nothing is claimed about them.`,
    };
  }

  return {
    status: 'intact',
    brokenAtReceiptId: null,
    message: `All ${parsed.length} record(s) in this log match their own content digest, link to the one before, and match this log's head anchor. Receipted by content digest — not signed.`,
  };
}
