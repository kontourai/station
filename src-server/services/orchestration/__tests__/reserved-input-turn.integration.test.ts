import assert from 'node:assert/strict';
import type {
  InputRequestForm,
  InputRequestResponse,
} from '@kontourai/station-contracts/input-request';
import { onTestFinished, test, vi } from 'vitest';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { inspectSdkSourceWire } from '../delegation-group-sdk-source-wire-owner.js';
import { publicFenceFixture } from './delegation-source-fixtures/fence.js';
import { deferred } from './delegation-source-fixtures/sdk.js';
import { sdkFixture } from './delegation-source-fixtures/sdk-source.js';
import { subject } from './delegation-source-fixtures/source.js';

test.each([
  'answer',
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
    let liveAdapter: StationAgentAdapter | undefined;
    const register = ApprovalRegistry.prototype.registerCanonicalAnswer;
    const interceptedRegistration = vi
      .spyOn(ApprovalRegistry.prototype, 'registerCanonicalAnswer')
      .mockImplementation(function (this: ApprovalRegistry, ...args) {
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
          const response = await open(form, async (event) => {
            assert.equal(
              event.turnId,
              driver.canonicalEvents().find((e) => e.method === 'turn.started')
                ?.turnId,
            );
            binding.resolve();
            await releaseOpen.promise;
          });
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
        releaseOpen.resolve();
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
        await driver.orchestration.dispatch({
          type: 'respondToRequest',
          threadId: opened.threadId,
          requestId: opened.requestId,
          expectedRequestEventId: opened.eventId,
          decision: 'accept',
          content: { answer: 'Only current source' },
        });
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
      releaseOpen.resolve();
      finishTool.resolve();
      await driver.interrupt();
      await running;
    }
  },
);
