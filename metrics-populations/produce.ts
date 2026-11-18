import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const home = process.env.STATION_HOME!;
mkdirSync(home, { recursive: true, mode: 0o700 });
const { configuredTelemetryShutdownTask } = await import(
  '../../src-server/telemetry.ts'
);
const { SchedulerService } = await import(
  '../../src-server/services/scheduling/scheduler-service.ts'
);
const { createSchedulerLedger } = await import(
  '../../src-server/services/scheduling/scheduler-ledger.ts'
);
const { createSchedulerRoutes } = await import(
  '../../src-server/routes/operations/scheduler.ts'
);
const { createLogger } = await import('../../src-server/utils/logger.ts');
const { ChatTurnDedupStore } = await import(
  '../../src-server/routes/chat/chat-turn-dedup.ts'
);
const { buildChatHarnessApp, createHarnessConversationStore } = await import(
  '../../src-server/__test-utils__/chat-primary-stream-harness.ts'
);
const ledger = createSchedulerLedger({ directory: join(home, 'timers') });
ledger.create({
  name: 'collector-auto',
  prompt: 'auto',
  schedule: { kind: 'every', everyMs: 3600000 },
  enabled: true,
  createdAt: new Date(Date.now() - 7200000).toISOString(),
});
const logger = createLogger({ name: 'isolated-observability', level: 'warn' });
const scheduler = new SchedulerService({
  logger,
  builtin: {
    ledger,
    turnAdapter: {
      invoke: async ({ prompt }) =>
        prompt === 'fail'
          ? { kind: 'failed', error: 'fixture execution failed' }
          : prompt === 'refuse'
            ? { kind: 'definitely-not-invoked', error: 'fixture refused' }
            : { kind: 'completed', output: 'fixture completion' },
    },
  },
});
try {
  const routes = createSchedulerRoutes(scheduler, logger);
  for (const [prompt, expected] of [
    ['complete', 200],
    ['fail', 409],
    ['refuse', 422],
  ] as const) {
    assert(
      (
        await routes.request('/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'fixture-' + prompt,
            prompt,
            cron: '0 0 1 1 *',
          }),
        })
      ).ok,
    );
    const result = await routes.request('/jobs/fixture-' + prompt + '/run', {
      method: 'POST',
    });
    assert.equal(result.status, expected, await result.text());
  }
  const auto = await scheduler.getJobLogs('collector-auto');
  assert.equal(auto[0]?.state, 'completed');
  const chat = (streamText) =>
    buildChatHarnessApp({
      agent: {
        getMemory: () => null,
        model: { modelId: 'fixture-engine' },
        streamText,
      },
      conversations: createHarnessConversationStore(),
      dedupStore: new ChatTurnDedupStore(join(home, 'dedup.json')),
    });
  const successful = chat(async () => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', text: 'Fixture output' };
      yield { type: 'finish', finishReason: 'stop' };
    })(),
    text: Promise.resolve('Fixture output'),
    usage: Promise.resolve({ inputTokens: 12, outputTokens: 7 }),
    finishReason: Promise.resolve('stop'),
  }));
  const failing = chat(async () => {
    throw new Error('fixture primary stream failed');
  });
  for (const [app, marker] of [
    [successful, 'Fixture output'],
    [failing, '"type":"error"'],
  ] as const) {
    const res = await app.request('/chat', { method: 'POST' });
    assert.equal(res.status, 200);
    assert((await res.text()).includes(marker));
  }
  const controller = new AbortController();
  const canceled = chat(async () => {
    controller.abort();
    throw new DOMException('Fixture client cancel', 'AbortError');
  });
  await (
    await canceled.request('/chat', {
      method: 'POST',
      signal: controller.signal,
    })
  ).text();
  // Station's production reader exports every 30 seconds. Send a second
  // observation after the first batch so Prometheus can compute a real rate.
  await delay(34_000);
  await (await successful.request('/chat', { method: 'POST' })).text();
  const nextRun = await routes.request('/jobs/fixture-complete/run', {
    method: 'POST',
  });
  assert.equal(nextRun.status, 200, await nextRun.text());
  await delay(2_000);
  console.log('Scheduler and primary-chat callers completed');
} finally {
  await scheduler.stop();
  await configuredTelemetryShutdownTask()?.shutdown(
    AbortSignal.timeout(12_000),
  );
}
