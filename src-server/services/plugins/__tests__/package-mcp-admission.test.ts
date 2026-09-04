import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../../orchestration/event-store.js';
import type {
  PackageMcpAdmissionJournal,
  PackageMcpInstallation,
} from '../package-mcp-admission.js';

const digest = `sha256:${'a'.repeat(64)}`;
const directories: string[] = [],
  stores: EventStore[] = [],
  children: ChildProcess[] = [];
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'station-package-mcp-'));
  directories.push(value);
  return value;
}
function open(path = join(directory(), 'events.sqlite'), fault?: () => void) {
  const store = new EventStore(
    path,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fault,
  );
  stores.push(store);
  return { store, journal: store.createPackageMcpAdmissionJournal(), path };
}
function record(
  journal: PackageMcpAdmissionJournal,
  pluginId = 'fixture',
  previous: PackageMcpInstallation | null = null,
) {
  const result = journal.recordInstallation({
    pluginId,
    contentDigest: digest,
    previous,
  });
  expect(result.state).toBe('recorded');
  if (result.state !== 'recorded') throw new Error('fixture record failed');
  return result.installation;
}
function reserve(
  journal: PackageMcpAdmissionJournal,
  installation: PackageMcpInstallation,
) {
  const result = journal.reserve(installation, 'managed');
  expect(result.state).toBe('reserved');
  if (result.state !== 'reserved') throw new Error('fixture reserve failed');
  return result.claim;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
async function peer(path: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(
        new URL('./fixtures/package-mcp-journal-process.ts', import.meta.url),
      ),
      path,
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, STATION_HOME: join(path, '..') },
    },
  );
  children.push(child);
  const ready = once(child, 'message');
  child.stdout?.resume();
  child.stderr?.resume();
  expect((await ready)[0]).toEqual({ ready: true });
  let id = 0;
  return {
    child,
    async request(input: object): Promise<any> {
      const requestId = ++id;
      const response = new Promise<any>((resolve, reject) => {
        const listen = (message: any) => {
          if (message.id !== requestId) return;
          child.off('message', listen);
          child.off('exit', exited);
          message.error
            ? reject(new Error(message.error))
            : resolve(message.result);
        };
        const exited = () => {
          child.off('message', listen);
          reject(new Error('Fixture exited before response'));
        };
        child.on('message', listen);
        child.once('exit', exited);
      });
      child.send({ ...input, id: requestId });
      return response;
    },
  };
}

describe('package MCP shared admission evidence (no destructive authority)', {
  timeout: 30_000,
}, () => {
  test('one real store owns a stable factory and zero claims never imply compatibility', () => {
    const { store, journal } = open();
    expect(store.createPackageMcpAdmissionJournal()).toBe(journal);
    expect(journal.currentInstallation('fixture')).toEqual({
      state: 'not-observed',
    });
    expect(journal.inspectMutationImpact('fixture')).toEqual({
      scope: 'unclassified',
      mutationAllowed: false,
    });
    const installed = record(journal);
    expect(journal.inspect(installed)).toEqual({
      state: 'observed',
      mutationAllowed: false,
      admission: 'open',
      reserved: 0,
      possibleEffects: 0,
      localSettled: 0,
      reasons: ['compatibility-unproved'],
    });
    const retirement = journal.requestRetirement(installed);
    expect(retirement.state).toBe('fenced');
    if (retirement.state !== 'fenced') throw new Error('fixture');
    expect(retirement.retirement.inspect()).toMatchObject({
      mutationAllowed: false,
      admission: 'fenced',
      reasons: ['compatibility-unproved'],
    });
    expect(journal.reserve(installed, 'app')).toEqual({ state: 'blocked' });
    expect(retirement.retirement.cancel()).toEqual({ state: 'applied' });
    expect(retirement.retirement.cancel()).toEqual({ state: 'stale' });
  });
  test('only an exact no-effect capability releases; SDK settlement retains possible effects', () => {
    const { journal } = open();
    const installed = record(journal);
    const first = reserve(journal, installed);
    expect(first.releaseNotStarted()).toEqual({ state: 'applied' });
    expect(journal.inspectMutationImpact('fixture')).toEqual({
      scope: 'recorded-package-history',
      mutationAllowed: false,
    });
    expect(first.enterEffectBoundary()).toEqual({ state: 'stale' });
    const second = reserve(journal, installed);
    expect(second.enterEffectBoundary()).toEqual({ state: 'applied' });
    expect(second.enterEffectBoundary()).toEqual({ state: 'blocked' });
    expect(second.observeLocalSettlement()).toEqual({ state: 'applied' });
    expect(second.releaseNotStarted()).toEqual({ state: 'blocked' });
    expect(journal.inspect(installed)).toMatchObject({
      mutationAllowed: false,
      reserved: 0,
      possibleEffects: 1,
      localSettled: 1,
      reasons: [
        'compatibility-unproved',
        'claims-pending',
        'external-effect-unproved',
      ],
    });
  });
  test('reinstalling identical bytes changes host incarnation and old tokens cannot enter or cancel its work', () => {
    const { journal } = open();
    const old = record(journal);
    const claim = reserve(journal, old);
    const current = record(journal, 'fixture', old);
    expect(current.contentDigest).toBe(old.contentDigest);
    expect(current.incarnation).not.toBe(old.incarnation);
    expect(claim.enterEffectBoundary()).toEqual({ state: 'blocked' });
    expect(claim.releaseNotStarted()).toEqual({ state: 'applied' });
    expect(journal.reserve(old, 'managed')).toEqual({ state: 'stale' });
    expect(journal.requestRetirement(old)).toEqual({ state: 'stale' });
    expect(journal.inspect(current)).toMatchObject({
      reserved: 0,
      mutationAllowed: false,
    });
    const other = open();
    record(other.journal);
    expect(other.journal.reserve(current, 'probe')).toEqual({ state: 'stale' });
  });
  test('retirement wins before a reserved callback enters effect and unrelated package is not drained', () => {
    const { journal } = open();
    const installed = record(journal),
      unrelated = record(journal, 'unrelated');
    const pending = reserve(journal, installed),
      other = reserve(journal, unrelated);
    expect(journal.requestRetirement(installed).state).toBe('fenced');
    expect(pending.isCurrent()).toBe(false);
    expect(pending.enterEffectBoundary()).toEqual({ state: 'blocked' });
    expect(pending.releaseNotStarted()).toEqual({ state: 'applied' });
    expect(other.isCurrent()).toBe(true);
    expect(other.enterEffectBoundary()).toEqual({ state: 'applied' });
    expect(journal.inspect(installed)).toMatchObject({
      reserved: 0,
      possibleEffects: 0,
      mutationAllowed: false,
    });
  });
  test('unknown effect commit acknowledgement never authorizes invocation or releases its durable claim', () => {
    let fail = false;
    const { journal, path } = open(undefined, () => {
      if (fail) throw new Error('acknowledgement lost');
    });
    const installed = record(journal);
    const claim = reserve(journal, installed);
    fail = true;
    expect(claim.enterEffectBoundary()).toEqual({ state: 'unavailable' });
    expect(claim.releaseNotStarted()).toEqual({ state: 'blocked' });
    const observer = open(path);
    expect(observer.journal.inspect(installed)).toMatchObject({
      mutationAllowed: false,
      possibleEffects: 1,
    });
  });
  test('an ignored SQLite write cannot authorize an effect boundary', () => {
    const { journal, path } = open();
    const installed = record(journal);
    const claim = reserve(journal, installed);
    const raw = new DatabaseSync(path);
    try {
      raw.exec(
        'CREATE TRIGGER ignore_package_claim_write BEFORE UPDATE ON package_mcp_admission_journal BEGIN SELECT RAISE(IGNORE); END',
      );
      expect(claim.enterEffectBoundary()).toEqual({ state: 'unavailable' });
      expect(journal.inspect(installed)).toMatchObject({
        reserved: 1,
        possibleEffects: 0,
        mutationAllowed: false,
      });
      expect(claim.releaseNotStarted()).toEqual({ state: 'blocked' });
    } finally {
      raw.close();
    }
  });

  test('malformed/oversized state refuses without rewriting and owner close fences admission', () => {
    const { journal, store, path } = open();
    const installed = record(journal);
    const raw = new DatabaseSync(path);
    try {
      raw
        .prepare('UPDATE package_mcp_admission_journal SET state_json = ?')
        .run('{bad');
      expect(journal.reserve(installed, 'oauth')).toEqual({
        state: 'unavailable',
      });
      expect(journal.currentInstallation('fixture')).toEqual({
        state: 'unavailable',
      });
      expect(journal.inspectMutationImpact('fixture')).toEqual({
        scope: 'unavailable',
        mutationAllowed: false,
      });
      expect(
        raw
          .prepare('SELECT state_json FROM package_mcp_admission_journal')
          .get(),
      ).toEqual({ state_json: '{bad' });
      raw
        .prepare('UPDATE package_mcp_admission_journal SET state_json = ?')
        .run('x'.repeat(513 * 1024));
      expect(journal.inspect(installed)).toEqual({
        state: 'unavailable',
        mutationAllowed: false,
      });
    } finally {
      raw.close();
    }
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expect(journal.reserve(installed, 'managed')).toEqual({
      state: 'unavailable',
    });
    expect(() => store.createPackageMcpAdmissionJournal()).toThrow('closing');
  });
  test('two real EventStore processes serialize admission against retirement and retain crashed-owner effects', async () => {
    const path = join(directory(), 'events.sqlite');
    const first = await peer(path),
      second = await peer(path);
    const recorded = await first.request({
      operation: 'record',
      input: { pluginId: 'fixture', contentDigest: digest, previous: null },
    });
    expect(recorded.state).toBe('recorded');
    const installation = recorded.installation;
    const reservation = await second.request({
      operation: 'reserve',
      installation,
      purpose: 'app',
    });
    expect(reservation.state).toBe('reserved');
    expect(
      await second.request({ operation: 'effect', handle: reservation.handle }),
    ).toEqual({ state: 'applied' });
    const retirement = await first.request({
      operation: 'retire',
      installation,
    });
    expect(retirement.state).toBe('fenced');
    expect(
      await second.request({
        operation: 'reserve',
        installation,
        purpose: 'probe',
      }),
    ).toEqual({ state: 'blocked' });
    await second.request({
      operation: 'local-settled',
      handle: reservation.handle,
    });
    const exited = once(second.child, 'exit');
    second.child.kill('SIGKILL');
    await exited;
    const replacement = await peer(path);
    expect(
      await replacement.request({ operation: 'inspect', installation }),
    ).toMatchObject({
      admission: 'fenced',
      mutationAllowed: false,
      possibleEffects: 1,
      localSettled: 1,
    });
    expect(
      await replacement.request({ operation: 'reserve', installation }),
    ).toEqual({ state: 'blocked' });
    expect(
      (await first.request({ operation: 'inspect', installation }))
        .possibleEffects,
    ).toBe(1);
  });
  test('two-process admission races cannot cross a committed fence or lose a peer reservation', async () => {
    const path = join(directory(), 'events.sqlite');
    const first = await peer(path),
      second = await peer(path);
    const { installation } = await first.request({
      operation: 'record',
      input: { pluginId: 'fixture', contentDigest: digest, previous: null },
    });
    const [left, right] = await Promise.all([
      first.request({ operation: 'reserve', installation }),
      second.request({ operation: 'reserve', installation }),
    ]);
    expect(left.state).toBe('reserved');
    expect(right.state).toBe('reserved');
    expect(
      await first.request({ operation: 'inspect', installation }),
    ).toMatchObject({ reserved: 2 });
    await Promise.all([
      first.request({ operation: 'release', handle: left.handle }),
      second.request({ operation: 'release', handle: right.handle }),
    ]);
    const [admitted, retiring] = await Promise.all([
      first.request({ operation: 'reserve', installation }),
      second.request({ operation: 'retire', installation }),
    ]);
    expect(retiring.state).toBe('fenced');
    expect(['reserved', 'blocked']).toContain(admitted.state);
    if (admitted.state === 'reserved') {
      expect(
        await first.request({ operation: 'effect', handle: admitted.handle }),
      ).toEqual({ state: 'blocked' });
      expect(
        await first.request({ operation: 'release', handle: admitted.handle }),
      ).toEqual({ state: 'applied' });
    }
    expect(
      await first.request({ operation: 'inspect', installation }),
    ).toMatchObject({
      reserved: 0,
      possibleEffects: 0,
      mutationAllowed: false,
      admission: 'fenced',
    });
  });
  test('a reused PID with a different birth cannot release the recorded owner capability', () => {
    const { journal, path } = open();
    const installed = record(journal);
    const claim = reserve(journal, installed);
    const raw = new DatabaseSync(path);
    try {
      const row = raw
        .prepare('SELECT state_json FROM package_mcp_admission_journal')
        .get() as { state_json: string };
      const state = JSON.parse(row.state_json);
      state.generations[0].claims[0].owner.birth = 'another-process-birth';
      raw
        .prepare('UPDATE package_mcp_admission_journal SET state_json = ?')
        .run(JSON.stringify(state));
      expect(claim.releaseNotStarted()).toEqual({ state: 'stale' });
      expect(claim.enterEffectBoundary()).toEqual({ state: 'stale' });
      expect(journal.inspect(installed)).toMatchObject({
        reserved: 1,
        mutationAllowed: false,
      });
    } finally {
      raw.close();
    }
  });
  test('reservation acknowledgement loss retains the durable no-effect record and fixed capacity refuses without eviction', () => {
    let fail = false;
    const { journal } = open(undefined, () => {
      if (fail) throw new Error('lost reserve acknowledgement');
    });
    const installed = record(journal);
    fail = true;
    expect(journal.reserve(installed, 'probe')).toEqual({
      state: 'unavailable',
    });
    fail = false;
    expect(journal.inspect(installed)).toMatchObject({ reserved: 1 });
    for (let index = 1; index < 512; index++) reserve(journal, installed);
    expect(journal.reserve(installed, 'app')).toEqual({ state: 'unavailable' });
    expect(journal.inspect(installed)).toMatchObject({
      reserved: 512,
      mutationAllowed: false,
    });
  });
});
