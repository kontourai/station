/**
 * station#1398 security review round 2, M-2 — the anchor/log READ ORDER.
 *
 * `readChainedReceipts` performs two independent reads against a file another
 * turn may be appending to. Which one goes first decides what a concurrent
 * append does to the verdict:
 *
 * - anchor first → the log is the fresher of the two, `totalRecords` is >= the
 *   anchored count, and the truncation branch cannot fire. The verdict
 *   under-claims at worst.
 * - log first → the anchor is the fresher one, `totalRecords` is BEHIND it,
 *   and a healthy log reports "truncated" on both surfaces. Crying tamper at
 *   a working system is precisely what `receipt-chain.ts`'s own docblock says
 *   trains readers to ignore verdicts.
 *
 * This lives in its own file because proving an ordering needs `readFile`
 * itself instrumented, and the sibling suite must keep exercising the real
 * one. The instrumentation returns each file's PRE-append content and lets
 * the append land immediately afterwards — the exact interleaving a real
 * concurrent turn produces, and the only shape that discriminates between the
 * two orders. (An earlier attempt simulated the race by writing a stale
 * anchor to disk; that leaves identical bytes for both orders, so it passed
 * against the injected regression and proved nothing.)
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const readFileSpy = vi.hoisted(() => ({ impl: undefined as unknown }));

vi.mock('node:fs/promises', async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  return {
    ...actual,
    default: actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      typeof readFileSpy.impl === 'function'
        ? (readFileSpy.impl as typeof actual.readFile)(...args)
        : actual.readFile(...args),
  };
});

/**
 * The UNMOCKED module. The instrumentation below must not call the mocked
 * `readFile` — that recurses into itself, which the first cut of this test
 * did while still reporting green (the RangeErrors were swallowed by the
 * promise chain). Every real I/O in this file goes through `fs`.
 */
const fs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const { mkdtemp, readFile, writeFile } = fs;

const {
  FleetRoutingReceiptLog,
  fleetRoutingReceiptPath,
  readFleetRoutingReceipts,
} = await import('../fleet-routing-receipt-log.js');

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

afterEach(() => {
  readFileSpy.impl = undefined;
});

describe('a concurrent append must not read as tampering', () => {
  it('verifies a healthy log when a full append lands between the two reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'station-read-order-'));
    const log = new FleetRoutingReceiptLog(dir);
    await log.append(envelope('one'));
    await log.append(envelope('two'));

    // Each read returns the state as it was when the read STARTED; the third
    // record lands right after the first of the two reads completes.
    let appended = false;
    readFileSpy.impl = async (path: string, encoding: BufferEncoding) => {
      const before = await readFile(path, encoding);
      if (!appended) {
        appended = true;
        await new FleetRoutingReceiptLog(dir).append(envelope('three'));
      }
      return before;
    };

    const page = await readFleetRoutingReceipts(dir);
    readFileSpy.impl = undefined;

    // Anchor-first means the log read is the fresher one, so the log can only
    // be AHEAD of the anchor — never behind it, which is the only state that
    // means truncation.
    expect(page.chain.status).not.toBe('broken');
    expect(page.chain.message).not.toContain('truncated');
  });

  it('still reports a genuinely truncated log as broken', async () => {
    // The mirror: no race, records actually removed. The fix must not have
    // degenerated into ignoring the anchor.
    const dir = await mkdtemp(join(tmpdir(), 'station-read-order-'));
    const log = new FleetRoutingReceiptLog(dir);
    await log.append(envelope('one'));
    await log.append(envelope('two'));
    const path = fleetRoutingReceiptPath(dir);
    const lines = (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    await writeFile(path, `${lines[0]}\n`, 'utf8');

    const page = await readFleetRoutingReceipts(dir);
    expect(page.chain.status).toBe('broken');
    expect(page.chain.message).toContain('truncated');
  });
});
