import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { RESERVED_SOURCE_EXECUTION_METADATA_KEY } from '@kontourai/station-contracts/provider';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { onTestFinished, vi } from 'vitest';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { createReportInputRuntime } from '../../../runtime/mcp/report-input-runtime.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { inspectSdkSourceWire } from '../delegation-group-sdk-source-wire-owner.js';
import {
  type ReportInputBinding,
  ReportInputLedger,
  reportInputKey,
  reportInputRecordSchema,
} from '../report-input-ledger.js';
import {
  type ReportRoundsPublication,
  withReportRoundsPublication,
} from '../report-rounds-publication.js';
import { publicFenceFixture } from './delegation-source-fixtures/fence.js';
import { sdkFixture } from './delegation-source-fixtures/sdk-source.js';
import { subject } from './delegation-source-fixtures/source.js';
import { controlledInputStream } from './delegation-source-fixtures/streamed-text.js';

const handlerObserver = vi.hoisted(() => {
  const state: { onFetch?: () => void } = {};
  return state;
});
vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@modelcontextprotocol/server')>();
  return {
    ...actual,
    createMcpHandler: (...args: Parameters<typeof actual.createMcpHandler>) => {
      const handler = actual.createMcpHandler(...args);
      const fetch = handler.fetch;
      const spy = vi
        .spyOn(handler, 'fetch')
        .mockImplementation((...request) => {
          handlerObserver.onFetch?.();
          return fetch(...request);
        });
      onTestFinished(() => spy.mockRestore());
      return handler;
    },
  };
});

type ReportInputRuntimeScenario =
  | 'accept'
  | 'decline'
  | 'cancel'
  | 'abort'
  | 'owner-close'
  | 'no-grant'
  | 'send-failed'
  | 'storage-drift'
  | 'close-failed'
  | 'registration-failed'
  | 'publication-retire'
  | 'delivery-withdrawn'
  | 'close-before-authorization'
  | 'close-before-evidence'
  | 'close-before-result';

export async function qualifyReportInputRuntime(
  scenario: ReportInputRuntimeScenario,
) {
  const f = await sdkFixture(
    'anthropic',
    '/api/orchestration/chat',
    () => controlledInputStream('fixture-model', 'Which scope?'),
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
  const reportRoot = join(f.home, 'report-groups');
  mkdirSync(reportRoot, { mode: 0o700, recursive: true });
  const persistence = new StationDelegationPersistence(reportRoot);
  const read = (value: ReportInputBinding) =>
    reportInputRecordSchema.parse(
      JSON.parse(
        readFileSync(
          join(
            reportRoot,
            'station-report-input-v1',
            `${reportInputKey(value)}.json`,
          ),
          'utf8',
        ),
      ),
    );
  const externalFetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('External transport forbidden'));
  onTestFinished(() => externalFetch.mockRestore());
  let binding: ReportInputBinding | undefined;
  let answerSendStarted = false;
  let deliveryWithdrawn = false;
  let deliveryRefusals = 0;
  let handlerCalls = 0;
  let staleHandlerCalls = 0;
  const deliveryFailure = new Error('controlled input delivery withdrawal');
  handlerObserver.onFetch = () => {
    handlerCalls++;
    if (deliveryWithdrawn) staleHandlerCalls++;
  };
  onTestFinished(() => {
    handlerObserver.onFetch = undefined;
  });
  const sends: Array<{ ordinal: number; answer: boolean }> = [];
  const originalSend = StreamableHTTPClientTransport.prototype.send;
  const intercepted = vi
    .spyOn(StreamableHTTPClientTransport.prototype, 'send')
    .mockImplementation(async function (
      this: StreamableHTTPClientTransport,
      message,
      options,
    ) {
      if ('method' in message && message.method === 'tools/call') {
        if (!binding) throw Error('Input binding missing at physical send');
        const retained = read(binding);
        if (!retained) throw Error('Physical send preceded durable admission');
        sends.push({
          ordinal: retained.physicalSends,
          answer: retained.answer !== undefined,
        });
        if (scenario === 'delivery-withdrawn' && retained.physicalSends === 2)
          answerSendStarted = true;
        if (scenario === 'send-failed' && retained.physicalSends === 2)
          throw new Error('controlled physical send failure');
      }
      return originalSend.call(this, message, options);
    });
  onTestFinished(() => intercepted.mockRestore());
  const closed: StreamableHTTPClientTransport[] = [];
  const originalClose = StreamableHTTPClientTransport.prototype.close;
  let cleanupAllowed = false;
  const close = vi
    .spyOn(StreamableHTTPClientTransport.prototype, 'close')
    .mockImplementation(async function (this: StreamableHTTPClientTransport) {
      closed.push(this);
      if (scenario === 'close-failed' && !cleanupAllowed)
        throw new Error('controlled transport close failure');
      return originalClose.call(this);
    });
  onTestFinished(() => close.mockRestore());
  const invocation = new AbortController();
  const ownerRuntime = new StationRuntime({ projectHomeDir: f.home });
  const participant = Reflect.get(
    ownerRuntime,
    'runtimePublicationParticipant',
  );
  assert.ok(isRuntimePublicationParticipant(participant));
  let ready!: (publication: ReportRoundsPublication) => void;
  const publicationReady = new Promise<ReportRoundsPublication>((resolve) => {
    ready = resolve;
  });
  let done!: () => void;
  const publicationDone = new Promise<void>((resolve) => {
    done = resolve;
  });
  const publicationPending = withReportRoundsPublication(
    { participant, home: f.home, signal: invocation.signal },
    async (publication) => {
      ready(publication);
      await publicationDone;
    },
  );
  const publication = await publicationReady;
  const writer = await HomeWriterOwner.forHome(f.home);
  let expectedPublicationFailure: unknown;
  let registrationRefused = false;
  const registrationFailure = new Error(
    'controlled cleanup registration failure',
  );
  const preallocationClose =
    scenario === 'close-before-authorization' ||
    scenario === 'close-before-evidence';
  let enterOwnerOperation!: () => void;
  const ownerOperationEntered = new Promise<void>((resolve) => {
    enterOwnerOperation = resolve;
  });
  let releaseOwnerOperation!: () => void;
  const ownerOperationGate = new Promise<void>((resolve) => {
    releaseOwnerOperation = resolve;
  });
  let heldStage: 'authorization' | 'evidence' | 'result' | undefined;
  let inputSettled = false;
  const holdOwnerOperation = async (
    stage: 'authorization' | 'evidence' | 'result',
  ) => {
    heldStage = stage;
    enterOwnerOperation();
    await ownerOperationGate;
  };
  let questionSignal: AbortSignal | undefined;
  const runtime = createReportInputRuntime({
    retainCleanup: (cleanup) => {
      if (scenario === 'registration-failed') {
        registrationRefused = true;
        throw registrationFailure;
      }
      return publication.retainCleanup(cleanup);
    },
    persistence,
    check: async (current, body) => {
      const value = await publication.check({ owner: writer, current }, body);
      if (scenario === 'delivery-withdrawn' && answerSendStarted)
        deliveryWithdrawn = true;
      return value;
    },
    withHome: (current, body) =>
      publication.withHome({ owner: writer, current }, async (scope) => {
        const value = await body(scope);
        if (scenario === 'close-before-evidence')
          await holdOwnerOperation('evidence');
        if (scenario === 'close-before-result' && binding) {
          const file = join(
            reportRoot,
            'station-report-input-v1',
            `${reportInputKey(binding)}.json`,
          );
          if (existsSync(file) && read(binding).result !== undefined)
            await holdOwnerOperation('result');
        }
        return value;
      }),
    invokeCurrent: (current, invoke) =>
      publication.invokeCurrent({ owner: writer, current }, invoke),
    authorize: async (scope) => {
      const value = await driver.authorizeInput(scope.envelope.id);
      if (scenario === 'close-before-authorization')
        await holdOwnerOperation('authorization');
      return value;
    },
  });
  onTestFinished(async () => {
    cleanupAllowed = true;
    const failures: unknown[] = [];
    try {
      await runtime.close();
    } catch (error) {
      failures.push(error);
    }
    done();
    try {
      await publicationPending;
    } catch (error) {
      if (error !== expectedPublicationFailure) failures.push(error);
    }
    try {
      await ownerRuntime.shutdown();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, 'Input cleanup failed');
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
      contract: f.configuration.contract,
      now: () => 1000,
      invocationSignal: invocation.signal,
      allowedTools: scenario === 'no-grant' ? [] : ['station_request_input'],
      inputRuntime: (request, open, signal, current) => {
        binding = request.binding;
        const pending = runtime(
          request,
          (form, beforeOpen, requestSignal) => {
            questionSignal = requestSignal;
            return open(form, beforeOpen, requestSignal);
          },
          signal,
          scenario === 'delivery-withdrawn'
            ? () => {
                current();
                if (deliveryWithdrawn) {
                  deliveryRefusals++;
                  throw deliveryFailure;
                }
                return undefined;
              }
            : current,
        );
        void pending.then(
          () => {
            inputSettled = true;
          },
          () => {
            inputSettled = true;
          },
        );
        return pending;
      },
    },
  );
  type Opened = Extract<
    ReturnType<typeof driver.canonicalEvents>[number],
    { method: 'request.opened' }
  >;
  let stopInput = () => {};
  const inputOpened = new Promise<Opened>((resolve) => {
    stopInput = driver.eventBus.subscribe(({ event }) => {
      if (event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
      const opened = driver
        .canonicalEvents()
        .find((entry) => entry.method === 'request.opened');
      if (opened?.method === 'request.opened') {
        stopInput();
        resolve(opened);
      }
    });
  });
  onTestFinished(() => stopInput());
  const running = driver.run();
  let answering: Promise<unknown> | undefined;
  const closeWhileOwnerHeld = async () => {
    let closeSettled = false;
    const closing = runtime.close().then(() => {
      closeSettled = true;
    });
    void closing.catch(() => {});
    await setImmediate();
    const returnedBeforeOwnerRetired = closeSettled;
    releaseOwnerOperation();
    await closing;
    await running;
    return returnedBeforeOwnerRetired;
  };
  try {
    if (preallocationClose) {
      await Promise.race([
        ownerOperationEntered,
        running.then(() => {
          throw (
            driver.invocationFailure ??
            new Error('Input returned before the preallocation owner barrier')
          );
        }),
      ]);
      assert.equal(
        heldStage,
        scenario === 'close-before-authorization'
          ? 'authorization'
          : 'evidence',
      );
      assert.ok(binding);
      assert.equal(inputSettled, false);
      assert.equal(handlerCalls, 0);
      assert.deepEqual(sends, []);
      const returnedBeforeOwnerRetired = await closeWhileOwnerHeld();
      assert.equal(inputSettled, true);
      assert.ok(driver.invocationFailure);
      assert.equal(handlerCalls, 0);
      assert.deepEqual(sends, []);
      assert.deepEqual(closed, []);
      assert.ok(
        !driver
          .canonicalEvents()
          .some(
            (event) =>
              event.method === 'request.opened' ||
              event.method === 'turn.completed',
          ),
      );
      assert.equal(
        existsSync(
          join(
            reportRoot,
            'station-report-input-v1',
            `${reportInputKey(binding)}.json`,
          ),
        ),
        false,
      );
      assert.equal(f.starts, 1);
      assert.equal(driver.relayCalls, 0);
      assert.equal(externalFetch.mock.calls.length, 0);
      done();
      await publicationPending;
      await ownerRuntime.shutdown();
      assert.equal(
        returnedBeforeOwnerRetired,
        false,
        'runtime close must join admitted input work before protocol-resource allocation',
      );
      return;
    }
    if (scenario === 'no-grant' || scenario === 'registration-failed') {
      await running;
      assert.ok(driver.invocationFailure);
      assert.deepEqual(sends, []);
      if (scenario === 'registration-failed') {
        assert.equal(registrationRefused, true);
        assert.equal(driver.invocationFailure, registrationFailure);
        assert.ok(binding);
        assert.equal(
          existsSync(
            join(
              reportRoot,
              'station-report-input-v1',
              `${reportInputKey(binding)}.json`,
            ),
          ),
          false,
          'cleanup registration must precede the durable input claim',
        );
      }
      assert.ok(
        !driver
          .canonicalEvents()
          .some((event) => event.method === 'request.opened'),
      );
      assert.equal(f.starts, 1);
      return;
    }
    const opened = await Promise.race([
      inputOpened,
      running.then(() => {
        throw (
          driver.invocationFailure ??
          new Error('Input operation returned without a canonical form')
        );
      }),
    ]);
    if (!opened || !binding) throw Error('Canonical binding missing');
    await writer.runRequest(invocation.signal, () => {
      assert.equal(sends.length, 1);
    });
    const question = read(binding);
    assert.equal(question?.question?.eventId, opened.eventId);
    assert.equal(question?.question?.requestId, opened.requestId);
    assert.deepEqual(sends, [{ ordinal: 1, answer: false }]);
    assert.ok(
      !driver
        .canonicalEvents()
        .some((event) => event.method === 'turn.completed'),
    );
    if (
      scenario === 'abort' ||
      scenario === 'owner-close' ||
      scenario === 'publication-retire'
    ) {
      if (scenario === 'publication-retire') {
        assert.ok(questionSignal);
        done();
        let shutdownFailure: unknown;
        try {
          await ownerRuntime.shutdown();
        } catch (error) {
          shutdownFailure = error;
        }
        assert.equal(
          questionSignal.aborted,
          true,
          'publication retirement must abort its open input question',
        );
        if (shutdownFailure) throw shutdownFailure;
      } else if (scenario === 'owner-close') await runtime.close();
      else invocation.abort('controlled stop while awaiting input');
      await running;
      if (scenario === 'publication-retire')
        await assert.rejects(() =>
          driver.orchestration.dispatch({
            type: 'respondToRequest',
            threadId: opened.threadId,
            requestId: opened.requestId,
            expectedRequestEventId: opened.eventId,
            decision: 'accept',
            content: { answer: 'LATE_SCOPE' },
          }),
        );
      const retained = read(binding);
      assert.equal(retained?.physicalSends, 1);
      assert.ok(retained?.question);
      assert.equal(retained.answer, undefined);
      assert.equal(retained.result, undefined);
      assert.deepEqual(sends, [{ ordinal: 1, answer: false }]);
    } else {
      const command = {
        type: 'respondToRequest' as const,
        threadId: opened.threadId,
        requestId: opened.requestId,
        expectedRequestEventId: opened.eventId,
        decision:
          scenario === 'send-failed' ||
          scenario === 'storage-drift' ||
          scenario === 'close-failed' ||
          scenario === 'delivery-withdrawn' ||
          scenario === 'close-before-result'
            ? ('accept' as const)
            : scenario,
      };
      if (scenario === 'storage-drift') {
        const changed = read(binding);
        changed.binding.turnId = 'foreign-native-turn';
        writeFileSync(
          join(
            reportRoot,
            'station-report-input-v1',
            `${reportInputKey(binding)}.json`,
          ),
          JSON.stringify(changed),
        );
      }
      const answer = driver.orchestration.dispatch({
        ...command,
        ...(scenario === 'accept' ||
        scenario === 'send-failed' ||
        scenario === 'storage-drift' ||
        scenario === 'close-failed' ||
        scenario === 'delivery-withdrawn' ||
        scenario === 'close-before-result'
          ? { content: { answer: 'CONTROLLED_SCOPE' } }
          : {}),
      });
      answering = answer;
      void answer.catch(() => {});
      if (scenario === 'close-before-result') {
        await Promise.race([
          ownerOperationEntered,
          running.then(() => {
            throw (
              driver.invocationFailure ??
              new Error('Input returned before final ledger owner barrier')
            );
          }),
        ]);
        assert.equal(heldStage, 'result');
        assert.equal(inputSettled, false);
        assert.equal(
          closed.length,
          1,
          'physical MCP resource retired before the final ledger return',
        );
        assert.deepEqual(sends, [
          { ordinal: 1, answer: false },
          { ordinal: 2, answer: true },
        ]);
        const returnedBeforeOwnerRetired = await closeWhileOwnerHeld();
        await Promise.allSettled([answer]);
        assert.equal(inputSettled, true);
        assert.ok(driver.invocationFailure);
        assert.equal(closed.length, 1);
        assert.equal(read(binding).physicalSends, 2);
        assert.deepEqual(read(binding).result, {
          action: 'accept',
          content: { answer: 'CONTROLLED_SCOPE' },
        });
        assert.equal(driver.observed.length, 0);
        assert.ok(
          !driver
            .canonicalEvents()
            .some((event) => event.method === 'turn.completed'),
        );
        assert.equal(driver.relayCalls, 0);
        assert.equal(externalFetch.mock.calls.length, 0);
        done();
        await publicationPending;
        await ownerRuntime.shutdown();
        assert.equal(
          returnedBeforeOwnerRetired,
          false,
          'runtime close must join final ledger work after physical MCP retirement',
        );
        return;
      }
      await answer;
      await running;
      if (
        scenario === 'send-failed' ||
        scenario === 'storage-drift' ||
        scenario === 'close-failed' ||
        scenario === 'delivery-withdrawn'
      ) {
        assert.ok(driver.invocationFailure);
        const failed = read(binding);
        assert.equal(
          failed.physicalSends,
          scenario === 'storage-drift' ? 1 : 2,
        );
        assert.equal(failed.result, undefined);
        assert.equal(sends.length, scenario === 'storage-drift' ? 1 : 2);
        if (scenario === 'delivery-withdrawn') {
          assert.equal(answerSendStarted, true);
          assert.equal(deliveryWithdrawn, true);
          assert.ok(
            handlerCalls > 0,
            'ordinary MCP handler delivery must be observed',
          );
          assert.equal(
            staleHandlerCalls,
            0,
            'MCP handler must not receive a request after currentness withdrawal',
          );
          assert.ok(
            deliveryRefusals > 0,
            'controlled currentness refusal must execute',
          );
          assert.ok(failed.answer);
        }
        if (scenario === 'close-failed') {
          assert.equal(closed.length, 1);
          done();
          await assert.rejects(publicationPending, (error: unknown) => {
            expectedPublicationFailure = error;
            return (
              error instanceof DelegationRoundsTransactionUncertainError &&
              error.status === 'returned-cleanup-unknown'
            );
          });
          await assert.rejects(
            ownerRuntime.shutdown(),
            /Runtime publication remains pending/,
          );
          cleanupAllowed = true;
          const beforeRetry = closed.length;
          await ownerRuntime.shutdown();
          assert.equal(closed.length, beforeRetry + 1);
          assert.ok(closed.every((transport) => transport === closed[0]));
          assert.equal(sends.length, 2);
          assert.equal(read(binding).result, undefined);
        }
        assert.ok(
          !driver
            .canonicalEvents()
            .some((event) => event.method === 'turn.completed'),
        );
      } else {
        assert.equal(driver.invocationFailure, undefined);
        assert.deepEqual(sends, [
          { ordinal: 1, answer: false },
          { ordinal: 2, answer: true },
        ]);
        const retained = read(binding);
        const expected =
          scenario === 'accept'
            ? { action: 'accept', content: { answer: 'CONTROLLED_SCOPE' } }
            : { action: scenario };
        assert.deepEqual(retained?.answer, expected);
        assert.deepEqual(retained?.result, expected);
        const completed = driver
          .canonicalEvents()
          .find((event) => event.method === 'turn.completed');
        assert.ok(completed?.method === 'turn.completed');
        const metadata =
          completed.metadata?.[RESERVED_SOURCE_EXECUTION_METADATA_KEY];
        assert.ok(
          metadata &&
            typeof metadata === 'object' &&
            'inputReceipt' in metadata,
        );
        assert.ok(!JSON.stringify(metadata).includes('CONTROLLED_SCOPE'));
        assert.equal(driver.observed.length, 1);
        const authority = await driver.ledger();
        assert.deepEqual(authority.invocations[0].usage, binding.usage);
        await assert.rejects(() => driver.orchestration.dispatch(command));
      }
    }
    const reopened = new ReportInputLedger(
      new StationDelegationPersistence(reportRoot).reportInputStore(
        () => undefined,
      ),
    );
    await assert.rejects(() => reopened.begin(binding!), /already_claimed/);
    await assert.rejects(() => reopened.consumeSend(binding!), /no_live_claim/);
    assert.equal(f.starts, 1);
    assert.equal(driver.relayCalls, 0);
    assert.equal(externalFetch.mock.calls.length, 0);
  } finally {
    releaseOwnerOperation();
    invocation.abort('fixture cleanup');
    await driver.interrupt();
    await running;
    if (answering) await Promise.allSettled([answering]);
  }
}
