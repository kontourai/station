/**
 * archive#1398/4 — the hash chain. The point of chaining rather
 * than per-record digesting is that a DELETED record is detectable, so the
 * deletion case is the load-bearing test here.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FleetRoutingReceiptLog,
  fleetRoutingReceiptPath,
  readFleetRoutingReceipts,
} from '../fleet-routing-receipt-log.js';
import { verifyChain } from '../receipt-chain.js';

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'station-fleet-receipts-'));
}

function envelope(agentName: string) {
  return {
    recordedAt: '2026-08-01T12:00:00.000Z',
    environmentId: 'env-laptop',
    agentName,
    dispatch: {
      schemaVersion: 1,
      planDigest: 'plan',
      requestDigest: 'request',
      role: 'station-agent',
      outcome: 'succeeded',
      attempts: [],
      totalElapsedMs: 1,
      totalTokens: 0,
      estimatedCostUsd: 0,
    },
    candidates: [],
    exclusions: [],
    constraints: [],
    stream: { capable: false, reason: 'buffered' },
    selection: null,
    failure: null,
    interactivity: 'non-interactive' as const,
  };
}

describe('routing receipts are chained by content digest', () => {
  it('links each record to the one before it and verifies a whole log', async () => {
    const dir = await home();
    const log = new FleetRoutingReceiptLog(dir);
    const first = await log.append(envelope('one'));
    const second = await log.append(envelope('two'));

    expect(first.previousReceiptId).toBeNull();
    expect(second.previousReceiptId).toBe(first.receiptId);
    expect(first.signature).toBeNull();

    const page = await readFleetRoutingReceipts(dir);
    expect(page.chain.status).toBe('intact');
    // Newest first.
    expect(page.receipts.map((r) => r.agentName)).toEqual(['two', 'one']);
    expect(page.chain.message).toContain('not signed');
  });

  it('reports a tampered record as broken rather than rendering it', async () => {
    const dir = await home();
    const log = new FleetRoutingReceiptLog(dir);
    await log.append(envelope('one'));
    const path = fleetRoutingReceiptPath(dir);
    const raw = await readFile(path, 'utf8');
    await writeFile(path, raw.replace('"one"', '"edited"'), 'utf8');

    const page = await readFleetRoutingReceipts(dir);
    expect(page.chain.status).toBe('broken');
    // An in-place edit leaves the id — and therefore the head anchor — intact,
    // so the per-record digest is what catches it, and the message says so
    // rather than blaming the anchor.
    expect(page.chain.message).toContain(
      'does not match its own content digest',
    );
  });

  it('THE TRUNCATION CASE: dropping the newest records must not read as intact', async () => {
    // Security review, M-6. This is the tampering the chain alone cannot see:
    // every surviving record still matches its own digest and still links to
    // its predecessor, so before the head anchor existed this log verified
    // `intact` — and tail truncation is both the easiest edit to perform and
    // the one a receipt log most needs to resist.
    const dir = await home();
    const log = new FleetRoutingReceiptLog(dir);
    await log.append(envelope('one'));
    await log.append(envelope('two'));
    await log.append(envelope('three'));
    const path = fleetRoutingReceiptPath(dir);
    const lines = (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    await writeFile(path, `${lines[0]}\n`, 'utf8');

    const page = await readFleetRoutingReceipts(dir);
    expect(page.chain.status).toBe('broken');
    expect(page.chain.message).toContain('truncated');
    expect(page.chain.message).toContain('3 record(s)');
  });

  it('says unknown — never intact — when the head anchor is missing', async () => {
    const dir = await home();
    await new FleetRoutingReceiptLog(dir).append(envelope('one'));
    await rm(`${fleetRoutingReceiptPath(dir)}.anchor.json`);

    const page = await readFleetRoutingReceipts(dir);
    expect(page.chain.status).toBe('unknown');
    expect(page.chain.message).toContain('no head anchor');
  });

  it('detects a DELETED middle record — the reason the chain exists', async () => {
    const dir = await home();
    const log = new FleetRoutingReceiptLog(dir);
    await log.append(envelope('one'));
    await log.append(envelope('two'));
    await log.append(envelope('three'));
    const path = fleetRoutingReceiptPath(dir);
    const lines = (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    // Remove the middle record. Every remaining record still matches its own
    // digest — only the LINK is missing, which a per-record digest scheme
    // could not see at all.
    await writeFile(path, `${lines[0]}\n${lines[2]}\n`, 'utf8');

    const page = await readFleetRoutingReceipts(dir);
    expect(page.chain.status).toBe('broken');
  });

  it('bounds what it DISPLAYS without narrowing what it VERIFIED', async () => {
    const dir = await home();
    const log = new FleetRoutingReceiptLog(dir);
    await log.append(envelope('one'));
    await log.append(envelope('two'));

    const page = await readFleetRoutingReceipts(dir, 1);
    expect(page.receipts).toHaveLength(1);
    expect(page.totalRecords).toBe(2);
    // Verification still covered both records even though only one is
    // returned — and the message says so, rather than implying the verdict
    // covers only what is on screen.
    expect(page.chain.status).toBe('intact');
    expect(page.chain.message).toContain('All 2 record(s)');
  });

  it('refuses to claim intact when the scan did not reach the first record', async () => {
    const dir = await home();
    const log = new FleetRoutingReceiptLog(dir);
    await log.append(envelope('one'));
    const path = fleetRoutingReceiptPath(dir);
    const real = (await readFile(path, 'utf8')).trim();
    // A record this build cannot parse ahead of a good one: the scan can no
    // longer prove anything about what came before it.
    await writeFile(path, `not-json\n${real}\n`, 'utf8');

    const page = await readFleetRoutingReceipts(dir);
    expect(page.chain.status).toBe('broken');
    expect(page.chain.message).toContain('could not be read');
  });

  it('recovers the chain head across process restarts', async () => {
    const dir = await home();
    const first = await new FleetRoutingReceiptLog(dir).append(envelope('one'));
    // A brand-new instance, as after a restart: it must NOT start a second
    // chain that verifies in isolation while hiding everything before it.
    const second = await new FleetRoutingReceiptLog(dir).append(
      envelope('two'),
    );
    expect(second.previousReceiptId).toBe(first.receiptId);
    expect((await readFleetRoutingReceipts(dir)).chain.status).toBe('intact');
  });

  it('reports an empty log as empty, and a missing one as never-routed', async () => {
    const page = await readFleetRoutingReceipts(await home());
    expect(page.receipts).toHaveLength(0);
    expect(page.totalRecords).toBe(0);
    expect(page.chain.message).toContain('No fleet routing has been receipted');
  });
});

describe('the anchor/log read skew is one-directional (round 2, M-2)', () => {
  it('the skew is one-directional: log BEHIND anchor is still broken', () => {
    // Guards the fix from degenerating into "ignore the anchor". Verified
    // directly against the predicate so both directions are asserted in one
    // place: log ahead of anchor (a concurrent append) is fine, log behind
    // anchor (records removed) is the real signal.
    const anchor = { lastReceiptId: 'x'.repeat(64), recordCount: 3 };
    const ahead = verifyChain({
      parsed: [],
      firstScannedIndex: 0,
      totalRecords: 4,
      malformed: 0,
      anchor,
    });
    expect(ahead.status).not.toBe('broken');

    const behind = verifyChain({
      parsed: [],
      firstScannedIndex: 0,
      totalRecords: 2,
      malformed: 0,
      anchor,
    });
    expect(behind.status).toBe('broken');
    expect(behind.message).toContain('truncated');
  });
});
