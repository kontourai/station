import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type { DelegationAuthorityLedgerV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
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
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import { setup } from './delegation-source-fixtures/report.js';

test.each([
  'observe',
  'queued-revocation',
  'four-member-queued-revocation',
  'flow-queued-revocation',
  'over-capacity',
  'abort',
] as const)(
  'initial report authority shares one Home hold before rounds: %s',
  async (scenario) => {
    const h = await setup();
    const queuedRevocation =
      scenario === 'queued-revocation' ||
      scenario === 'four-member-queued-revocation' ||
      scenario === 'flow-queued-revocation';
    const flow =
      scenario === 'flow-queued-revocation'
        ? await createReportFlow(h.f, 'authority-flow-installation', [
            { id: 'left' },
            { id: 'right' },
            { id: 'join', needs: ['left', 'right'] },
          ])
        : undefined;
    if (flow) {
      await h.f.storage.saveProviderConnection({
        id: 'google-1',
        name: 'Controlled Google',
        type: 'google',
        enabled: true,
        capabilities: ['llm'],
        config: {
          apiKey: 'synthetic-google-not-live',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        },
      });
      await h.f.loader.saveAgent('google-reviewer', {
        name: 'Google reviewer',
        prompt: 'Review source',
        execution: {
          modelConnectionId: 'google-1',
          modelId: 'gemini-2.5-flash-lite',
        },
      });
    }
    const count =
      scenario === 'over-capacity'
        ? 16
        : scenario === 'four-member-queued-revocation'
          ? 4
          : flow
            ? 3
            : 2;
    const input = {
      ...h.input,
      ...(flow
        ? {
            flow: {
              ...flow,
              steps: { 'seat-0': 'left', 'seat-1': 'right', 'seat-2': 'join' },
            },
          }
        : {}),
      members: Array.from({ length: count }, (_, index) => ({
        ...h.input.members[0],
        ...(flow && index === 1 ? { agentId: 'google-reviewer' } : {}),
        seatId: `seat-${index}`,
      })),
      budget: {
        inputTokens: count * 1_048_576,
        outputTokens: count * 10,
        costMicros: count * 3_145_878,
      },
    };
    const abort = new AbortController();
    const stoppedByAbort = new Error('Controlled authority installation abort');
    const request = new Request(h.f.req, { signal: abort.signal });
    const principal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
    assert.ok(principal);
    setRuntimeAuthenticatedRequestPrincipal(request, principal);
    bindRuntimeLocalOperator(request);
    const context = h.f.context(request);
    const runtimeOwner = new StationRuntime({ projectHomeDir: h.f.home });
    const participant = Reflect.get(
      runtimeOwner,
      'runtimePublicationParticipant',
    );
    assert.ok(isRuntimePublicationParticipant(participant));
    const adapter = new GateTestAdapter();
    const orchestration = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      logger: { debug() {}, warn() {} },
    });
    const runtime = new StationReportGroupRuntime({
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
      delegationAttemptClaimStore: h.delegationAttemptClaimStore,
      publicationParticipant: participant,
    });
    const writer = await HomeWriterOwner.forHome(h.f.home);
    const link = fs.linkSync;
    let holds = 0;
    const links = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (String(to) === join(h.f.home, 'security', '.home-writer.mutation'))
        holds++;
      return link(from, to);
    });
    syncBuiltinESMExports();
    let firstAuthorityHold: number | undefined;
    let lastAuthorityHold = 0;
    let installed: DelegationAuthorityLedgerV3 | undefined;
    let authorityReturns = 0;
    let revoked = false;
    let revocation: Promise<void> | undefined;
    const authorityStore =
      StationDelegationPersistence.prototype.roundsAuthorityStore;
    const stores = vi
      .spyOn(StationDelegationPersistence.prototype, 'roundsAuthorityStore')
      .mockImplementation(function (
        this: StationDelegationPersistence,
        ...args
      ) {
        const actual = authorityStore.apply(this, args);
        return {
          ...actual,
          transact: async (id, body) => {
            firstAuthorityHold ??= holds;
            let changed = false;
            const result = await actual.transact(id, async (ledger) => {
              const revision = ledger?.revision;
              const next = await body(ledger);
              changed = next.ledger.revision !== revision;
              if (changed) installed = structuredClone(next.ledger);
              return next;
            });
            if (changed) {
              authorityReturns++;
              lastAuthorityHold = holds;
            }
            if (queuedRevocation && changed && authorityReturns === 1) {
              revocation = writer.acquire().then(async (lease) => {
                try {
                  writer.runWithLease(lease, () => {
                    h.f.environment.devicePairing.revokeDevice(
                      h.f.paired.device.id,
                      'operator-credential',
                    );
                    revoked = true;
                  });
                } finally {
                  await lease.release();
                }
              });
              void revocation.catch(() => {});
            }
            if (scenario === 'abort' && changed && authorityReturns === 1)
              abort.abort(stoppedByAbort);
            return result;
          },
        };
      });
    const stopped = new Error(
      'Observed initial authority; rounds not executed',
    );
    let observed = false;
    const roundsStore = StationDelegationPersistence.prototype.roundsStore;
    const controllers = vi
      .spyOn(StationDelegationPersistence.prototype, 'roundsStore')
      .mockImplementation(function (
        this: StationDelegationPersistence,
        ...args
      ) {
        const actual = roundsStore.apply(this, args);
        return {
          ...actual,
          transact: async () => {
            observed = true;
            throw stopped;
          },
        };
      });
    try {
      if (scenario === 'over-capacity') {
        await assert.rejects(runtime.create(context, input), {
          code: 'snapshot_capacity_exceeded',
        });
        assert.equal(observed, false);
        assert.equal(authorityReturns, 0);
        assert.equal(installed, undefined);
        assert.equal(h.rawFetch.mock.calls.length, 0);
        return;
      }
      if (scenario === 'observe')
        await assert.rejects(
          runtime.create(context, input),
          (error) => error === stopped,
        );
      else if (scenario === 'abort')
        await assert.rejects(
          runtime.create(context, input),
          (error: unknown) => {
            assert.ok(
              error instanceof DelegationRoundsTransactionUncertainError,
            );
            assert.equal(error.status, 'returned-cleanup-unknown');
            assert.equal(error.cause, stoppedByAbort);
            return true;
          },
        );
      else
        await assert.rejects(runtime.create(context, input), {
          code: 'authorization_unavailable',
        });
      await revocation;
      assert.equal(observed, scenario === 'observe');
      assert.ok(firstAuthorityHold && firstAuthorityHold > 0);
      assert.equal(
        authorityReturns,
        scenario === 'abort' ? 1 : input.members.length + 2,
      );
      assert.equal(installed?.epochs.length, 1);
      assert.equal(
        installed?.epochs[0].envelopes.length,
        scenario === 'abort' ? 0 : input.members.length + 1,
      );
      assert.equal(installed?.invocations.length, 0);
      assert.equal(
        lastAuthorityHold - firstAuthorityHold + 1,
        1,
        'root and envelope installation must share one physical Home hold',
      );
      assert.equal(revoked, queuedRevocation);
      assert.equal(h.rawFetch.mock.calls.length, 0);
    } finally {
      try {
        await revocation;
      } finally {
        controllers.mockRestore();
        stores.mockRestore();
        links.mockRestore();
        syncBuiltinESMExports();
        try {
          await orchestration.shutdown();
        } finally {
          await runtimeOwner.shutdown();
        }
      }
    }
  },
  60_000,
);
