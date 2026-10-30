import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import { createDelegationRoundsController } from '@kontourai/flow-agents/delegation-group-rounds';
import { test, vi } from 'vitest';
import { captureEnvironmentLocalGrantObservationOwner } from '../../../runtime/conversation/local-grant-observation-owner.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { newGrant, setup } from './delegation-source-fixtures/report.js';

test('home-first rounds publication excludes a second revoked request and nests authority under the same lease', async () => {
  const h = await setup();
  const other = newGrant(h);
  const root = join(h.f.home, 'report-groups');
  mkdirSync(root, { mode: 0o700 });
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
    assert.throws(() => h.f.environment.withCurrentAuthority(() => undefined), {
      name: 'HomeWriterUnavailableError',
      reason: 'busy',
      operationRan: false,
    });
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
    h.owner.close(handle);
  }
}, 60_000);
