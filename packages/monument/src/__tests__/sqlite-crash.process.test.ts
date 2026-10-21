/**
 * A real process death, not a simulated one: a child process claims a turn
 * through the node:sqlite adapter and is SIGKILLed. The parent then reopens
 * the file and asks the question a restarted host would ask. The in-process
 * crash-point cases close the connection; this proves the decision also holds
 * when the owner dies without closing anything.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { OwnerLiveness } from '../owner.js';
import { openSqliteKernelStorage } from '../sqlite.js';
import {
  createSqliteKernelLocation,
  type SqliteKernelLocation,
} from '../testing/index.js';

const ADAPTER = pathToFileURL(resolve('packages/monument/src/sqlite.ts')).href;

const locations: SqliteKernelLocation[] = [];
afterEach(async () => {
  for (const location of locations.splice(0)) await location.dispose();
});

/** Dead only when the pid no longer exists; EPERM means it does. */
const kernelLiveness: OwnerLiveness = (owner) => {
  try {
    process.kill(owner.pid, 0);
    return 'live';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? 'dead'
      : 'unknown';
  }
};

async function claimThenDie(
  path: string,
  begin: boolean,
): Promise<{ pid: number; signal: NodeJS.Signals | null }> {
  const script = `
    const { openSqliteKernelStorage } = await import(${JSON.stringify(ADAPTER)});
    const storage = openSqliteKernelStorage({ path: ${JSON.stringify(path)} });
    const owner = { id: 'child-owner', pid: process.pid, identityKind: 'unverified' };
    const context = { liveness: () => 'live' };
    storage.executeSync({ type: 'turnDedup.claim', key: 'k', owner, now: 1, tracking: 'tracked' }, context);
    if (${begin}) storage.executeSync({ type: 'turnDedup.beginInvocation', key: 'k', ownerId: owner.id, now: 1 }, context);
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((ready, failed) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('ready')) ready();
    });
    child.once('exit', (code) =>
      failed(new Error(`child exited ${code} before ready: ${stderr}`)),
    );
  });
  const exited = new Promise<NodeJS.Signals | null>((done) =>
    child.once('exit', (_code, signal) => done(signal)),
  );
  child.kill('SIGKILL');
  const signal = await exited;
  return { pid: child.pid ?? -1, signal };
}

/**
 * A child whose participant blocks inside the open transaction, after the
 * kernel's writes and before COMMIT, and is SIGKILLed there.
 */
async function dieInsideTransaction(
  path: string,
): Promise<NodeJS.Signals | null> {
  const script = `
    const { writeSync } = await import('node:fs');
    const { openSqliteKernelStorage } = await import(${JSON.stringify(ADAPTER)});
    const storage = openSqliteKernelStorage({
      path: ${JSON.stringify(path)},
      participants: [{
        name: 'stall',
        commit() {
          writeSync(1, 'inside\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        },
      }],
    });
    const owner = { id: 'child-owner', pid: process.pid, identityKind: 'unverified' };
    storage.executeSync(
      { type: 'turnDedup.claim', key: 'k', owner, now: 1, tracking: 'tracked' },
      { liveness: () => 'live' },
    );
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((inside, failed) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('inside')) inside();
    });
    child.once('exit', (code) =>
      failed(new Error(`child exited ${code} before its commit: ${stderr}`)),
    );
  });
  const exited = new Promise<NodeJS.Signals | null>((done) =>
    child.once('exit', (_code, signal) => done(signal)),
  );
  child.kill('SIGKILL');
  return exited;
}

describe('node:sqlite adapter after a real SIGKILL', () => {
  it('a process killed inside its transaction leaves nothing behind', async () => {
    const location = createSqliteKernelLocation();
    locations.push(location);
    expect(await dieInsideTransaction(location.path)).toBe('SIGKILL');
    const storage = openSqliteKernelStorage({ path: location.path });
    expect(
      storage.executeSync(
        { type: 'turnDedup.read', key: 'k' },
        { liveness: kernelLiveness },
      ),
    ).toEqual({ kind: 'absent' });
    await storage.close();
  });

  it('a begun claim whose owner was killed is indeterminate', async () => {
    const location = createSqliteKernelLocation();
    locations.push(location);
    const { pid, signal } = await claimThenDie(location.path, true);
    expect(signal).toBe('SIGKILL');
    expect(kernelLiveness({ id: 'x', pid, identityKind: 'unverified' })).toBe(
      'dead',
    );
    const storage = openSqliteKernelStorage({ path: location.path });
    const retry = {
      id: 'retry',
      pid: process.pid,
      identityKind: 'unverified',
    } as const;
    expect(
      storage.executeSync(
        {
          type: 'turnDedup.claim',
          key: 'k',
          owner: retry,
          now: 2,
          tracking: 'tracked',
        },
        { liveness: kernelLiveness },
      ),
    ).toEqual({ kind: 'indeterminate' });
    await storage.close();
  });

  it('a pending claim whose owner was killed is reclaimed (control)', async () => {
    const location = createSqliteKernelLocation();
    locations.push(location);
    const { signal } = await claimThenDie(location.path, false);
    expect(signal).toBe('SIGKILL');
    const storage = openSqliteKernelStorage({ path: location.path });
    const retry = {
      id: 'retry',
      pid: process.pid,
      identityKind: 'unverified',
    } as const;
    expect(
      storage.executeSync(
        {
          type: 'turnDedup.claim',
          key: 'k',
          owner: retry,
          now: 2,
          tracking: 'tracked',
        },
        { liveness: kernelLiveness },
      ),
    ).toEqual({ kind: 'claimed', reclaimed: true });
    await storage.close();
  });
});

/** The production participant seam stops only the observation's real transaction. */
async function retireThenDie(
  path: string,
  cut: 'before-commit' | 'after-commit',
) {
  const script = `
    const { writeSync } = await import('node:fs');
    const assert = await import('node:assert/strict');
    const { openSqliteKernelStorage } = await import(${JSON.stringify(ADAPTER)});
    const context = { liveness: () => 'live' };
    const owner = { id: 'child-owner', pid: process.pid, identityKind: 'exact', birth: 'child-birth' };
    const intent = { invocationId: 'B', inputDigest: 'input', intentDigest: 'envelope', bodyRef: 'body' };
    const expected = { boundaryId: 'b', threadId: 't', state: 'invoking', purpose: 'turn', owner, createdAt: '10', updatedAt: '12', intent };
    const hold = () => { writeSync(1, JSON.stringify(expected) + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
    const storage = openSqliteKernelStorage({ path: ${JSON.stringify(path)}, participants: [{ name: 'crash cut', commit({ command }, db) {
      if (command.type !== 'turnBoundary.observeTerminal') return;
      assert.equal(db.prepare("SELECT count(*) AS n FROM monument_turn_terminals WHERE fact_kind='retirement'").get().n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM monument_turn_boundaries').get().n, 0);
      if (${JSON.stringify(cut)} === 'before-commit') hold();
    } }] });
    for (const command of [
      { type: 'turnBoundary.create', boundaryId: 'b', threadId: 't', state: 'reserved', purpose: 'turn', owner, now: '10' },
      { type: 'turnBoundary.prepare', boundaryId: 'b', ownerId: owner.id, intent, now: '11' },
      { type: 'turnBoundary.beginInvocation', boundaryId: 'b', ownerId: owner.id, intent, now: '12' },
    ]) assert.deepEqual(storage.executeSync(command, context), { kind: 'applied' });
    assert.deepEqual(storage.executeSync({ type: 'turnBoundary.observeTerminal', threadId: 't', invocationId: 'B', terminalEventId: 'e', providerTurnId: 'N', terminalCreatedAt: '01', sessionTerminal: false }, context), { kind: 'applied' });
    hold();
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  let output = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<NodeJS.Signals | null>((done) =>
    child.once('exit', (_code, signal) => done(signal)),
  );
  try {
    const expected = await new Promise<
      import('../records.js').TurnBoundaryRecord
    >((ready, failed) => {
      const timeout = setTimeout(
        () => failed(new Error(`child retirement cut timed out: ${stderr}`)),
        20_000,
      );
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (!output.includes('\n')) return;
        clearTimeout(timeout);
        try {
          ready(JSON.parse(output.slice(0, output.indexOf('\n'))));
        } catch (error) {
          failed(error);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        failed(
          new Error(`child exited ${code} before retirement cut: ${stderr}`),
        );
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        failed(error);
      });
    });
    child.kill('SIGKILL');
    return { expected, signal: await exited };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

for (const cut of ['before-commit', 'after-commit'] as const)
  it(`real prepared terminal SIGKILL ${cut} preserves the transaction's exact disposition`, async () => {
    const location = createSqliteKernelLocation();
    locations.push(location);
    const { expected, signal } = await retireThenDie(location.path, cut);
    expect(signal).toBe('SIGKILL');
    const storage = openSqliteKernelStorage({ path: location.path });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(location.path);
    try {
      const rows = storage.executeSync(
        { type: 'turnBoundary.list' },
        { liveness: kernelLiveness },
      );
      const terminalRows = db
        .prepare(
          'SELECT fact_kind FROM monument_turn_terminals ORDER BY fact_kind',
        )
        .all();
      if (cut === 'before-commit') {
        expect(rows).toEqual({ kind: 'records', records: [expected] });
        expect(terminalRows).toEqual([]);
      } else {
        expect(rows).toEqual({ kind: 'records', records: [] });
        expect(terminalRows).toEqual([
          { fact_kind: 'invocation' },
          { fact_kind: 'legacy' },
          { fact_kind: 'retirement' },
        ]);
        const command = {
          type: 'turnBoundary.acceptInvocation',
          expected,
          providerTurnId: 'N',
          now: '13',
        } as const;
        const terminal = {
          threadId: 't',
          invocationId: 'B',
          terminalEventId: 'e',
          providerTurnId: 'N',
          terminalCreatedAt: '01',
          retire: true,
        };
        expect(
          storage.executeSync(command, { liveness: kernelLiveness }),
        ).toEqual({ kind: 'terminal', terminal });
        expect(
          storage.executeSync(command, { liveness: kernelLiveness }),
        ).toEqual({ kind: 'terminal', terminal });
        expect(
          storage.executeSync(
            { type: 'turnBoundary.list' },
            { liveness: kernelLiveness },
          ),
        ).toEqual({ kind: 'records', records: [] });
      }
    } finally {
      db.close();
      await storage.close();
    }
  });
