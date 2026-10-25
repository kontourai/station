import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVED_SOURCE_EXECUTION_METADATA_KEY } from '@kontourai/station-contracts/provider';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { onTestFinished, test, vi } from 'vitest';
import { createReportInputRuntime } from '../../../runtime/mcp/report-input-runtime.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { inspectSdkSourceWire } from '../delegation-group-sdk-source-wire-owner.js';
import {
  type ReportInputBinding,
  ReportInputLedger,
  reportInputKey,
  reportInputRecordSchema,
} from '../report-input-ledger.js';
import { publicFenceFixture } from './delegation-source-fixtures/fence.js';
import { sdkFixture } from './delegation-source-fixtures/sdk-source.js';
import { subject } from './delegation-source-fixtures/source.js';
import { controlledInputStream } from './delegation-source-fixtures/streamed-text.js';

test.each([
  'accept',
  'decline',
  'cancel',
  'abort',
  'owner-close',
  'no-grant',
  'send-failed',
  'storage-drift',
  'close-failed',
] as const)(
  'fixed MCP input preserves canonical answer and durable send custody: %s',
  async (scenario) => {
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
    const persistence = new StationDelegationPersistence(f.root);
    const read = (value: ReportInputBinding) =>
      reportInputRecordSchema.parse(
        JSON.parse(
          readFileSync(
            join(
              f.root,
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
          if (!retained)
            throw Error('Physical send preceded durable admission');
          sends.push({
            ordinal: retained.physicalSends,
            answer: retained.answer !== undefined,
          });
          if (scenario === 'send-failed' && retained.physicalSends === 2)
            throw new Error('controlled physical send failure');
        }
        return originalSend.call(this, message, options);
      });
    onTestFinished(() => intercepted.mockRestore());
    const closed: StreamableHTTPClientTransport[] = [];
    const originalClose = StreamableHTTPClientTransport.prototype.close;
    const close = vi
      .spyOn(StreamableHTTPClientTransport.prototype, 'close')
      .mockImplementation(async function (this: StreamableHTTPClientTransport) {
        closed.push(this);
        if (scenario === 'close-failed' && closed.length === 1)
          throw new Error('controlled transport close failure');
        return originalClose.call(this);
      });
    onTestFinished(() => close.mockRestore());
    const invocation = new AbortController();
    const runtime = createReportInputRuntime({
      persistence,
      authorize: (scope) => driver.authorizeInput(scope.envelope.id),
    });
    onTestFinished(() => runtime.close());
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
          return runtime(request, open, signal, current);
        },
      },
    );
    const running = driver.run();
    try {
      if (scenario === 'no-grant') {
        await running;
        assert.ok(driver.invocationFailure);
        assert.deepEqual(sends, []);
        assert.ok(
          !driver
            .canonicalEvents()
            .some((event) => event.method === 'request.opened'),
        );
        assert.equal(f.starts, 1);
        return;
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
            throw Error(
              `No canonical form: ${String(driver.invocationFailure)}`,
            );
          opened = event;
        },
        { timeout: 10000 },
      );
      if (!opened || !binding) throw Error('Canonical binding missing');
      const question = read(binding);
      assert.equal(question?.question?.eventId, opened.eventId);
      assert.equal(question?.question?.requestId, opened.requestId);
      assert.deepEqual(sends, [{ ordinal: 1, answer: false }]);
      assert.ok(
        !driver
          .canonicalEvents()
          .some((event) => event.method === 'turn.completed'),
      );
      if (scenario === 'abort' || scenario === 'owner-close') {
        if (scenario === 'owner-close') await runtime.close();
        else invocation.abort('controlled stop while awaiting input');
        await running;
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
            scenario === 'close-failed'
              ? ('accept' as const)
              : scenario,
        };
        if (scenario === 'storage-drift') {
          const changed = read(binding);
          changed.binding.turnId = 'foreign-native-turn';
          writeFileSync(
            join(
              f.root,
              'station-report-input-v1',
              `${reportInputKey(binding)}.json`,
            ),
            JSON.stringify(changed),
          );
        }
        await driver.orchestration.dispatch({
          ...command,
          ...(scenario === 'accept' ||
          scenario === 'send-failed' ||
          scenario === 'storage-drift' ||
          scenario === 'close-failed'
            ? { content: { answer: 'CONTROLLED_SCOPE' } }
            : {}),
        });
        await running;
        if (
          scenario === 'send-failed' ||
          scenario === 'storage-drift' ||
          scenario === 'close-failed'
        ) {
          assert.ok(driver.invocationFailure);
          const failed = read(binding);
          assert.equal(
            failed.physicalSends,
            scenario === 'storage-drift' ? 1 : 2,
          );
          assert.equal(failed.result, undefined);
          assert.equal(sends.length, scenario === 'storage-drift' ? 1 : 2);
          if (scenario === 'close-failed') {
            assert.equal(closed.length, 1);
            await runtime.close();
            assert.equal(closed.length, 2);
            assert.equal(closed[0], closed[1]);
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
        new StationDelegationPersistence(f.root).reportInputStore(
          () => undefined,
        ),
      );
      await assert.rejects(() => reopened.begin(binding!), /already_claimed/);
      await assert.rejects(
        () => reopened.consumeSend(binding!),
        /no_live_claim/,
      );
      assert.equal(f.starts, 1);
      assert.equal(driver.relayCalls, 0);
      assert.equal(externalFetch.mock.calls.length, 0);
    } finally {
      invocation.abort('fixture cleanup');
      await driver.interrupt();
      await running;
    }
  },
);
