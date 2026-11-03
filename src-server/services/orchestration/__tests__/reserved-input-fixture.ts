import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  InputRequestForm,
  InputRequestResponse,
} from '@kontourai/station-contracts/input-request';
import { onTestFinished, vi } from 'vitest';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import * as canonicalCommit from '../../../runtime/conversation/canonical-request-commit.js';
import {
  bindRuntimeLocalOperator,
  isRuntimeRequestPrincipalCurrent,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import {
  type HomeWriterLease,
  HomeWriterOwner,
} from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { inspectSdkSourceWire } from '../delegation-group-sdk-source-wire-owner.js';
import { OrchestrationCommandDispatchError } from '../orchestration-service.js';
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

export type ReservedInputScenario = (typeof scenarios)[number];
const scenarios = [
  'answer',
  'entry-contention',
  'open-contention',
  'reply-contention',
  'reply-revocation',
  'service-answer-current',
  'service-answer-revocation',
  'commit-wait',
  'queued-abort',
  'queued-revocation',
  'abort-before-open',
  'invocation-abort-before-open',
  'invocation-abort-after-open',
] as const;

export async function runReservedInputScenario(
  scenario: ReservedInputScenario,
) {
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
  const serviceAnswer = scenario.startsWith('service-answer-');
  const resolvePrincipal = createOrchestrationRequestPrincipalResolver({
    environmentSecurityService: f.environment,
  });
  const principal = resolvePrincipal(f.context());
  // Service-boundary proof: actual pairing/security owners and captured Requests,
  // without claiming runtime HTTP middleware ingress coverage.
  const pairAnsweringRequest = () => {
    const offer = f.environment.devicePairing.createOffer({
      endpoint: 'http://127.0.0.1:43979',
    });
    const pairing = f.environment.devicePairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'independent-answerer',
      requesterPosition: 'unproven',
    });
    f.environment.devicePairing.confirmRequest(pairing.requestId, {
      kind: 'presented-credential',
    });
    const paired = f.environment.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pairing.requestId,
      locality: 'home-possession',
      mintKind: 'local-grant',
    });
    const request = new Request(
      'http://127.0.0.1:43979/api/orchestration/commands',
      { method: 'POST' },
    );
    setRuntimeAuthenticatedRequestPrincipal(request, {
      kind: 'credential',
      authority: 'device-credential',
      credential: paired.credential,
      source: 'bearer',
      locality: 'home-possession',
      mintKind: 'local-grant',
    });
    bindRuntimeLocalOperator(request);
    const actor = resolvePrincipal({
      env: undefined,
      req: {
        raw: request,
        header: (name) => request.headers.get(name) ?? undefined,
      },
    });
    assert.equal(actor.id, principal.id);
    const current = () =>
      f.environment.withCurrentAuthority(() =>
        isRuntimeRequestPrincipalCurrent(request, f.environment),
      );
    assert.equal(current(), true);
    return { paired, current, actor };
  };
  const responderB = serviceAnswer ? pairAnsweringRequest() : undefined;
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
  let armReplyHolder = false;
  let replyHolder: Promise<HomeWriterLease> | undefined;
  let bridgeAdmission = false;
  const inputRejected = deferred<unknown>();
  const queued = deferred<void>();
  const admissionRefused = deferred<unknown>();
  let expectedRunRefusal = false;
  const commitStarted = deferred<void>();
  let releaseCommit: (() => void) | undefined;
  let earlyResponse: Promise<void> | undefined;
  const ownedResponses: Promise<unknown>[] = [];
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
  let disclosed = false;
  let approvedSettlements = 0;
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
      ...(serviceAnswer ? { principalId: principal.id } : {}),
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
          if (armReplyHolder) {
            armReplyHolder = false;
            // Enqueue the actual holder before the reply ticket, after B's
            // initial service guards. The holder cannot signal reply queueing.
            replyHolder = writer.acquire();
            watchingQueue = true;
          }
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
        disclosed = true;
        answered.resolve(response);
        await assert.rejects(async () => open(form, async () => {}));
        await finishTool.promise;
      },
    },
  );
  const unsubscribe = driver.eventBus.subscribe((event) => {
    if (
      event.event === 'approval:resolved' &&
      event.data?.status === 'approved'
    )
      approvedSettlements++;
  });
  onTestFinished(unsubscribe);
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
          (e) => e.method === 'request.opened' || e.method === 'turn.completed',
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
        const event = driver
          .canonicalEvents()
          .find((e) => e.method === 'request.opened');
        assert.ok(event?.method === 'request.opened' && liveAdapter);
        let settled = false;
        earlyResponse = liveAdapter.respondToRequest(
          event.threadId,
          event.requestId,
          'accept',
          {
            expectedRequestEventId: event.eventId,
            inputContent: { answer: 'Only current source' },
          },
        );
        void earlyResponse.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        // An independent Home acquisition follows any reply admission, while the
        // actual canonical acknowledgement is still held by its observer.
        const available = await writer.acquire();
        await available.release();
        assert.equal(
          settled,
          false,
          'reply must wait for canonical commit marking without holding Home',
        );
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
      if (scenario === 'reply-contention' || scenario === 'reply-revocation') {
        held = await writer.acquire();
        watchingQueue = true;
      }
      if (serviceAnswer) armReplyHolder = true;
      const answerThroughService = (
        responder: NonNullable<typeof responderB>,
      ) =>
        driver.orchestration.dispatch(
          {
            type: 'respondToRequest',
            threadId: opened!.threadId,
            requestId: opened!.requestId,
            expectedRequestEventId: opened!.eventId,
            decision: 'accept',
            content: { answer: 'Only current source' },
          },
          { userId: responder.actor.id, requestCurrent: responder.current },
        );
      const responding =
        (serviceAnswer ? answerThroughService(responderB!) : undefined) ??
        earlyResponse ??
        liveAdapter.respondToRequest(
          opened.threadId,
          opened.requestId,
          'accept',
          {
            expectedRequestEventId: opened.eventId,
            inputContent: { answer: 'Only current source' },
          },
        );
      ownedResponses.push(responding);
      void responding.catch(() => {});
      if (scenario === 'reply-contention' || scenario === 'reply-revocation') {
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
      if (serviceAnswer) {
        const first = await Promise.race([
          queued.promise.then(() => 'queued'),
          responding.then(
            () => 'returned',
            (error) => {
              throw error;
            },
          ),
        ]);
        assert.equal(first, 'queued');
        assert.ok(replyHolder);
        held = await replyHolder;
        replyHolder = undefined;
        if (scenario === 'service-answer-revocation') {
          writer.runWithLease(held, () => {
            f.environment.devicePairing.revokeDevice(
              responderB!.paired.device.id,
              'operator-credential',
            );
            assert.equal(responderB!.current(), false);
            assert.equal(
              isRuntimeRequestPrincipalCurrent(f.req, f.environment),
              true,
            );
          });
        }
        await held.release();
        held = undefined;
        watchingQueue = false;
        if (scenario === 'service-answer-revocation') {
          await assert.rejects(
            responding,
            (error: unknown) =>
              error instanceof OrchestrationCommandDispatchError &&
              error.receipt.status === 'rejected' &&
              error.code === 'request_verification_unavailable' &&
              error.message ===
                'Request authority changed before the decision.',
          );
          assert.equal(disclosed, false);
          assert.equal(approvedSettlements, 0);
          assert.equal(registry.has(opened.requestId), true);
          assert.equal(
            driver
              .canonicalEvents()
              .filter((e) => e.method === 'request.resolved').length,
            0,
          );
          const responderC = pairAnsweringRequest();
          await answerThroughService(responderC);
        }
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
      if (scenario !== 'service-answer-revocation') await responding;
      const reply = await answered.promise;
      assert.equal(reply.action, 'accept');
      if (reply.action !== 'accept') throw Error('Input was not accepted');
      assert.deepEqual({ ...reply.content }, { answer: 'Only current source' });
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
      assert.equal(approvedSettlements, 1);
      assert.equal(registrations, 1);
      assert.equal(
        driver.canonicalEvents().filter((e) => e.method === 'request.opened')
          .length,
        1,
      );
      assert.equal(
        driver.canonicalEvents().filter((e) => e.method === 'request.resolved')
          .length,
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
    armReplyHolder = false;
    watchingQueue = false;
    if (!held && replyHolder) held = await replyHolder;
    await held?.release();
    held = undefined;
    releaseOpen.resolve();
    finishTool.resolve();
    await driver.interrupt();
    await Promise.allSettled(ownedResponses);
    if (expectedRunRefusal) await assert.rejects(running, revokedRetention);
    else await running;
  }
}
