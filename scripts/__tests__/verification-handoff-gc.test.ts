import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { verificationRetentionInventory } from '../lib/verification-retention-inventory.mjs';
import {
  __verificationSubmissionInternals,
  sweepTerminalSubmissionHandoffs,
} from '../lib/verification-submission.mjs';

const key = (index: number) => index.toString(16).padStart(64, '0');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-handoff-gc-'));
  return {
    root,
    write(path: string, value: unknown) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), JSON.stringify(value));
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function terminalHandoff(index: number, updatedAt: number) {
  return {
    generation: 1,
    state: 'settled',
    request: { key: key(index), worktree: '/fixture' },
    updatedAt,
    terminal: { status: 'completed', passed: true },
  };
}

function handoffPath(index: number) {
  return `submissions/${key(index)}/handoff.json`;
}

describe('terminal submission handoff GC', () => {
  test('removes only complete old terminal handoffs beyond the newest reservation and preserves receipt evidence', () => {
    const temp = fixture();
    const now = 20 * 24 * 60 * 60_000;
    const evidencePath =
      'worktree/.kontourai/verification-receipts/receipt.json';
    try {
      for (let index = 0; index < 258; index += 1)
        temp.write(handoffPath(index), {
          ...terminalHandoff(index, index),
          receiptPath: join(temp.root, evidencePath),
        });
      temp.write(evidencePath, { evidence: 'must survive' });

      const result = sweepTerminalSubmissionHandoffs({
        root: temp.root,
        now: () => now,
      });

      expect(result).toMatchObject({
        removed: 2,
        skipped: 0,
        truncated: false,
        nonactionable: false,
      });
      expect(existsSync(join(temp.root, handoffPath(0)))).toBe(false);
      expect(existsSync(join(temp.root, handoffPath(1)))).toBe(false);
      expect(existsSync(join(temp.root, handoffPath(2)))).toBe(true);
      expect(readFileSync(join(temp.root, evidencePath), 'utf8')).toContain(
        'must survive',
      );
      expect(
        verificationRetentionInventory({ root: temp.root }).lastSweep,
      ).toMatchObject({ removed: 2, nonactionable: false });
    } finally {
      temp.remove();
    }
  });

  test('removes zero records from a truncated inventory even when scanned records are eligible', () => {
    const temp = fixture();
    const now = 20 * 24 * 60 * 60_000;
    try {
      temp.write(handoffPath(0), terminalHandoff(0, 0));
      temp.write(handoffPath(1), terminalHandoff(1, 1));

      const result = sweepTerminalSubmissionHandoffs({
        root: temp.root,
        now: () => now,
        policy: { newestTerminal: 0, scanLimit: 1 },
      });

      expect(result).toEqual({
        at: now,
        removed: 0,
        skipped: 0,
        truncated: true,
        nonactionable: true,
      });
      expect(existsSync(join(temp.root, handoffPath(0)))).toBe(true);
      expect(existsSync(join(temp.root, handoffPath(1)))).toBe(true);
    } finally {
      temp.remove();
    }
  });

  test('preserves launching and coordinating handoffs and enforces the removal limit', () => {
    const temp = fixture();
    const now = 20 * 24 * 60 * 60_000;
    try {
      temp.write(handoffPath(0), terminalHandoff(0, 0));
      temp.write(handoffPath(1), terminalHandoff(1, 1));
      temp.write(handoffPath(2), terminalHandoff(2, 2));
      temp.write(handoffPath(3), {
        ...terminalHandoff(3, 3),
        state: 'launching',
      });
      temp.write(handoffPath(4), {
        ...terminalHandoff(4, 4),
        state: 'coordinating',
      });
      temp.write('requests/request/lease.json', { state: 'finished' });
      temp.write('outputs/output/lease.json', { state: 'fenced' });
      temp.write('full-regression.lock/lease.json', { state: 'fenced' });
      temp.write('ownership-loss/loss.json', { state: 'ownership_lost' });

      const result = sweepTerminalSubmissionHandoffs({
        root: temp.root,
        now: () => now,
        policy: { newestTerminal: 0, removeLimit: 1 },
      });

      expect(result).toMatchObject({ removed: 1, skipped: 2 });
      expect(existsSync(join(temp.root, handoffPath(0)))).toBe(false);
      expect(existsSync(join(temp.root, handoffPath(1)))).toBe(true);
      expect(existsSync(join(temp.root, handoffPath(2)))).toBe(true);
      expect(existsSync(join(temp.root, handoffPath(3)))).toBe(true);
      expect(existsSync(join(temp.root, handoffPath(4)))).toBe(true);
      expect(existsSync(join(temp.root, 'requests/request/lease.json'))).toBe(
        true,
      );
      expect(existsSync(join(temp.root, 'outputs/output/lease.json'))).toBe(
        true,
      );
      expect(
        existsSync(join(temp.root, 'full-regression.lock/lease.json')),
      ).toBe(true);
      expect(existsSync(join(temp.root, 'ownership-loss/loss.json'))).toBe(
        true,
      );
    } finally {
      temp.remove();
    }
  });

  test('keeps a terminal handoff while a retry claimant owns the shared boundary', () => {
    const temp = fixture();
    const now = 20 * 24 * 60 * 60_000;
    const directory = join(temp.root, 'submissions', key(0));
    try {
      temp.write(handoffPath(0), terminalHandoff(0, 0));
      const claim = __verificationSubmissionInternals.acquireRetryClaim({
        directory,
        now: () => now,
      });
      expect(claim.owned).toBe(true);

      const result = sweepTerminalSubmissionHandoffs({
        root: temp.root,
        now: () => now,
        policy: { newestTerminal: 0 },
      });

      expect(result).toMatchObject({ removed: 0, skipped: 1 });
      expect(existsSync(join(temp.root, handoffPath(0)))).toBe(true);
      __verificationSubmissionInternals.releaseRetryClaim(claim);
    } finally {
      temp.remove();
    }
  });

  test('deletes only its quarantine and preserves a successor published during the TOCTOU window', () => {
    const temp = fixture();
    const now = 20 * 24 * 60 * 60_000;
    let contender: { retrying?: boolean } | undefined;
    try {
      temp.write(handoffPath(0), terminalHandoff(0, 0));

      const result = sweepTerminalSubmissionHandoffs({
        root: temp.root,
        now: () => now,
        policy: { newestTerminal: 0 },
        gcHooks: {
          afterQuarantine: ({ directory }: { directory: string }) => {
            contender = __verificationSubmissionInternals.acquireHandoff({
              root: temp.root,
              request: terminalHandoff(0, 0).request,
              now: () => now,
            });
            mkdirSync(directory, { recursive: true });
            writeFileSync(
              join(directory, 'handoff.json'),
              JSON.stringify({ ...terminalHandoff(0, now), generation: 2 }),
            );
          },
        },
      });

      expect(result).toMatchObject({ removed: 1 });
      expect(contender).toMatchObject({ retrying: true });
      expect(
        JSON.parse(readFileSync(join(temp.root, handoffPath(0)), 'utf8')),
      ).toMatchObject({ generation: 2, updatedAt: now });
      expect(
        readdirSync(join(temp.root, 'submissions')).filter((entry) =>
          entry.includes('.gc-'),
        ),
      ).toEqual([]);
    } finally {
      temp.remove();
    }
  });

  test('retains corrupt handoffs and reports them as skipped', () => {
    const temp = fixture();
    const now = 20 * 24 * 60 * 60_000;
    try {
      temp.write(handoffPath(0), terminalHandoff(0, 0));
      mkdirSync(join(temp.root, 'submissions', key(1)), { recursive: true });
      writeFileSync(join(temp.root, handoffPath(1)), '{');
      temp.write(handoffPath(2), {
        ...terminalHandoff(2, 2),
        request: { key: key(0) },
      });

      const result = sweepTerminalSubmissionHandoffs({
        root: temp.root,
        now: () => now,
        policy: { newestTerminal: 0 },
      });

      expect(result).toMatchObject({ removed: 1, skipped: 2 });
      expect(readFileSync(join(temp.root, handoffPath(1)), 'utf8')).toBe('{');
      expect(existsSync(join(temp.root, handoffPath(2)))).toBe(true);
    } finally {
      temp.remove();
    }
  });

  test('retains a candidate whose full terminal record changes before quarantine', () => {
    const temp = fixture();
    const now = 20 * 24 * 60 * 60_000;
    try {
      temp.write(handoffPath(0), terminalHandoff(0, 0));

      const result = sweepTerminalSubmissionHandoffs({
        root: temp.root,
        now: () => now,
        policy: { newestTerminal: 0 },
        gcHooks: {
          beforeQuarantine: ({ directory }: { directory: string }) => {
            writeFileSync(
              join(directory, 'handoff.json'),
              JSON.stringify({
                ...terminalHandoff(0, 0),
                terminal: { status: 'rejected', passed: false },
                receiptPath: '/replacement/receipt.json',
              }),
            );
          },
        },
      });

      expect(result).toMatchObject({ removed: 0, skipped: 1 });
      expect(
        JSON.parse(readFileSync(join(temp.root, handoffPath(0)), 'utf8')),
      ).toMatchObject({
        terminal: { status: 'rejected', passed: false },
        receiptPath: '/replacement/receipt.json',
      });
    } finally {
      temp.remove();
    }
  });
});
