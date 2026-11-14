import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { test, vi } from 'vitest';
import { z } from 'zod/v3';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { SourceRefusal } from '../delegation-group-source-admission.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  installControl,
  NOW,
  setup,
} from './delegation-source-fixtures/report.js';

test.each(['authority-issue', 'authority-derive', 'group-create'] as const)(
  'source receipt changed after %s store return remains uncertain before launch',
  async (stage) => {
    const h = await setup();
    const started = performance.now();
    vi.mocked(Date.now).mockImplementation(
      () => NOW + Math.floor(performance.now() - started),
    );
    installControl(h);
    const flow = await createReportFlow(h.f, 'source-after-store', [
      { id: 'left' },
      { id: 'right' },
      { id: 'join', needs: ['left', 'right'] },
    ]);
    const bus = new EventBus();
    const eventStore = new EventStore(join(h.f.root, 'source-return.sqlite'));
    const logger = { debug() {}, warn() {} };
    const relay = vi.fn<typeof fetch>(async () => {
      throw Error('reserved source must not relay');
    });
    const adapter = new StationAgentAdapter({
      apiBase: 'http://report-control.test',
      hasAgent: () => true,
      eventBus: bus,
      approvalRegistry: new ApprovalRegistry(logger, { eventBus: bus }),
      fetch: relay,
    });
    const orchestration = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: bus,
      eventStore,
      logger,
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: (slug) => h.f.loader.loadAgent(slug),
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
    });
    const runtimeOwner = new StationRuntime({ projectHomeDir: h.f.home });
    const participant = Reflect.get(
      runtimeOwner,
      'runtimePublicationParticipant',
    );
    assert.ok(isRuntimePublicationParticipant(participant));
    const runtime = new StationReportGroupRuntime({
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
      delegationAttemptClaimStore: h.delegationAttemptClaimStore,
      publicationParticipant: participant,
    });
    let changed: { groupId: string; authorityId: string } | undefined;
    const withdrawAfterStore = async (
      persistence: StationDelegationPersistence,
      current: Parameters<
        StationDelegationPersistence['readReportAdmission']
      >[1],
      groupId: string,
    ) => {
      const admission = await persistence.readReportAdmission(groupId, current);
      assert.ok(admission);
      const member = admission.data.members.at(-1);
      assert.ok(member);
      assert.equal(member.seatId, 'join');
      const envelope = admission.data.envelopes.find(
        (entry) => entry.execution_id === member.reservedTaskId,
      );
      assert.ok(envelope);
      const reference =
        envelope.execution_binding.source.source_admission_receipt;
      const path = join(
        h.f.home,
        'report-groups',
        'sources',
        `snapshot-${reference.id}.json`,
      );
      const bytes = readFileSync(path);
      const receipt = z
        .object({
          payload: z.object({
            schema: z.literal(2),
            kind: z.literal('sealed-source-no-tools'),
            provenance: z.object({
              id: z.string(),
              subject: z.object({
                groupId: z.string(),
                workItemId: z.string(),
              }),
            }),
          }),
        })
        .parse(JSON.parse(bytes.toString('utf8')));
      assert.equal(receipt.payload.provenance.id, reference.id);
      assert.deepEqual(receipt.payload.provenance.subject, {
        groupId,
        workItemId: member.reservedTaskId,
      });
      const before = fs.statSync(path, { bigint: true });
      const replacement = `${path}.replacement`;
      writeFileSync(replacement, bytes, { flag: 'wx', mode: 0o600 });
      fs.renameSync(replacement, path);
      assert.notEqual(fs.statSync(path, { bigint: true }).ino, before.ino);
      assert.deepEqual(readFileSync(path), bytes);
      changed = {
        groupId,
        authorityId: admission.data.root.authority_id,
      };
    };
    const roundsStore = StationDelegationPersistence.prototype.roundsStore;
    const observer = vi
      .spyOn(StationDelegationPersistence.prototype, 'roundsStore')
      .mockImplementation(function (
        this: StationDelegationPersistence,
        ...args
      ) {
        const actual = roundsStore.apply(this, args);
        const store: ReturnType<StationDelegationPersistence['roundsStore']> = {
          ...actual,
          transact: async (groupId, body) => {
            let created = false;
            const value = await actual.transact(groupId, async (journal) => {
              const next = await body(journal);
              const last = next.journal.events.at(-1);
              created =
                last?.kind === 'command' && last.command.kind === 'create';
              return next;
            });
            if (stage === 'group-create' && created && !changed) {
              await withdrawAfterStore(this, args[0], groupId);
            }
            return value;
          },
        };
        return store;
      });
    let authorityReturns = 0;
    const authorityStore =
      StationDelegationPersistence.prototype.roundsAuthorityStore;
    const authorityObserver = vi
      .spyOn(StationDelegationPersistence.prototype, 'roundsAuthorityStore')
      .mockImplementation(function (
        this: StationDelegationPersistence,
        ...args
      ) {
        const actual = authorityStore.apply(this, args);
        return {
          ...actual,
          transact: async (id, body) => {
            const result = await actual.transact(id, body);
            authorityReturns++;
            if (
              !changed &&
              ((stage === 'authority-issue' && authorityReturns === 1) ||
                (stage === 'authority-derive' && authorityReturns === 2))
            )
              await withdrawAfterStore(this, args[0], id);
            return result;
          },
        };
      });
    try {
      await assert.rejects(
        runtime.create(h.f.context(), {
          ...h.input,
          flow,
          members: [
            ...h.input.members,
            {
              ...h.input.members[0],
              seatId: 'join',
              brief: 'Combine findings',
            },
          ],
          budget: {
            inputTokens: 3 * 1_048_576,
            outputTokens: 30,
            costMicros: 3 * 3_145_878,
          },
        }),
        (error: unknown) => {
          assert.ok(
            changed,
            'actual admission-linked receipt replaced after store fulfillment',
          );
          assert.equal(
            error instanceof DelegationRoundsTransactionUncertainError
              ? error.status
              : 'ordinary-refusal',
            'returned-cleanup-unknown',
          );
          assert.ok(error instanceof DelegationRoundsTransactionUncertainError);
          assert.ok(error.cause instanceof SourceRefusal);
          assert.equal(error.cause.code, 'snapshot_receipt_changed');
          return true;
        },
      );
      const mutation = changed;
      assert.ok(mutation);
      assert.equal(h.rawFetch.mock.calls.length, 0);
      assert.equal(relay.mock.calls.length, 0);
      const writer = await HomeWriterOwner.forHome(h.f.home);
      const persisted = new StationDelegationPersistence(
        join(h.f.home, 'report-groups'),
      );
      const saved = await writer.runOwnedLease(h.f.req.signal, (lease) =>
        persisted.readReportExecution(
          mutation.groupId,
          mutation.authorityId,
          () => writer.runWithLease(lease, () => undefined),
        ),
      );
      assert.equal(
        saved.group?.revision,
        stage === 'group-create' ? 1 : undefined,
      );
      assert.equal(
        saved.group?.attempts.length,
        stage === 'group-create' ? 0 : undefined,
      );
      assert.equal(
        saved.authority?.epochs[0].envelopes.length,
        stage === 'authority-issue' ? 0 : stage === 'authority-derive' ? 1 : 4,
      );
      assert.equal(saved.authority?.invocations.length, 0);
    } finally {
      observer.mockRestore();
      authorityObserver.mockRestore();
      await orchestration.shutdown();
      await runtimeOwner.shutdown();
      eventStore.close();
    }
  },
  120_000,
);
