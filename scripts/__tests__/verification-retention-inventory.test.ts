import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { verificationStatus } from '../lib/verification-coordinator.mjs';
import {
  DEFAULT_VERIFICATION_RETENTION_POLICY,
  verificationRetentionInventory,
} from '../lib/verification-retention-inventory.mjs';

const key = (suffix: string) => suffix.padStart(64, 'a');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-retention-inventory-'));
  return {
    root,
    write(path: string, value: unknown) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), JSON.stringify(value));
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('verification retention inventory', () => {
  test('uses terminal handoffs only while reporting bounded fence and ownership aggregates', () => {
    const temp = fixture();
    const now = 10_000;
    const retainedPath = `submissions/${key('1')}/handoff.json`;
    try {
      temp.write(retainedPath, {
        state: 'settled',
        generation: 1,
        request: { key: key('1') },
        updatedAt: now - 2_000,
        error: '/private/secret/output',
      });
      temp.write(`submissions/${key('2')}/handoff.json`, {
        state: 'settled',
        generation: 1,
        request: { key: key('2') },
        updatedAt: now - 1_000,
      });
      temp.write(`submissions/${key('3')}/handoff.json`, {
        state: 'launching',
        request: { key: 'launch-secret' },
      });
      temp.write(`submissions/${key('4')}/handoff.json`, {
        state: 'coordinating',
        request: { key: 'coordinate-secret' },
      });
      temp.write(`submissions/${key('5')}.retry-claim/lease.json`, {
        owner: { nonce: 'claim-secret' },
      });
      temp.write('requests/request/lease.json', {
        state: 'finished',
        finishedAt: now - 2_000,
      });
      temp.write('outputs/output/lease.json', {
        state: 'fenced',
        recoveryPending: true,
      });
      temp.write('full-regression.lock/lease.json', {
        state: 'fenced',
        recoveryPending: true,
      });
      temp.write('full-regression.queue.lock/lease.json', {
        state: 'completion_queue',
      });
      temp.write('ownership-loss/loss.json', { state: 'ownership_lost' });
      const before = readFileSync(join(temp.root, retainedPath), 'utf8');

      const inventory = verificationRetentionInventory({
        root: temp.root,
        now,
        policy: { terminalTtlMs: 100, newestTerminal: 1, scanLimit: 10 },
      });

      expect(inventory).toMatchObject({
        policy: {
          terminalTtlMs: 100,
          newestTerminal: 1,
          scanLimit: 10,
          removeLimit: 64,
        },
        terminal: { retained: 2, eligible: 1, complete: true },
        handoffs: { launching: 1, coordinating: 1, retryClaims: 1 },
        fences: {
          requests: { retained: 1, fenced: 0, recoveryPending: 0 },
          outputs: { retained: 1, fenced: 1, recoveryPending: 1 },
          completion: { retained: 2, fenced: 1, recoveryPending: 1 },
        },
        ownershipLoss: { records: 1 },
        scan: { truncated: false, invalidSkipped: 0 },
      });
      expect(JSON.stringify(inventory)).not.toContain('secret');
      expect(JSON.stringify(inventory)).not.toContain('/private');
      expect(readFileSync(join(temp.root, retainedPath), 'utf8')).toBe(before);
      expect(
        verificationStatus({ root: temp.root, now }).retention.lastSweep,
      ).toBe(null);
      expect(existsSync(join(temp.root, 'terminal-handoff-gc.json'))).toBe(
        false,
      );
    } finally {
      temp.remove();
    }
  });

  test('skips corrupt or malformed records without treating them as terminal handoffs', () => {
    const temp = fixture();
    try {
      mkdirSync(join(temp.root, 'submissions', 'bad-json'), {
        recursive: true,
      });
      writeFileSync(
        join(temp.root, 'submissions', 'bad-json', 'handoff.json'),
        '{',
      );
      temp.write('requests/missing-lease/other.json', { state: 'finished' });
      temp.write('outputs/bad-lease/lease.json', { state: 42 });
      temp.write('ownership-loss/bad.json', { state: 42 });
      temp.write('submissions/z-extra/handoff.json', {
        state: 'settled',
        request: {},
      });

      const inventory = verificationRetentionInventory({
        root: temp.root,
        policy: { scanLimit: 10 },
      });

      expect(inventory.scan).toMatchObject({
        truncated: false,
        invalidSkipped: expect.any(Number),
      });
      expect(inventory.scan.invalidSkipped).toBeGreaterThan(0);
      expect(inventory.terminal).toEqual({
        retained: 0,
        eligible: 0,
        complete: true,
      });
    } finally {
      temp.remove();
    }
  });

  test('marks terminal eligibility unknown when a truncated hash scan can omit newer handoffs', () => {
    const temp = fixture();
    const now = 10_000;
    try {
      temp.write(`submissions/${key('0')}/handoff.json`, {
        state: 'settled',
        generation: 1,
        request: { key: key('0') },
        updatedAt: now - 2_000,
      });
      temp.write(`submissions/${key('f')}/handoff.json`, {
        state: 'settled',
        generation: 1,
        request: { key: key('f') },
        updatedAt: now - 1_000,
      });

      const inventory = verificationRetentionInventory({
        root: temp.root,
        now,
        policy: { terminalTtlMs: 100, newestTerminal: 0, scanLimit: 1 },
      });

      expect(inventory.scan.truncated).toBe(true);
      expect(inventory.terminal).toEqual({
        retained: 1,
        eligible: null,
        complete: false,
      });
    } finally {
      temp.remove();
    }
  });

  test('publishes the documented default policy without enabling collection', () => {
    expect(DEFAULT_VERIFICATION_RETENTION_POLICY).toEqual({
      terminalTtlMs: 7 * 24 * 60 * 60_000,
      newestTerminal: 256,
      scanLimit: 512,
      removeLimit: 64,
    });
  });
});
