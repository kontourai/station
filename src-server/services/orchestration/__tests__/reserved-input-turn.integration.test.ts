import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  InputRequestForm,
  InputRequestResponse,
} from '@kontourai/station-contracts/input-request';
import { onTestFinished, test, vi } from 'vitest';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import * as canonicalCommit from '../../../runtime/conversation/canonical-request-commit.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import {
  type HomeWriterLease,
  HomeWriterOwner,
} from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { inspectSdkSourceWire } from '../delegation-group-sdk-source-wire-owner.js';
import { withReportRoundsPublication } from '../report-rounds-publication.js';
import { publicFenceFixture } from './delegation-source-fixtures/fence.js';
import { deferred } from './delegation-source-fixtures/sdk.js';
import { sdkFixture } from './delegation-source-fixtures/sdk-source.js';
import { subject } from './delegation-source-fixtures/source.js';

function revokedRetention(error: unknown): boolean {
  return (
    error instanceof AggregateError &&
    error.message === 'Round retention unknown; admission remains held' &&
    error.errors.length === 1 &&
    error.errors[0] instanceof Error &&
    error.errors[0].message === 'actual-local-grant-revoked'
  );
}

test.each([
  'answer',
  'entry-contention',
  'open-contention',
  'reply-contention',
  'reply-revocation',
  'commit-wait',
  'queued-abort',
  'queued-revocation',
  'abort-before-open',
  'invocation-abort-before-open',
  'invocation-abort-after-open',
] as const)(
  'reserved accounted input holds its actual turn through canonical settlement: %s',
  async (scenario) => {
    const frames = [
      {
        type: 'message_start',
        message: {
          id: 'msg-input',
          type: 'message',
          role: 'assistant',
          model: 'fixture-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 4,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call-input',
          name: 'station_request_input',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"question":"Which scope?"}',
        },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: 'message_stop' },
    ];
    const f = await sdkFixture(
      'anthropic',
      '/api/orchestration/chat',
      () =>
        new Response(
          frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      undefined,
      'streamed',
      true,
    );
    const prepared = await f.owner.prepareSdkSnapshot(
      f.context(),
      subject,
      f.sealed.capability,
      f.sdkOwner,
    );
    const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
    const invocation = new AbortController();
    mkdirSync(join(f.home, 'report-groups'), { recursive: true, mode: 0o700 });
    const writer = await HomeWriterOwner.forHome(f.home);
    const ownerRuntime = new StationRuntime({ projectHomeDir: f.home });
    const participant = Reflect.get(
      ownerRuntime,
      'runtimePublicationParticipant',
    );
    assert.ok(isRuntimePublicationParticipant(participant));
    const publicationReady =
      deferred<
        Parameters<Parameters<typeof withReportRoundsPublication>[1]>[0]
      >();
    const publicationDone = deferred<void>();
    const publicationPending = withReportRoundsPublication(
      { participant, home: f.home, signal: invocation.signal },
      async (publication) => {
        publicationReady.resolve(publication);
        await publicationDone.promise;
      },
    );
    const publication = await publicationReady.promise;
    onTestFinished(async () => {
      publicationDone.resolve();
      try {
        await publicationPending;
      } finally {
        await ownerRuntime.shutdown();
      }
    });
    let held: HomeWriterLease | undefined;
    let watchingQueue = false;
    let bridgeAdmission = false;
    const inputRejected = deferred<unknown>();
    const queued = deferred<void>();
    const admissionRefused = deferred<unknown>();
    let expectedRunRefusal = false;
    const commitStarted = deferred<void>();
    let releaseCommit: (() => void) | undefined;
    const acknowledge = canonicalCommit.acknowledgeCanonicalRequestCommit;
    const commitObserver = vi
      .spyOn(canonicalCommit, 'acknowledgeCanonicalRequestCommit')
      .mockImplementation((...args) => {
        if (scenario === 'commit-wait' && args[0].method === 'request.opened') {
          releaseCommit = () => acknowledge(...args);
          commitStarted.resolve();
        } else acknowledge(...args);
      });
    onTestFinished(() => commitObserver.mockRestore());
    const acquire = writer.acquire.bind(writer);
    const acquireObserver = vi
      .spyOn(writer, 'acquire')
      .mockImplementation((signal) => {
        const pending = acquire(signal);
        if (watchingQueue && bridgeAdmission) {
          queued.resolve();
          void pending.catch((error) => admissionRefused.resolve(error));
        }
        return pending;
      });
    onTestFinished(() => acquireObserver.mockRestore());

    let runtimeSignal: AbortSignal | undefined;
    const binding = deferred<void>();
    const releaseOpen = deferred<void>();
    const answered = deferred<InputRequestResponse>();
    const finishTool = deferred<void>();
    const form: InputRequestForm = {
      schema: 'station.input-request/v1',
      source: 'mcp:report-input',
      requester: 'Report input',
      message: 'Which scope?',
      body: {
        kind: 'form',
        fields: [
          {
            name: 'answer',
            kind: 'string',
            required: true,
            minLength: 1,
            maxLength: 512,
          },
        ],
      },
    };
    let registry: ApprovalRegistry | undefined;
    let registrations = 0;
    let liveAdapter: StationAgentAdapter | undefined;
    const register = ApprovalRegistry.prototype.registerCanonicalAnswer;
    const interceptedRegistration = vi
      .spyOn(ApprovalRegistry.prototype, 'registerCanonicalAnswer')
      .mockImplementation(function (this: ApprovalRegistry, ...args) {
        registrations++;
        assert.throws(() => writer.assertSynchronous(), {
          reason: 'borrow-unavailable',
        });
        registry = this;
        return register.apply(this, args);
      });
    const startSession = StationAgentAdapter.prototype.startSession;
    const interceptedSession = vi
      .spyOn(StationAgentAdapter.prototype, 'startSession')
      .mockImplementation(function (this: StationAgentAdapter, ...args) {
        liveAdapter = this;
        return startSession.apply(this, args);
      });
    onTestFinished(() => {
      interceptedRegistration.mockRestore();
      interceptedSession.mockRestore();
    });
    const driver = await publicFenceFixture(
      f,
      prepared.source,
      f.sdkOwner,
      prepared.sdkHandle,
      wire,
      () => {},
      {
        provider: 'anthropic',
        protocol: 'rounds',
        reportHome: {
          owner: writer,
          persistence: new StationDelegationPersistence(
            join(f.home, 'report-groups'),
          ),
          current: () => undefined,
          preparationCurrent: () => undefined,
          check: (current, body) =>
            publication.check({ owner: writer, current }, body),
          invokeCurrent: (current, invoke) => {
            bridgeAdmission = true;
            try {
              return publication.invokeCurrent(
                { owner: writer, current },
                invoke,
              );
            } finally {
              bridgeAdmission = false;
            }
          },
        },
        contract: f.configuration.contract,
        now: () => 1000,
        invocationSignal: invocation.signal,
        inputRuntime: async (request, open, signal) => {
          runtimeSignal = signal;
          assert.deepEqual(
            { id: request.id, question: request.question },
            { id: 'call-input', question: 'Which scope?' },
          );
          assert.ok(request.providerEvidence);
          if (scenario === 'entry-contention') {
            held = await writer.acquire();
            watchingQueue = true;
          }
          const opening = open(form, async (event) => {
            assert.equal(
              event.turnId,
              driver.canonicalEvents().find((e) => e.method === 'turn.started')
                ?.turnId,
            );
            const available = await writer.acquire();
            await available.release();
            binding.resolve();
            await releaseOpen.promise;
          });
          void opening.catch((error) => inputRejected.resolve(error));
          if (scenario === 'entry-contention') {
            const first = await Promise.race([
              queued.promise.then(() => 'queued'),
              opening.then(
                () => 'returned',
                () => 'refused',
              ),
            ]);
            await held?.release();
            held = undefined;
            watchingQueue = false;
            assert.equal(
              first,
              'queued',
              'input entry must queue behind the actual Home holder',
            );
          }
          const response = await opening;
          answered.resolve(response);
          await assert.rejects(async () => open(form, async () => {}));
          await finishTool.promise;
        },
      },
    );
    const running = driver.run();
    try {
      await Promise.race([
        binding.promise,
        running.then(() => {
          throw Error(
            `Input was not reached: ${String(driver.invocationFailure)}`,
          );
        }),
      ]);
      assert.equal(f.starts, 1);
      assert.ok(
        !driver
          .canonicalEvents()
          .some(
            (e) =>
              e.method === 'request.opened' || e.method === 'turn.completed',
          ),
      );
      if (
        scenario === 'abort-before-open' ||
        scenario === 'invocation-abort-before-open'
      ) {
        if (scenario === 'abort-before-open') await driver.interrupt();
        else {
          invocation.abort('controlled invocation stop');
          await vi.waitFor(() => assert.equal(runtimeSignal?.aborted, true), {
            timeout: 10000,
          });
        }
        releaseOpen.resolve();
        await running;
        assert.ok(
          !driver.canonicalEvents().some((e) => e.method === 'request.opened'),
        );
        assert.equal(registry, undefined);
      } else {
        const queuedOpen = [
          'open-contention',
          'queued-abort',
          'queued-revocation',
        ].includes(scenario);
        if (queuedOpen) {
          held = await writer.acquire();
          watchingQueue = true;
        }
        releaseOpen.resolve();
        if (queuedOpen) {
          const first = await Promise.race([
            queued.promise.then(() => 'queued'),
            inputRejected.promise.then((error) => {
              throw error;
            }),
            running.then(
              () => 'returned',
              () => 'refused',
            ),
          ]);
          assert.equal(
            first,
            'queued',
            'post-persistence input must queue on its original Home',
          );
          assert.equal(registry, undefined);
          if (scenario === 'queued-abort') {
            invocation.abort('queued input cancelled');
            await admissionRefused.promise;
          }
          if (scenario === 'queued-revocation')
            writer.runWithLease(held!, () => {
              f.environment.devicePairing.revokeDevice(
                f.paired.device.id,
                'operator-credential',
              );
            });
          await held?.release();
          held = undefined;
          watchingQueue = false;
          if (scenario === 'queued-abort' || scenario === 'queued-revocation') {
            if (scenario === 'queued-revocation') {
              expectedRunRefusal = true;
              await assert.rejects(running, revokedRetention);
            } else await running;
            assert.ok(driver.invocationFailure);
            assert.equal(registry, undefined);
            assert.equal(
              driver
                .canonicalEvents()
                .filter(
                  (e) =>
                    e.method === 'request.opened' ||
                    e.method === 'request.resolved',
                ).length,
              0,
            );
            assert.equal(f.starts, 1);
            return;
          }
        }
        if (scenario === 'commit-wait') {
          await Promise.race([
            commitStarted.promise,
            inputRejected.promise.then((error) => {
              throw error;
            }),
            running.then(() => {
              throw Error('Input ended before canonical commit');
            }),
          ]);
          const available = await writer.acquire();
          await available.release();
          assert.ok(releaseCommit);
          releaseCommit();
          releaseCommit = undefined;
        }
        let opened:
          | Extract<
              ReturnType<typeof driver.canonicalEvents>[number],
              { method: 'request.opened' }
            >
          | undefined;
        await vi.waitFor(
          () => {
            const event = driver
              .canonicalEvents()
              .find((e) => e.method === 'request.opened');
            if (event?.method !== 'request.opened')
              throw Error('No persisted input event');
            opened = event;
          },
          { timeout: 10000 },
        );
        if (!opened || !liveAdapter || !registry)
          throw Error('Canonical input admission missing');
        if (scenario === 'invocation-abort-after-open') {
          invocation.abort('controlled invocation stop');
          await vi.waitFor(() => assert.equal(runtimeSignal?.aborted, true), {
            timeout: 10000,
          });
          await vi.waitFor(
            () => assert.equal(registry!.has(opened!.requestId), false),
            { timeout: 10000 },
          );
          await running;
          await vi.waitFor(
            () =>
              assert.ok(
                driver
                  .canonicalEvents()
                  .some(
                    (event) =>
                      event.method === 'runtime.error' &&
                      event.code === 'reserved_station_turn_failed',
                  ),
              ),
            { timeout: 10000 },
          );
          assert.ok(
            !driver
              .canonicalEvents()
              .some((event) => event.method === 'turn.completed'),
          );
          assert.equal(f.starts, 1);
          return;
        }
        assert.equal(registry.resolveAuthorized(opened.requestId, true), false);
        assert.equal(registry.resolve(opened.requestId, true), false);
        await assert.rejects(() =>
          liveAdapter!.respondToRequest(
            opened!.threadId,
            opened!.requestId,
            'accept',
            {
              expectedRequestEventId: 'foreign',
              inputContent: { answer: 'Only current source' },
            },
          ),
        );
        await assert.rejects(() =>
          liveAdapter!.respondToRequest(
            opened!.threadId,
            opened!.requestId,
            'accept',
            {
              expectedRequestEventId: opened!.eventId,
              inputContent: { answer: '' },
            },
          ),
        );
        // Human wait owns no Home lease.
        const available = await writer.acquire();
        await available.release();
        if (
          scenario === 'reply-contention' ||
          scenario === 'reply-revocation'
        ) {
          held = await writer.acquire();
          watchingQueue = true;
        }
        const responding = liveAdapter.respondToRequest(
          opened.threadId,
          opened.requestId,
          'accept',
          {
            expectedRequestEventId: opened.eventId,
            inputContent: { answer: 'Only current source' },
          },
        );
        void responding.catch(() => {});
        if (
          scenario === 'reply-contention' ||
          scenario === 'reply-revocation'
        ) {
          const first = await Promise.race([
            queued.promise.then(() => 'queued'),
            responding.then(
              () => 'returned',
              () => 'refused',
            ),
          ]);
          if (scenario === 'reply-revocation')
            writer.runWithLease(held!, () => {
              f.environment.devicePairing.revokeDevice(
                f.paired.device.id,
                'operator-credential',
              );
            });
          await held?.release();
          held = undefined;
          watchingQueue = false;
          assert.equal(
            first,
            'queued',
            'canonical answer must queue on the original Home',
          );
        }
        if (scenario === 'reply-revocation') {
          await assert.rejects(responding, /actual-local-grant-revoked/);
          assert.equal(
            driver
              .canonicalEvents()
              .filter((e) => e.method === 'request.resolved').length,
            0,
          );
          expectedRunRefusal = true;
          invocation.abort('revoked reply cleanup');
          await assert.rejects(running, revokedRetention);
          assert.equal(f.starts, 1);
          return;
        }
        await responding;
        const reply = await answered.promise;
        assert.equal(reply.action, 'accept');
        if (reply.action !== 'accept') throw Error('Input was not accepted');
        assert.deepEqual(
          { ...reply.content },
          { answer: 'Only current source' },
        );
        assert.ok(
          !driver.canonicalEvents().some((e) => e.method === 'turn.completed'),
        );
        await assert.rejects(() =>
          liveAdapter!.respondToRequest(
            opened!.threadId,
            opened!.requestId,
            'accept',
            {
              expectedRequestEventId: opened!.eventId,
              inputContent: { answer: 'late' },
            },
          ),
        );
        assert.equal(registrations, 1);
        assert.equal(
          driver.canonicalEvents().filter((e) => e.method === 'request.opened')
            .length,
          1,
        );
        assert.equal(
          driver
            .canonicalEvents()
            .filter((e) => e.method === 'request.resolved').length,
          1,
        );
        finishTool.resolve();
        await running;
        assert.equal(
          driver.canonicalEvents().filter((e) => e.method === 'turn.completed')
            .length,
          1,
        );
        assert.equal(driver.observed.length, 1);
      }
      assert.equal(f.starts, 1);
      assert.equal(driver.relayCalls, 0);
    } finally {
      releaseCommit?.();
      watchingQueue = false;
      await held?.release();
      held = undefined;
      releaseOpen.resolve();
      finishTool.resolve();
      await driver.interrupt();
      if (expectedRunRefusal) await assert.rejects(running, revokedRetention);
      else await running;
    }
  },
);
