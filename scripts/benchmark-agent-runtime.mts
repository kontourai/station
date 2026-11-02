import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempDisposableSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { Session } from 'node:inspector/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  monitorEventLoopDelay,
  PerformanceObserver,
  performance,
} from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as tokenDelay } from 'node:timers/promises';
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { AgentRegistry, createVoltAgentObservability } from '@voltagent/core';
import { Hono } from 'hono';
import { z } from 'zod';
import { createChatRuntimeFixture } from '../src-server/__test-utils__/chat-runtime-fixture.js';
import { FileMemoryAdapter } from '../src-server/adapters/file/memory-adapter.js';
import { streamPrimaryAgentChat } from '../src-server/routes/chat/chat-primary-stream.js';
import { stationAgentRuntimeOwner } from '../src-server/runtime/agents/durable-agent-owner.js';
import { VoltAgentFramework } from '../src-server/runtime/frameworks/voltagent-adapter.js';
import { captureRuntimeConfigurationLease } from '../src-server/runtime/plugins/runtime-configuration-lease.js';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';

const args = process.argv.slice(2);
const revision = args[0];
const output = args[1];
if (!revision || !output)
  throw new Error(
    'usage: npm run bench:agent-runtime -- <revision> <output.json>',
  );
if (
  execFileSyncBounded('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim() !== revision ||
  execFileSyncBounded('git', ['status', '--porcelain'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
)
  throw new Error('Benchmark requires the named committed clean revision');

const sizes = (
  args.find((a) => a.startsWith('--sizes='))?.slice(8) ?? '10,80,200'
)
  .split(',')
  .map(Number);
const chunkCounts = (
  args.find((a) => a.startsWith('--chunks='))?.slice(9) ?? '100,400'
)
  .split(',')
  .map(Number);
const phase = args.find((a) => a.startsWith('--phase='))?.slice(8) ?? 'pair';
if (!['pair', 'baseline', 'durable'].includes(phase))
  throw new Error('Invalid benchmark phase');
const pacing = (
  args.find((a) => a.startsWith('--paces='))?.slice(8) ?? '0,5,20'
)
  .split(',')
  .map(Number);
if (
  pacing.some((n) => ![0, 5, 20].includes(n)) ||
  sizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 200) ||
  chunkCounts.some((n) => !Number.isSafeInteger(n) || n < 100 || n > 400)
)
  throw new Error('Invalid bounded workload');
const deltaBytes = Number(
  args.find((a) => a.startsWith('--delta-bytes='))?.slice(14) ?? 64,
);
if (!Number.isSafeInteger(deltaBytes) || deltaBytes < 4 || deltaBytes > 1024)
  throw new Error('Invalid delta byte size');
const budgetMs =
  900_000 +
  2 *
    sizes.reduce((a, b) => a + b, 0) *
    chunkCounts.reduce((a, b) => a + b, 0) *
    pacing.reduce((a, b) => a + b, 0);
const watchdog = setTimeout(() => {
  throw new Error(`Agent runtime benchmark exceeded ${budgetMs}ms`);
}, budgetMs);
watchdog.unref();
function diskBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  return stat.isDirectory()
    ? readdirSync(path).reduce(
        (n, child) => n + diskBytes(join(path, child)),
        0,
      )
    : stat.size;
}
async function run(
  durable: boolean,
  steps: number,
  chunks: number,
  paceMs: number,
  profile = false,
) {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'agent-runtime-benchmark-'));
  const storage = new FileMemoryAdapter({ projectHomeDir: dir.path });
  await storage.createConversation({
    id: 'conversation',
    userId: 'owner',
    resourceId: 'assistant',
    title: 'Benchmark',
    metadata: {},
  });
  const owner = stationAgentRuntimeOwner(dir.path);
  let paused = false;
  await observability.forceFlush();
  await observability.getStorage().clear();
  try {
    const failures: unknown[] = [];
    owner.configure({
      preview: {
        select: (branches) =>
          durable ? branches.enabled() : branches.disabled(),
      },
      failed: (error) => failures.push(error),
    });
    let calls = 0;
    let tools = 0;
    let textBytes = 0;
    const expectedText = createHash('sha256');
    let walPeakBytes = 0;
    const journalPath = join(dir.path, 'data/agent-runtime/steps.sqlite');
    const model: LanguageModelV3 = {
      specificationVersion: 'v3',
      provider: 'scripted',
      modelId: 'benchmark',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('stream required');
      },
      doStream: async () => {
        calls++;
        if (paceMs)
          process.stdout.write(
            `@agent-runtime-progress@${JSON.stringify({ durable, steps, chunks, paceMs, model: calls })}\n`,
          );
        if (calls > steps) throw new Error('Unexpected benchmark model call');
        const tool = calls < steps;
        const parts: LanguageModelV3StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'answer' },
          ...Array.from({ length: chunks }, (_, index) => ({
            type: 'text-delta' as const,
            id: 'answer',
            delta:
              !tool && index === chunks - 1
                ? 'DONE'
                : deltaBytes === 4
                  ? createHash('sha256')
                      .update(`${calls}:${index}`)
                      .digest('base64url')
                      .slice(0, 4)
                  : `step${calls}.chunk${index}: streaming runtime durability evidence `
                      .padEnd(deltaBytes, 'text ')
                      .slice(0, deltaBytes),
          })),
          { type: 'text-end', id: 'answer' },
          ...(tool
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: `call-${calls}`,
                  toolName: 'probe',
                  input: '{}',
                },
              ]
            : []),
          {
            type: 'finish',
            finishReason: {
              unified: tool ? 'tool-calls' : 'stop',
              raw: tool ? 'tool_calls' : 'stop',
            },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ];
        let index = 0;
        return {
          stream: new ReadableStream({
            async pull(controller) {
              const part = parts[index++]!;
              if (part.type === 'text-delta') {
                if (paceMs) await tokenDelay(paceMs);
                textBytes += Buffer.byteLength(part.delta);
                expectedText.update(part.delta);
              }
              controller.enqueue(part);
              if (index === parts.length) controller.close();
            },
          }),
        };
      },
    };
    const agent = await new VoltAgentFramework().createTempAgent({
      agentId: 'assistant',
      name: 'Benchmark',
      instructions: 'Use probe, then answer.',
      model,
      maxSteps: steps + 1,
      memoryAdapter: storage,
      durable: { home: dir.path, slug: 'assistant', definition: 'benchmark/1' },
      tools: [
        {
          name: 'probe',
          description: 'Probe',
          parameters: z.object({}),
          replay: 'safe',
          execute: async () => {
            tools++;
            return 'RESULT';
          },
        },
      ],
      hooks: { beforeToolCall: async () => true },
    });
    const commits: number[] = [];
    const projections: number[] = [];
    const execute = owner.journal.execute.bind(owner.journal);
    owner.journal.execute = async (command, context) => {
      const start = performance.now();
      try {
        return await execute(command, context);
      } finally {
        const elapsed = performance.now() - start;
        commits.push(elapsed);
        if (
          command.type === 'projectFrame' ||
          command.type === 'projectFrameBatch'
        ) {
          const frames =
            command.type === 'projectFrame' ? 1 : command.frames.length;
          for (let index = 0; index < frames; index++)
            projections.push(elapsed / frames);
        }
        if (commits.length % 256 === 0)
          walPeakBytes = Math.max(
            walPeakBytes,
            diskBytes(`${journalPath}-wal`),
          );
      }
    };
    const runtime = createChatRuntimeFixture(dir.path, storage);
    const app = new Hono();
    app.post('/chat', (c) =>
      streamPrimaryAgentChat({
        c,
        ctx: runtime,
        slug: 'assistant',
        plugin: '',
        input: 'Run the bounded workload.',
        restOptions: {
          userId: 'owner',
          conversationId: 'conversation',
          clientTurnId: 'turn',
        },
        injectContext: null,
        ragContext: null,
        agent,
        configurationLease: captureRuntimeConfigurationLease(runtime)!,
      }),
    );
    const inspector = profile ? new Session() : undefined;
    inspector?.connect();
    if (inspector) {
      await inspector.post('Profiler.enable');
      await inspector.post('Profiler.start');
    }
    if (typeof global.gc !== 'function')
      throw new Error('Benchmark requires --expose-gc');
    global.gc();
    const collections: number[] = [];
    const gc = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) collections.push(entry.duration);
    });
    gc.observe({ entryTypes: ['gc'] });
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const elu = performance.eventLoopUtilization();
    const started = performance.now();
    let text = '';
    let observedTextBytes = 0;
    const receivedText = createHash('sha256');
    try {
      const response = await app.request('/chat', { method: 'POST' });
      if (response.status !== 200)
        throw new Error(`Chat route status ${response.status}`);
      if (!response.body) throw new Error('Missing route body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let done = false;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary = pending.indexOf('\n');
        while (boundary >= 0) {
          const line = pending.slice(0, boundary);
          pending = pending.slice(boundary + 1);
          if (line === 'data: [DONE]') done = true;
          else if (line.startsWith('data: {')) {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'error')
              throw new Error('Benchmark route error');
            if (event.type === 'text-delta') {
              const value = event.text ?? event.delta ?? '';
              receivedText.update(value);
              observedTextBytes += Buffer.byteLength(value);
              text = (text + value).slice(-128);
            }
          }
          boundary = pending.indexOf('\n');
        }
      }
      if (!done) throw new Error('Missing route terminal');
    } finally {
      delay.disable();
      collections.push(...gc.takeRecords().map((entry) => entry.duration));
      gc.disconnect();
      if (inspector) {
        const result = await inspector.post('Profiler.stop');
        writeFileSync(`${output}.cpuprofile`, JSON.stringify(result.profile));
        inspector.disconnect();
      }
    }
    const milliseconds = performance.now() - started;
    const utilization = performance.eventLoopUtilization(elu).utilization;
    const terminal = durable
      ? owner.read('conversation', 'turn')?.turn.state
      : undefined;
    walPeakBytes = Math.max(walPeakBytes, diskBytes(`${journalPath}-wal`));
    paused = true;
    await owner.pause();
    const journalBytes = diskBytes(journalPath);
    let bodiesBytes = 0;
    let bodyChunkBytes = 0;
    let framesBytes = 0;
    let frames = 0;
    let tables: Array<{
      name: string;
      bytes: number;
      payloadBytes: number;
      rows: number;
    }> = [];
    if (journalBytes) {
      const database = new DatabaseSync(journalPath, { readOnly: true });
      try {
        bodiesBytes = Number(
          database
            .prepare(
              'SELECT coalesce(sum(length(CAST(wire AS BLOB))),0) AS n FROM agent_steps_bodies',
            )
            .get()?.n,
        );
        bodyChunkBytes = Number(
          database
            .prepare(
              'SELECT coalesce(sum(length(CAST(wire AS BLOB))),0) AS n FROM agent_steps_body_chunks',
            )
            .get()?.n,
        );
        bodiesBytes += bodyChunkBytes;
        const blocks = database
          .prepare(
            'SELECT coalesce(sum(last_position-position+1),0) AS n,coalesce(sum(length(CAST(record AS BLOB))),0) AS bytes FROM agent_steps_frame_blocks',
          )
          .get();
        const projected = database
          .prepare(
            'SELECT count(*) AS n,coalesce(sum(length(CAST(record AS BLOB))),0) AS bytes FROM agent_steps_frames',
          )
          .get();
        frames = Number(projected?.n) + Number(blocks?.n);
        framesBytes = Number(projected?.bytes) + Number(blocks?.bytes);
        tables = database
          .prepare(
            'SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name',
          )
          .all()
          .map((row) => ({
            name: String(row.name),
            bytes: Number(row.bytes),
            payloadBytes: 0,
            rows: 0,
          }));
        for (const table of tables) {
          if (!/^agent_steps_[a-z_]+$/.test(table.name)) continue;
          const columns = database
            .prepare(`PRAGMA table_info(${table.name})`)
            .all();
          if (!columns.length) continue;
          const values = columns
            .map(
              (column) =>
                `coalesce(length(CAST(${String(column.name)} AS BLOB)),0)`,
            )
            .join('+');
          const details = database
            .prepare(
              `SELECT count(*) AS n,coalesce(sum(${values}),0) AS payload FROM ${table.name}`,
            )
            .get();
          table.rows = Number(details?.n);
          table.payloadBytes = Number(details?.payload);
        }
      } finally {
        database.close();
      }
    }
    const onDiskBytes = diskBytes(dir.path);
    const journalBudgetBytes = 128 * 1024 + steps * 16 * 1024 + 3 * textBytes;
    const bodyBudgetBytes = steps * 8 * 1024 + 2 * textBytes;
    if (
      durable &&
      (onDiskBytes > journalBudgetBytes || bodiesBytes > bodyBudgetBytes)
    ) {
      writeFileSync(
        `${output}.failure.json`,
        JSON.stringify(
          {
            revision,
            steps,
            chunks,
            paceMs,
            deltaBytes,
            storage: {
              onDiskBytes,
              journalBytes,
              bodiesBytes,
              framesBytes,
              textBytes,
              tables,
              journalBudgetBytes,
              bodyBudgetBytes,
            },
          },
          null,
          2,
        ),
      );
      throw new Error(
        `Benchmark storage budget exceeded: ${JSON.stringify({ onDiskBytes, journalBytes, journalBudgetBytes, bodiesBytes, bodyBudgetBytes })}`,
      );
    }
    if (
      calls !== steps ||
      tools !== steps - 1 ||
      !text.endsWith('DONE') ||
      observedTextBytes !== textBytes ||
      expectedText.digest('hex') !== receivedText.digest('hex') ||
      (durable && projections.length < steps * chunks) ||
      failures.length ||
      (durable && terminal !== 'completed')
    )
      throw new Error(
        `Benchmark did not complete: ${JSON.stringify({ calls, tools, text: text.slice(-128), observedTextBytes, textBytes, terminal, failures })}`,
      );
    const traceCount = (await observability.getStorage().listTraces(10_000))
      .length;
    if (traceCount < 1)
      throw new Error('Benchmark observability is not active');
    const sorted = commits.sort((a, b) => a - b);
    const percentile = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ??
      null;
    return {
      durable,
      steps,
      chunks,
      deltaBytes,
      paceMs,
      profile,
      milliseconds,
      modelCalls: calls,
      toolCalls: tools,
      operations: sorted.length,
      journalMs: { p50: percentile(0.5), p99: percentile(0.99) },
      projectionMs: {
        p50:
          projections.sort((a, b) => a - b)[
            Math.floor(projections.length * 0.5)
          ] ?? null,
        p99: projections[Math.floor(projections.length * 0.99)] ?? null,
      },
      storage: {
        textBytes,
        tables,
        fixedBytesPerStep:
          Math.max(0, journalBytes - 3 * textBytes - 128 * 1024) / steps,
        onDiskBytes,
        journalBytes,
        bodiesBytes,
        bodyChunkBytes,
        framesBytes,
        frames,
        walPeakBytes,
        ratio: onDiskBytes / textBytes,
        journalRatio: journalBytes / textBytes,
        journalBudgetBytes,
        bodyBudgetBytes,
      },
      eventLoopDelayMs: {
        p50: delay.percentile(50) / 1e6,
        p99: delay.percentile(99) / 1e6,
        max: delay.max / 1e6,
      },
      utilization,
      gc: {
        count: collections.length,
        maxMs: Math.max(0, ...collections),
        totalMs: collections.reduce((n, ms) => n + ms, 0),
      },
      rss: process.memoryUsage().rss,
      traceCount,
    };
  } finally {
    if (!paused) await owner.pause();
  }
}
const environment = {
  node: process.version,
  platform: platform(),
  release: release(),
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  sqlite: 'WAL synchronous=FULL',
  measuredAt: new Date().toISOString(),
  fixture:
    'one live SDK tracer provider; trace storage cleared and GC requested between isolated phase fixtures; automatic GC remains included inside each measured phase',
};
const observability = createVoltAgentObservability({
  serviceName: 'agent-runtime-benchmark',
});
AgentRegistry.getInstance().setGlobalObservability(observability);
const results = [];
try {
  for (const steps of sizes)
    for (const chunks of chunkCounts)
      for (const paceMs of pacing) {
        const baseline =
          phase === 'durable'
            ? undefined
            : await run(false, steps, chunks, paceMs);
        const durable =
          phase === 'baseline'
            ? undefined
            : await run(true, steps, chunks, paceMs);
        results.push({
          steps,
          chunks,
          paceMs,
          baseline,
          durable,
          ratio:
            baseline && durable
              ? durable.milliseconds / baseline.milliseconds
              : null,
        });
        writeFileSync(
          output,
          JSON.stringify(
            {
              revision,
              environment,
              phase,
              scope:
                'actual Station VoltAgent adapter and in-process Hono chat/SSE route including projectFrame; scripted paced provider; FileMemory; fresh conversation; excludes TCP and the outer EventStore relay',
              results,
            },
            null,
            2,
          ),
        );
        process.stdout.write(
          `${JSON.stringify({
            steps,
            chunks,
            paceMs,
            ratio:
              baseline && durable
                ? durable.milliseconds / baseline.milliseconds
                : null,
            storageRatio: durable?.storage.ratio,
            p99: durable?.eventLoopDelayMs.p99,
          })}\n`,
        );
      }
  if (args.includes('--profile'))
    await run(true, sizes.at(-1)!, chunkCounts.at(-1)!, 0, true);
} finally {
  await observability.shutdown();
  clearTimeout(watchdog);
}
