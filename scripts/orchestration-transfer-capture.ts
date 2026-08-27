import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpTransferRecorder } from '../src-server/__test-utils__/http-transfer-recorder.js';

const targetRoot = resolve(process.argv[2] ?? '');
const outputPath = process.argv[3];
const baseSha = process.argv[4];
const toolRoot = resolve(process.argv[5] ?? process.cwd());
if (!targetRoot || !outputPath)
  throw new Error('usage: capture <target-root> <report-path>');
const productionFiles = [
  'src-server/routes/orchestration/orchestration.ts',
  'src-server/runtime/bootstrap/runtime-http.ts',
  'src-server/services/orchestration/event-bus.ts',
  'src-server/services/orchestration/event-store.ts',
  'src-server/services/orchestration/orchestration-service.ts',
  'src-server/providers/adapters/station-agent-adapter.ts',
  'src-server/providers/sessions/async-event-queue.ts',
  'packages/sdk/src/client/http.ts',
];
const git = (...args: string[]) =>
  execFileSync('git', ['-C', targetRoot, ...args], { encoding: 'utf8' }).trim();
const subjectSha = git('rev-parse', 'HEAD');
if (git('status', '--porcelain', '--', ...productionFiles))
  throw new Error('target production files are dirty');
for (const file of productionFiles) {
  const disk = git('hash-object', file);
  const committed = git('rev-parse', `HEAD:${file}`);
  if (disk !== committed)
    throw new Error(`target production hash mismatch: ${file}`);
}
const mod = async (file: string) =>
  import(pathToFileURL(join(targetRoot, file)).href);
const toolMod = async (file: string) =>
  import(pathToFileURL(join(toolRoot, file)).href);
const targetRequire = createRequire(join(targetRoot, 'package.json'));
const { serve } = targetRequire('@hono/node-server');
const { Hono } = targetRequire('hono');
const [
  { createOrchestrationRoutes },
  { configureRuntimeHttp },
  { EventBus },
  { EventStore },
  { OrchestrationService },
  { AsyncEventQueue },
  { StationAgentAdapter },
  { ApprovalRegistry },
  transferScenario,
  transferFixture,
  sdk,
] = await Promise.all([
  mod('src-server/routes/orchestration/orchestration.ts'),
  mod('src-server/runtime/bootstrap/runtime-http.ts'),
  mod('src-server/services/orchestration/event-bus.ts'),
  mod('src-server/services/orchestration/event-store.ts'),
  mod('src-server/services/orchestration/orchestration-service.ts'),
  mod('src-server/providers/sessions/async-event-queue.ts'),
  mod('src-server/providers/adapters/station-agent-adapter.ts'),
  mod('src-server/services/approvals/approval-registry.ts'),
  toolMod('src-server/__test-utils__/orchestration-transfer-scenario.ts'),
  toolMod('src-server/__test-utils__/orchestration-transfer-fixture.ts'),
  mod('packages/sdk/src/client/index.ts'),
]);
const wait = async (predicate: () => boolean, name: string) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`capture barrier timed out: ${name}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
};
const logger = {
  debug() {},
  warn() {},
  error() {},
  info() {},
  trace() {},
  fatal() {},
};
const root = mkdtempSync(join(tmpdir(), 'station-transfer-capture-'));
const store = new EventStore(join(root, 'events.sqlite'));
const bus = new EventBus();
const externalEvents = new AsyncEventQueue();
const externalAdapter = {
  provider: 'claude',
  metadata: {
    displayName: 'capture external engine',
    description: 'deterministic external transfer source',
    capabilities: ['agent-runtime'],
  },
  async startSession(input: any) {
    return {
      provider: 'claude',
      threadId: input.threadId,
      status: 'ready',
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
  },
  async sendTurn(input: any) {
    return { threadId: input.threadId, turnId: 'capture-external' };
  },
  async interruptTurn() {
    return { outcome: 'no-active-turn' as const };
  },
  async respondToRequest() {},
  async stopSession() {},
  async listSessions() {
    return [];
  },
  async hasSession() {
    return false;
  },
  async stopAll() {},
  streamEvents(options?: any) {
    return externalEvents.iterable(options);
  },
};
const nativeBoundary = transferScenario.createStationTransferBoundary();
let nativeTimestamp = 0;
const nativeAdapter = new StationAgentAdapter({
  apiBase: 'http://station-native.test',
  hasAgent: (agentId: string) => agentId === 'transfer-native-agent',
  approvalRegistry: new ApprovalRegistry(logger, { eventBus: bus }),
  eventBus: bus,
  fetch: nativeBoundary.fetch,
  now: () => new Date(Date.UTC(2026, 7, 25, 0, 0, nativeTimestamp++)),
});
const registry = {
  register() {},
  get(provider: string) {
    if (provider === externalAdapter.provider) return externalAdapter;
    if (provider === nativeAdapter.provider) return nativeAdapter;
    return undefined;
  },
  list() {
    return [externalAdapter, nativeAdapter];
  },
};
const service = new OrchestrationService({
  adapterRegistry: registry,
  eventBus: bus,
  eventStore: store,
  logger,
  ownerlessSessionAccess: 'single-user-compat',
});
service.initialize();
const app = new Hono();
configureRuntimeHttp({ app: app as never, logger, eventBus: bus });
app.route(
  '/api/orchestration',
  createOrchestrationRoutes(service, {
    eventBus: bus,
    logger,
    getUserId: () => transferFixture.ORCHESTRATION_TRANSFER_OWNER,
  }),
);
const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await once(listener, 'listening');
const address = listener.address() as { port: number };
const baseUrl = `http://127.0.0.1:${address.port}`;
const budget = JSON.parse(
  readFileSync(
    join(toolRoot, 'scripts/fixtures/orchestration-transfer/budget.json'),
    'utf8',
  ),
).policy;
try {
  const externalRecorder = new HttpTransferRecorder(baseUrl);
  sdk.setClientCredentialResolver(() => ({
    origin: baseUrl,
    transport: externalRecorder.transport,
  }));
  const externalFinalPair = transferFixture.heavyTransferFinalPair();
  const external = await transferScenario.measureOrchestrationTransfer({
    source: {
      scenario: 'external-engine',
      provider: 'claude',
      threadId: transferFixture.ORCHESTRATION_TRANSFER_THREAD_ID,
      heavyTurnId: () => 'transfer-heavy-turn',
      finalToolOutput: () => externalFinalPair[1].output,
      finalReplayEventCount: 3,
      heavyLiveFrameCount: 42,
      async seedRetained() {
        for (const event of transferFixture.retainedTransferEvents())
          externalEvents.push(event);
        await wait(
          () =>
            store.listEvents(transferFixture.ORCHESTRATION_TRANSFER_THREAD_ID)
              .length === transferFixture.retainedTransferEvents().length,
          'external retained',
        );
      },
      async startHeavyPrefix() {
        for (const event of transferFixture.heavyTransferPrefix())
          externalEvents.push(event);
        await wait(
          () =>
            store.listEvents(transferFixture.ORCHESTRATION_TRANSFER_THREAD_ID)
              .length ===
            transferFixture.retainedTransferEvents().length +
              transferFixture.heavyTransferPrefix().length,
          'external prefix',
        );
      },
      async finishHeavyTurn() {
        for (const event of externalFinalPair) externalEvents.push(event);
        await wait(
          () =>
            store
              .listEvents(transferFixture.ORCHESTRATION_TRANSFER_THREAD_ID)
              .some(
                (stored: any) =>
                  stored.payload?.eventId === externalFinalPair[2].eventId,
              ),
          'external final',
        );
      },
    },
    baseUrl,
    store,
    service,
    recorder: externalRecorder,
    sdk,
    budget,
  });

  const nativeThreadId = 'transfer-budget-station-agent-thread';
  let nativeHeavyTurnId: string | undefined;
  const nativeRecorder = new HttpTransferRecorder(baseUrl);
  sdk.setClientCredentialResolver(() => ({
    origin: baseUrl,
    transport: nativeRecorder.transport,
  }));
  const native = await transferScenario.measureOrchestrationTransfer({
    source: {
      scenario: 'station-native',
      provider: 'station-agent',
      threadId: nativeThreadId,
      heavyTurnId: () => {
        if (!nativeHeavyTurnId) throw new Error('native heavy turn missing');
        return nativeHeavyTurnId;
      },
      finalToolOutput: () => transferFixture.heavyTransferFinalPair()[1].output,
      finalReplayEventCount: 4,
      heavyLiveFrameCount: 44,
      async seedRetained() {
        await nativeAdapter.startSession({
          threadId: nativeThreadId,
          provider: 'station-agent',
          metadata: {
            agentId: 'transfer-native-agent',
            userId: transferFixture.ORCHESTRATION_TRANSFER_OWNER,
          },
        });
        for (const [index, turn] of transferScenario
          .groupTransferEventsByTurn(transferFixture.retainedTransferEvents())
          .entries()) {
          nativeBoundary.queueComplete(turn);
          await nativeAdapter.sendTurn({
            threadId: nativeThreadId,
            input: `Run retained transfer turn ${index}.`,
            modelId: 'fixture-model',
          });
          await wait(
            () =>
              store
                .listEvents(nativeThreadId)
                .filter(
                  (stored: any) => stored.payload?.method === 'turn.completed',
                ).length ===
              index + 1,
            `native retained ${index}`,
          );
        }
      },
      async startHeavyPrefix() {
        nativeBoundary.queuePaused(
          transferFixture.heavyTransferPrefix(),
          transferFixture.heavyTransferFinalPair(),
        );
        const turn = await nativeAdapter.sendTurn({
          threadId: nativeThreadId,
          input: 'Run the bounded native transfer fixture.',
          modelId: 'fixture-model',
        });
        nativeHeavyTurnId = turn.turnId;
        await wait(
          () =>
            store
              .listEvents(nativeThreadId)
              .filter(
                (stored: any) =>
                  stored.payload?.turnId === nativeHeavyTurnId &&
                  stored.payload?.method === 'tool.completed',
              ).length === 19,
          'native prefix',
        );
      },
      async finishHeavyTurn() {
        nativeBoundary.releaseFinal();
        await wait(
          () =>
            store
              .listEvents(nativeThreadId)
              .some(
                (stored: any) =>
                  stored.payload?.turnId === nativeHeavyTurnId &&
                  stored.payload?.method === 'turn.completed',
              ),
          'native final',
        );
      },
    },
    baseUrl,
    store,
    service,
    recorder: nativeRecorder,
    sdk,
    budget,
  });
  const toolDigest = createHash('sha256')
    .update(
      [
        'scripts/orchestration-transfer-capture.ts',
        'src-server/__test-utils__/orchestration-transfer-scenario.ts',
        'src-server/__test-utils__/http-transfer-recorder.ts',
        'src-server/__test-utils__/orchestration-transfer-fixture.ts',
        'scripts/orchestration-transfer-budget.mjs',
      ]
        .map((file) => readFileSync(join(toolRoot, file)))
        .join('\n'),
    )
    .digest('hex');
  const report = {
    schemaVersion: 1,
    subjectSha,
    baseSha: baseSha ?? subjectSha,
    dirty: false,
    fixtureDigest: transferFixture.transferFixtureDigest(),
    toolDigest,
    phases: [...external.phases, ...native.phases],
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  writeFileSync(outputPath, `${JSON.stringify(report)}\n`);
  console.log(JSON.stringify(report));
} finally {
  sdk.setClientCredentialResolver();
  listener.closeAllConnections?.();
  await new Promise<void>((resolveClose) =>
    listener.close(() => resolveClose()),
  );
  await service.shutdown();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
