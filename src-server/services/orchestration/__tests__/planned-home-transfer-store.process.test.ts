import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../../scripts/lib/owned-process.mjs';
import { createSqlitePlannedHomeTransferStore } from '../planned-home-transfer-store.js';

const children: Array<ReturnType<typeof executeOwnedProcess>> = [];
const roots: string[] = [];
afterEach(async () => {
  for (const execution of children.splice(0)) {
    const result = await terminateSuiteExecution(execution, {
      processLabel: 'Transfer contender',
      waitForSuiteSettlement,
      terminationGraceMs: 1000,
      terminationForceMs: 1000,
    });
    expect(result).toMatchObject({ settled: true, errors: [] });
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const moduleUrl = new URL('../planned-home-transfer-store.ts', import.meta.url)
  .href;
const source = `
import { DatabaseSync } from 'node:sqlite';
import { createSqlitePlannedHomeTransferStore } from ${JSON.stringify(moduleUrl)};
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout=5000');
const store = createSqlitePlannedHomeTransferStore(db);
const owner = store.inspect('tenant', 'channel');
if (owner.kind !== 'stored' || owner.value.revision !== 0 || owner.value.homeRef !== 'source') throw Error('Unexpected initial owner');
process.send({ kind: 'ready' });
process.once('message', () => {
  const result = store.prepare({ tenantId: 'tenant', channelId: 'channel', operationId: process.argv[2], sourceHomeRef: 'source', targetHomeRef: process.argv[2], policyRevision: 'policy', expectedRevision: 0 });
  db.close();
  process.send({ kind: 'result', result }, () => process.disconnect());
});`;
function contender(path: string, operation: string) {
  const execution = executeOwnedProcess(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source, path, operation],
    spawn,
    'Transfer contender',
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
  );
  children.push(execution);
  let result: { kind: string } | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Contender did not reach the shared barrier')),
      5000,
    );
    execution.child.once('error', reject);
    execution.child.on('message', (message: unknown) => {
      const value = message as { kind?: string; result?: { kind: string } };
      if (value.kind === 'ready') {
        clearTimeout(timer);
        resolve();
      }
      if (value.kind === 'result') result = value.result;
    });
    execution.child.once('close', () => {
      clearTimeout(timer);
      reject(new Error('Contender exited before the barrier'));
    });
  });
  return { execution, ready, result: () => result };
}
test('two independently running contenders observe the same owner but only one reserves a transfer', {
  timeout: 15000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'station-transfer-contention-'));
  roots.push(root);
  const path = join(root, 'authority.sqlite');
  const db = new DatabaseSync(path);
  try {
    const store = createSqlitePlannedHomeTransferStore(db);
    expect(
      store.initialize({
        tenantId: 'tenant',
        channelId: 'channel',
        homeRef: 'source',
        policyRevision: 'policy',
        revision: 0,
      }).kind,
    ).toBe('stored');
    const contenders = [
      contender(path, 'target-one'),
      contender(path, 'target-two'),
    ];
    await Promise.all(contenders.map((child) => child.ready));
    // Both processes have independently read revision zero before either is
    // allowed to enter the conditional reservation transaction.
    for (const child of contenders) child.execution.child.send('go');
    for (const child of contenders) {
      expect(await waitForSuiteSettlement(child.execution, 5000)).toBe(true);
      expect((await child.execution.completion).status).toBe(0);
    }
    expect(contenders.map((child) => child.result()?.kind).sort()).toEqual([
      'conflict',
      'stored',
    ]);
    expect(store.inspect('tenant', 'channel')).toMatchObject({
      kind: 'stored',
      value: { homeRef: 'source', revision: 0 },
    });
  } finally {
    db.close();
  }
});
