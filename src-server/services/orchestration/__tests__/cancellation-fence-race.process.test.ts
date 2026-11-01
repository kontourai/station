import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../../scripts/lib/owned-process.mjs';
import { open } from './fixtures/monument-boundary.js';

const moduleUrl = new URL('../sqlite-session-turn-boundary.ts', import.meta.url)
  .href;
const contenderSource = `
import { DatabaseSync } from 'node:sqlite';
import { createSqliteSessionTurnBoundaryCoordinator } from ${JSON.stringify(moduleUrl)};
const raw = new DatabaseSync(process.argv[1]);
raw.exec('PRAGMA busy_timeout=5000');
const db = {
  get isTransaction() { return raw.isTransaction; },
  prepare: (sql) => raw.prepare(sql),
  exec: (sql) => {
    if (sql === 'BEGIN IMMEDIATE') process.send({ kind: 'attempting' });
    return raw.exec(sql);
  },
};
const coordinator = createSqliteSessionTurnBoundaryCoordinator({
  db, head: () => 0, reconcileTerminals: () => {}, retiredBoundaryIds: () => [],
  transactionLost: (cause) => new Error('Lost transaction', { cause }),
});
const now = '2026-01-01T00:00:00.000Z';
const result = coordinator.create({ boundaryId: 'race', threadId: 'child', state: 'prepared',
  ownerId: 'owner', ownerPid: process.pid, ownerIdentityKind: 'unknown', createdAt: now, updatedAt: now });
raw.close();
process.send({ kind: 'result', result }, () => process.disconnect());
`;

test('a fence committed while another process enters admission prevents the boundary', {
  timeout: 15000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'station-cancellation-race-'));
  const path = join(root, 'events.sqlite');
  const store = open(path);
  store.close();
  const db = new DatabaseSync(path);
  db.exec('BEGIN IMMEDIATE');
  const execution = executeOwnedProcess(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', contenderSource, path],
    spawn,
    'Cancellation contender',
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
  );
  let result: { kind: string } | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Admission did not reach the writer')),
        5000,
      );
      execution.child.on('message', (message: unknown) => {
        const value = message as { kind: string; result?: { kind: string } };
        if (value.kind === 'attempting') {
          clearTimeout(timeout);
          resolve();
        }
        if (value.kind === 'result') result = value.result;
      });
      execution.child.once('error', reject);
      execution.child.once('close', () => {
        clearTimeout(timeout);
        reject(new Error('Admission exited early'));
      });
    });
    db.prepare(
      'INSERT INTO orchestration_cancellation_fences VALUES (?, ?)',
    ).run('child', 'terminal');
    db.exec('COMMIT');
    expect(await waitForSuiteSettlement(execution, 5000)).toBe(true);
    expect((await execution.completion).status).toBe(0);
    expect(result?.kind).not.toBe('applied');
    expect(
      db
        .prepare(
          'SELECT * FROM orchestration_turn_boundaries WHERE thread_id = ?',
        )
        .all('child'),
    ).toEqual([]);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    await terminateSuiteExecution(execution, {
      processLabel: 'Cancellation contender',
      waitForSuiteSettlement,
      terminationGraceMs: 1000,
      terminationForceMs: 1000,
    });
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
