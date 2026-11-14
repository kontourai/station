import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import { createDelegationRoundsController } from '@kontourai/flow-agents/delegation-group-rounds';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { test, vi } from 'vitest';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../../scripts/lib/owned-process.mjs';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { captureEnvironmentLocalGrantObservationOwner } from '../../../runtime/conversation/local-grant-observation-owner.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventBus } from '../event-bus.js';
import { OrchestrationService } from '../orchestration-service.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { newGrant, setup } from './delegation-source-fixtures/report.js';

test('home-first rounds publication excludes a second revoked request and nests authority under the same lease', async () => {
  const h = await setup();
  const other = newGrant(h);
  const root = join(h.f.home, 'report-groups');
  mkdirSync(root, { mode: 0o700, recursive: true });
  const dispatchRoot = join(root, 'dispatch');
  mkdirSync(dispatchRoot, { mode: 0o700 });
  const persistence = new StationDelegationPersistence(root, {
    homeDir: h.f.home,
  });
  const handle = await h.owner.prepare(h.f.context(), {
    ...h.input,
    maxConcurrent: 1,
    members: h.input.members.slice(0, 1),
  });
  try {
    const prepared = h.owner.read(handle, h.f.req);
    const current = (): undefined => {
      h.owner.assertCurrent(handle, h.f.req);
      return undefined;
    };
    const service = createDelegationAuthorityServiceV3(
      persistence.roundsAuthorityStore(current),
      {
        now: () => new Date(Date.now()).toISOString(),
        authorize: async (_action, root, envelope) =>
          h.owner.authorizes(handle, h.f.req, root, envelope),
        confirmExecution: async (envelope) =>
          h.owner.confirmsExecution(handle, h.f.req, envelope),
        authenticateRenewal: async () => null,
      },
      { maxRenewals: 0 },
    );
    await service.issue(prepared.root);
    for (const envelope of prepared.envelopes)
      await service.derive(prepared.root.authority_id, envelope);
    const deny = (): never => {
      throw Error('provider path must not run');
    };
    const store = persistence.roundsStore(current);
    const controller = createDelegationRoundsController({
      store,
      authorityService: service,
      dispatchLedger: new FileAuthorizationLedger({ root: dispatchRoot }),
      host: {
        authorize: async () => {
          current();
          return prepared.root.authenticated_principal_ref;
        },
        executionHost: deny,
        prepareRequest: async () => deny(),
        retainObservation: async () => deny(),
        confirmTerminal: async () => deny(),
        requestDescendantCancellation: async () =>
          prepared.root.root_cancellation_ref,
      },
    });
    await controller.create({
      kind: 'create',
      groupId: prepared.spec.groupId,
      operationKey: 'create',
      expectedRevision: 0,
      controller: prepared.spec.controller,
      spec: prepared.spec,
    });
    const writer = await HomeWriterOwner.forHome(h.f.home);
    const held = await writer.acquire();
    const scopedCurrent = (): undefined => writer.runWithLease(held, current);
    const scoped = new StationDelegationPersistence(root).roundsAuthorityStore(
      scopedCurrent,
      scopedCurrent,
      { owner: writer, lease: held },
    );
    const scopedRounds = new StationDelegationPersistence(root).roundsStore(
      scopedCurrent,
      scopedCurrent,
      { owner: writer, lease: held },
    );
    await scopedRounds.transact(prepared.spec.groupId, async (journal) => {
      assert.ok(journal);
      await scoped.transact(prepared.root.authority_id, async (ledger) => {
        assert.ok(ledger);
        return { ledger, result: undefined };
      });
      return { journal, result: undefined };
    });
    let authorityRenames = 0;
    const rename = fs.renameSync;
    const renameProbe = vi
      .spyOn(fs, 'renameSync')
      .mockImplementation((from, to) => {
        if (String(to).includes('/station-rounds-authorities-v3/')) {
          writer.assertSynchronous();
          authorityRenames++;
        }
        return rename(from, to);
      });
    syncBuiltinESMExports();
    try {
      const ledger = await scoped.transact(
        prepared.root.authority_id,
        async (value) => {
          assert.ok(value);
          return {
            ledger: { ...value, revision: value.revision + 1, cancelled: true },
            result: value,
          };
        },
      );
      assert.equal(
        ledger.epochs[0].root.authority_id,
        prepared.root.authority_id,
      );
    } finally {
      renameProbe.mockRestore();
      syncBuiltinESMExports();
    }
    assert.equal(authorityRenames, 1);
    const foreignHome = join(h.f.root, 'foreign-home');
    mkdirSync(join(foreignHome, 'security'), { mode: 0o700, recursive: true });
    const foreign = await HomeWriterOwner.forHome(foreignHome);
    const foreignLease = await foreign.acquire();
    try {
      const foreignScope = new StationDelegationPersistence(
        root,
      ).roundsAuthorityStore(scopedCurrent, scopedCurrent, {
        owner: foreign,
        lease: foreignLease,
      });
      await assert.rejects(
        foreignScope.transact(prepared.root.authority_id, async () => {
          throw Error('foreign scope must not enter');
        }),
        { code: 'delegation_home_custody_mismatch' },
      );
    } finally {
      await foreignLease.release();
    }
    await held.release();
    await assert.rejects(
      scopedRounds.transact(prepared.spec.groupId, async () => {
        throw Error('released group scope must not enter');
      }),
    );
    await assert.rejects(
      scoped.transact(prepared.root.authority_id, async () => {
        throw Error('released scope must not enter');
      }),
    );
    const request = new Request(h.f.req.url, { method: 'POST' });
    const principal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
    assert.ok(principal && principal.kind !== 'internal');
    setRuntimeAuthenticatedRequestPrincipal(request, {
      ...principal,
      credential: other.credential,
    });
    bindRuntimeLocalOperator(request);
    const captured = (
      await captureEnvironmentLocalGrantObservationOwner(
        request,
        h.f.environment,
        h.f.environment,
      )
    ).requireCurrentLocalGrant(request);
    const childInput = join(root, 'child-grant.json');
    writeFileSync(
      childInput,
      JSON.stringify({ credential: other.credential, url: request.url }),
      { mode: 0o600 },
    );
    const source = `
import fs from 'node:fs';
import { join } from 'node:path';
const home = process.argv[1], root = join(home, 'report-groups');
const input = JSON.parse(fs.readFileSync(join(root, 'child-grant.json'), 'utf8'));
const { EnvironmentSecurityService } = await import(${JSON.stringify(new URL('../../ssh/environment-security-service.ts', import.meta.url).href)});
const { captureEnvironmentLocalGrantObservationOwner } = await import(${JSON.stringify(new URL('../../../runtime/conversation/local-grant-observation-owner.ts', import.meta.url).href)});
const { setRuntimeAuthenticatedRequestPrincipal, bindRuntimeLocalOperator } = await import(${JSON.stringify(new URL('../../../security/runtime-request-security.ts', import.meta.url).href)});
const { StationDelegationPersistence } = await import(${JSON.stringify(new URL('../delegation-group-persistence.ts', import.meta.url).href)});
const { HomeWriterOwner } = await import(${JSON.stringify(new URL('../../ssh/home-writer-owner.ts', import.meta.url).href)});
const environment = new EnvironmentSecurityService({ homeDir: home });
await environment.initialize();
const request = new Request(input.url, { method: 'POST' });
setRuntimeAuthenticatedRequestPrincipal(request, { kind: 'credential', authority: 'device-credential', credential: input.credential, source: 'bearer', locality: 'home-possession', mintKind: 'local-grant' });
bindRuntimeLocalOperator(request);
const lease = (await captureEnvironmentLocalGrantObservationOwner(request, environment, environment)).requireCurrentLocalGrant(request);
fs.writeFileSync(join(root, 'child-ready'), 'ready');
while (!fs.existsSync(join(root, 'child-start'))) await new Promise(resolve => setTimeout(resolve, 10));
const original = HomeWriterOwner.prototype.acquire;
HomeWriterOwner.prototype.acquire = function (...args) { fs.writeFileSync(join(root, 'child-attempt'), 'attempt'); return original.apply(this, args); };
const current = () => environment.withCurrentAuthority(() => { lease.assertCurrent(); return undefined; });
try {
  await new StationDelegationPersistence(root, { homeDir: home }).roundsStore(current).transact(process.argv[2], async () => { fs.writeFileSync(join(root, 'child-body'), 'entered'); throw Error('unexpected body'); });
  throw Error('unexpected success');
} catch (error) {
  if (fs.existsSync(join(root, 'child-body')) || error?.code !== 'authorization_unavailable') throw error;
  fs.writeFileSync(join(root, 'child-result'), 'refused');
}
`;
    const child = executeOwnedProcess(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        source,
        h.f.home,
        prepared.spec.groupId,
      ],
      spawn,
      'rounds contender',
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let childError = '';
    child.child.stderr?.on('data', (chunk) => {
      childError = (childError + String(chunk)).slice(-4096);
    });
    try {
      await vi.waitFor(
        () =>
          assert.equal(existsSync(join(root, 'child-ready')), true, childError),
        { timeout: 15_000 },
      );
      const secondCurrent = (): undefined =>
        h.f.environment.withCurrentAuthority(() => {
          request.signal.throwIfAborted();
          captured.assertCurrent();
          return undefined;
        });
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = store.transact(prepared.spec.groupId, async (journal) => {
        assert.ok(journal);
        const ledger = await service.inspect(prepared.root.authority_id);
        assert.ok(ledger);
        await service.cancel(prepared.root.authority_id);
        journal.events.push({
          revision: journal.events.length + 1,
          kind: 'command',
          command: {
            kind: 'cancel',
            groupId: prepared.spec.groupId,
            operationKey: 'cancel',
            expectedRevision: journal.events.length,
            controller: prepared.spec.controller,
          },
          authorization: prepared.root.authenticated_principal_ref,
        });
        entered();
        await gate;
        h.f.environment.devicePairing.revokeDevice(
          other.device.id,
          'operator-credential',
        );
        return { journal, result: journal.events.length };
      });
      await ready;
      writeFileSync(join(root, 'child-start'), 'start');
      await vi.waitFor(
        () =>
          assert.equal(
            existsSync(join(root, 'child-attempt')),
            true,
            childError,
          ),
        { timeout: 15_000 },
      );
      assert.throws(
        () => h.f.environment.withCurrentAuthority(() => undefined),
        {
          name: 'HomeWriterUnavailableError',
          reason: 'busy',
          operationRan: false,
        },
      );
      let attempting!: () => void;
      const attempted = new Promise<void>((resolve) => {
        attempting = resolve;
      });
      const acquire = HomeWriterOwner.prototype.acquire;
      const acquireSpy = vi
        .spyOn(HomeWriterOwner.prototype, 'acquire')
        .mockImplementation(function (this: HomeWriterOwner, ...args) {
          attempting();
          return acquire.apply(this, args);
        });
      let secondEntered = false;
      const second = persistence
        .roundsStore(secondCurrent)
        .transact(prepared.spec.groupId, async (journal) => {
          secondEntered = true;
          assert.ok(journal);
          return { journal, result: undefined };
        });
      const rejected = assert.rejects(second);
      await attempted;
      acquireSpy.mockRestore();
      release();
      const before = await first;
      assert.throws(() => captured.assertCurrent());
      await rejected;
      assert.deepEqual(await child.completion, { status: 0, signal: null });
      assert.equal(readFileSync(join(root, 'child-result'), 'utf8'), 'refused');
      assert.equal(existsSync(join(root, 'child-body')), false);
      assert.equal(secondEntered, false);
      const after = await store.transact(
        prepared.spec.groupId,
        async (journal) => {
          assert.ok(journal);
          return { journal, result: journal.events.length };
        },
      );
      assert.equal(after, before);
    } finally {
      const settled = await terminateSuiteExecution(child, {
        processLabel: 'rounds contender',
        waitForSuiteSettlement,
        terminationGraceMs: 1000,
        terminationForceMs: 1000,
      });
      assert.equal(settled.settled, true);
      assert.deepEqual(settled.errors, []);
    }
  } finally {
    h.owner.close(handle);
  }
}, 60_000);

test.each([false, true])(
  'runtime cancellation holds scoped home through full store return and retries cleanup on shutdown (fault=%s)',
  async (fault) => {
    const h = await setup();
    const handle = await h.owner.prepare(h.f.context(), {
      ...h.input,
      maxConcurrent: 1,
      members: h.input.members.slice(0, 1),
    });
    let runtime = new StationRuntime({ projectHomeDir: h.f.home });
    const participant = Reflect.get(runtime, 'runtimePublicationParticipant');
    assert.ok(isRuntimePublicationParticipant(participant));
    const deny = (): never => {
      throw Error('no provider or adapter work in cancellation fixture');
    };
    const orchestration = new OrchestrationService({
      adapterRegistry: { register: deny, get: deny, list: () => [] },
      eventBus: new EventBus(),
      logger: { debug() {}, warn() {} },
    });
    let releaseBody!: () => void, releaseReturn!: () => void;
    const bodyHeld = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const returnHeld = new Promise<void>((resolve) => {
      releaseReturn = resolve;
    });
    let bodyEntered!: () => void, storeReturned!: () => void;
    const inBody = new Promise<void>((resolve) => {
      bodyEntered = resolve;
    });
    const afterStore = new Promise<void>((resolve) => {
      storeReturned = resolve;
    });
    let pending: Promise<unknown> | undefined;
    let shutdown: Promise<void> | undefined;
    let releaseFault: { mockRestore(): void } | undefined;
    let readProbe: { mockRestore(): void } | undefined;
    let authorityProbe: { mockRestore(): void } | undefined;
    let storeProbe: { mockRestore(): void } | undefined;
    try {
      const prepared = h.owner.read(handle, h.f.req);
      const groupId = await h.custody.retain(h.f.context(), h.owner, handle);
      const persistence = h.custodyOwners.persistence;
      const current = (): undefined => {
        h.owner.assertCurrent(handle, h.f.req);
        return undefined;
      };
      const service = createDelegationAuthorityServiceV3(
        persistence.roundsAuthorityStore(current),
        {
          now: () => new Date(Date.now()).toISOString(),
          authorize: async (_action, root, envelope) =>
            h.owner.authorizes(handle, h.f.req, root, envelope),
          confirmExecution: async (envelope) =>
            h.owner.confirmsExecution(handle, h.f.req, envelope),
          authenticateRenewal: async () => null,
        },
        { maxRenewals: 0 },
      );
      await service.issue(prepared.root);
      for (const envelope of prepared.envelopes)
        await service.derive(prepared.root.authority_id, envelope);
      const report = new StationReportGroupRuntime({
        runtime: h.preparationOwners.runtime,
        orchestration,
        rawFetch: h.rawFetch,
        delegationAttemptClaimStore: h.delegationAttemptClaimStore,
        publicationParticipant: participant,
      });
      const root = join(h.f.home, 'report-groups');
      const dispatch = new FileAuthorizationLedger({
        root: join(root, 'dispatch'),
      });
      const controller = createDelegationRoundsController({
        store: persistence.roundsStore(current),
        authorityService: service,
        dispatchLedger: dispatch,
        host: {
          authorize: async () => prepared.root.authenticated_principal_ref,
          executionHost: deny,
          prepareRequest: async () => deny(),
          retainObservation: async () => deny(),
          confirmTerminal: async () => deny(),
          requestDescendantCancellation: async () => deny(),
        },
      });
      const created = await controller.create({
        kind: 'create',
        groupId,
        operationKey: 'create',
        expectedRevision: 0,
        controller: prepared.spec.controller,
        spec: prepared.spec,
      });
      const roundsStore = StationDelegationPersistence.prototype.roundsStore;
      let first = true;
      let cancellationRevision = 0;
      storeProbe = vi
        .spyOn(StationDelegationPersistence.prototype, 'roundsStore')
        .mockImplementation(function (
          this: StationDelegationPersistence,
          ...args
        ) {
          const actual = roundsStore.apply(this, args);
          return {
            ...actual,
            transact: async (id, body) => {
              let selected = false;
              const result = await actual.transact(id, async (journal) => {
                const value = await body(journal);
                if (
                  first &&
                  value.journal?.events.some(
                    (event) =>
                      event.kind === 'command' &&
                      event.command.kind === 'cancel' &&
                      event.command.operationKey === 'cancel-owned',
                  )
                ) {
                  first = false;
                  selected = true;
                  cancellationRevision = value.journal.events.length;
                  bodyEntered();
                  await bodyHeld;
                }
                return value;
              });
              if (selected) {
                storeReturned();
                await returnHeld;
              }
              return result;
            },
          };
        });
      const writer = await HomeWriterOwner.forHome(h.f.home);
      const authorityStore =
        StationDelegationPersistence.prototype.roundsAuthorityStore;
      let cancellationWrites = 0;
      authorityProbe = vi
        .spyOn(StationDelegationPersistence.prototype, 'roundsAuthorityStore')
        .mockImplementation(function (
          this: StationDelegationPersistence,
          ...args
        ) {
          const actual = authorityStore.apply(this, args);
          return {
            ...actual,
            transact: (id, body) =>
              actual.transact(id, async (ledger) => {
                const wasCancelled = ledger?.cancelled;
                const next = await body(ledger);
                if (wasCancelled === false && next.ledger?.cancelled) {
                  assert.throws(
                    () => writer.runSynchronous(() => undefined),
                    {
                      name: 'HomeWriterUnavailableError',
                      reason: 'busy',
                    },
                    'authority cancellation must hold home through its store body',
                  );
                  cancellationWrites++;
                }
                return next;
              }),
          };
        });

      const readExecution =
        StationDelegationPersistence.prototype.readReportExecution;
      let executionReads = 0;
      readProbe = vi
        .spyOn(StationDelegationPersistence.prototype, 'readReportExecution')
        .mockImplementation(function (
          this: StationDelegationPersistence,
          ...args
        ) {
          assert.throws(
            () => writer.runSynchronous(() => undefined),
            {
              name: 'HomeWriterUnavailableError',
              reason: 'busy',
            },
            'historical execution read must enter holding home',
          );
          executionReads++;
          return readExecution.apply(this, args);
        });
      pending = report.cancel(h.f.context(), groupId, {
        operationKey: 'cancel-owned',
        expectedRevision: created.projection.revision,
      });
      const premature = pending.then(() => {
        throw Error('cancellation returned before held store');
      });
      await Promise.race([inBody, premature]);
      assert.throws(() => writer.runSynchronous(() => undefined), {
        name: 'HomeWriterUnavailableError',
        reason: 'busy',
      });
      if (fault) {
        const remove = fs.rmSync;
        releaseFault = vi
          .spyOn(fs, 'rmSync')
          .mockImplementation((path, options) => {
            if (String(path).includes('.home-writer.mutation.guard.stale-'))
              throw Error('injected owned home retirement failure');
            return remove(path, options);
          });
        syncBuiltinESMExports();
      }
      shutdown = runtime.shutdown();
      const blockedShutdown = fault
        ? assert.rejects(shutdown, { code: 'runtime_publication_pending' })
        : undefined;
      assert.throws(() => participant.acquire());
      assert.throws(
        () => acquireStationHomeMaintenanceLease(h.f.home),
        StationHomeActiveError,
      );
      releaseBody();
      await Promise.race([afterStore, premature]);
      assert.throws(() => writer.runSynchronous(() => undefined), {
        name: 'HomeWriterUnavailableError',
        reason: 'busy',
      });
      assert.throws(
        () => acquireStationHomeMaintenanceLease(h.f.home),
        StationHomeActiveError,
      );
      releaseReturn();
      if (fault) {
        await assert.rejects(pending, { code: 'rounds_transaction_uncertain' });
        await blockedShutdown;
        assert.throws(
          () => acquireStationHomeMaintenanceLease(h.f.home),
          StationHomeActiveError,
        );
        releaseFault?.mockRestore();
        releaseFault = undefined;
        syncBuiltinESMExports();
        shutdown = runtime.shutdown();
        await shutdown;
        runtime = new StationRuntime({ projectHomeDir: h.f.home });
        const returningParticipant = Reflect.get(
          runtime,
          'runtimePublicationParticipant',
        );
        assert.ok(isRuntimePublicationParticipant(returningParticipant));
        const returning = new StationReportGroupRuntime({
          runtime: h.preparationOwners.runtime,
          orchestration,
          rawFetch: h.rawFetch,
          delegationAttemptClaimStore: h.delegationAttemptClaimStore,
          publicationParticipant: returningParticipant,
        });
        assert.ok(cancellationRevision > 0);
        const recovery = {
          operationKey: 'finish-cancel-owned',
          expectedRevision: cancellationRevision,
          cancelOperationKey: 'cancel-owned',
        };
        const finalized = await returning.finalizeCancel(
          h.f.context(),
          groupId,
          recovery,
        );
        assert.equal(finalized.replayed, false);
        assert.equal(finalized.cancellation, 'requested');
        assert.equal(cancellationWrites, 1);
        const replayed = await returning.finalizeCancel(
          h.f.context(),
          groupId,
          recovery,
        );
        assert.equal(replayed.replayed, true);
        assert.equal(replayed.revision, finalized.revision);
        assert.equal(cancellationWrites, 1);
        shutdown = runtime.shutdown();
        await shutdown;
      } else {
        await pending;
        assert.equal(cancellationWrites, 1);
        await shutdown;
      }
      assert.ok(executionReads > 0);
      writer.runSynchronous(() => undefined);
      const maintenance = acquireStationHomeMaintenanceLease(h.f.home);
      maintenance.release();
    } finally {
      releaseFault?.mockRestore();
      syncBuiltinESMExports();
      releaseBody();
      releaseReturn();
      await pending?.catch(() => {});
      readProbe?.mockRestore();
      authorityProbe?.mockRestore();
      storeProbe?.mockRestore();
      await shutdown?.catch(() => {});
      await runtime.shutdown();
      await orchestration.shutdown();
      await h.owner.closeInputs(handle);
      h.owner.close(handle);
    }
  },
);

test.each(['operation-lookup', 'authorize'] as const)(
  'initial report request retains runtime home after %s release failure',
  async (checkpoint) => {
    const h = await setup();
    const runtime = new StationRuntime({ projectHomeDir: h.f.home });
    const participant = Reflect.get(runtime, 'runtimePublicationParticipant');
    assert.ok(isRuntimePublicationParticipant(participant));
    const forbid = (): never => {
      throw Error('failed entry cannot reach an engine');
    };
    const orchestration = new OrchestrationService({
      adapterRegistry: { register: forbid, get: forbid, list: () => [] },
      eventBus: new EventBus(),
      logger: { debug() {}, warn() {} },
    });
    const report = new StationReportGroupRuntime({
      publicationParticipant: participant,
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
      delegationAttemptClaimStore: h.delegationAttemptClaimStore,
    });
    let releaseFault: { mockRestore(): void } | undefined;
    const arm = () => {
      assert.equal(releaseFault, undefined);
      const remove = fs.rmSync;
      releaseFault = vi
        .spyOn(fs, 'rmSync')
        .mockImplementation((path, options) => {
          if (String(path).includes('.home-writer.mutation.guard.stale-'))
            throw Error('injected initial request home retirement failure');
          return remove(path, options);
        });
      syncBuiltinESMExports();
    };
    const authorize = report.authorizeResponse;
    const observer = vi
      .spyOn(report, 'authorizeResponse')
      .mockImplementation(async (...args) => {
        if (checkpoint === 'authorize') arm();
        return authorize.apply(report, args);
      });
    try {
      if (checkpoint === 'operation-lookup') arm();
      await assert.rejects(report.create(h.f.context(), h.input));
      assert.ok(releaseFault);
      assert.equal(h.rawFetch.mock.calls.length, 0);
      await assert.rejects(runtime.shutdown(), {
        code: 'runtime_publication_pending',
      });
      assert.throws(
        () => acquireStationHomeMaintenanceLease(h.f.home),
        StationHomeActiveError,
      );
      releaseFault.mockRestore();
      releaseFault = undefined;
      syncBuiltinESMExports();
      await runtime.shutdown();
      const maintenance = acquireStationHomeMaintenanceLease(h.f.home);
      maintenance.release();
    } finally {
      observer.mockRestore();
      releaseFault?.mockRestore();
      syncBuiltinESMExports();
      const writer = await HomeWriterOwner.forHome(h.f.home);
      await writer.settlePendingCleanup();
      await orchestration.shutdown();
      await runtime.shutdown();
    }
  },
  60_000,
);
