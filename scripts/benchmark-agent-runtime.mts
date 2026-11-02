import { mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { z } from 'zod';
import { FileMemoryAdapter } from '../src-server/adapters/file/memory-adapter.js';
import { stationAgentRuntimeOwner } from '../src-server/runtime/agents/durable-agent-owner.js';
import { VoltAgentFramework } from '../src-server/runtime/frameworks/voltagent-adapter.js';

const args = process.argv.slice(2);
const revision = args[0];
const output = args[1];
if (!revision || !output)
  throw new Error(
    'usage: npm run bench:agent-runtime -- <revision> <output.json>',
  );
const watchdog = setTimeout(() => {
  throw new Error('Agent runtime benchmark exceeded fifteen minutes');
}, 900_000);
watchdog.unref();
const sizes = (
  args.find((a) => a.startsWith('--sizes='))?.slice(8) ?? '10,40,80,200'
)
  .split(',')
  .map(Number);
const chunkCounts = (
  args.find((a) => a.startsWith('--chunks='))?.slice(9) ?? '100,200,400'
)
  .split(',')
  .map(Number);
if (
  sizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 200) ||
  chunkCounts.some((n) => !Number.isSafeInteger(n) || n < 100 || n > 400)
)
  throw new Error('Invalid bounded workload');
async function run(
  durable: boolean,
  steps: number,
  chunks: number,
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
      if (calls > steps) throw new Error('Unexpected benchmark model call');
      const tool = calls < steps;
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'answer' },
        ...Array.from({ length: chunks }, (_, index) => ({
          type: 'text-delta' as const,
          id: 'answer',
          delta: !tool && index === chunks - 1 ? 'DONE' : 'word ',
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
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
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
  const execute = owner.journal.execute.bind(owner.journal);
  owner.journal.execute = async (command, context) => {
    const start = performance.now();
    try {
      return await execute(command, context);
    } finally {
      commits.push(performance.now() - start);
    }
  };
  const inspector = profile ? new Session() : undefined;
  inspector?.connect();
  if (inspector) {
    await inspector.post('Profiler.enable');
    await inspector.post('Profiler.start');
  }
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const elu = performance.eventLoopUtilization();
  const started = performance.now();
  let text = '';
  try {
    const response = await agent.streamText('Run the bounded workload.', {
      userId: 'owner',
      conversationId: 'conversation',
      clientTurnId: 'turn',
    });
    for await (const chunk of response.fullStream) {
      if (chunk.type === 'error') throw new Error('Benchmark framework error');
    }
    const answer = await response.text;
    if (answer === undefined)
      throw new Error('Benchmark framework returned no text result');
    text = answer;
    await response.usage;
    await response.finishReason;
  } finally {
    delay.disable();
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
  await owner.pause();
  if (
    calls !== steps ||
    tools !== steps - 1 ||
    !text.endsWith('DONE') ||
    failures.length ||
    (durable && terminal !== 'completed')
  )
    throw new Error(
      `Benchmark did not complete: ${JSON.stringify({ calls, tools, text, terminal, failures })}`,
    );
  const sorted = commits.sort((a, b) => a - b);
  const percentile = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? null;
  return {
    durable,
    steps,
    chunks,
    profile,
    milliseconds,
    modelCalls: calls,
    toolCalls: tools,
    operations: sorted.length,
    journalMs: { p50: percentile(0.5), p99: percentile(0.99) },
    eventLoopDelayMs: {
      p50: delay.percentile(50) / 1e6,
      p99: delay.percentile(99) / 1e6,
      max: delay.max / 1e6,
    },
    utilization,
  };
}
const environment = {
  node: process.version,
  platform: platform(),
  release: release(),
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  sqlite: 'WAL synchronous=FULL',
  measuredAt: new Date().toISOString(),
};
const results = [];
for (const steps of sizes)
  for (const chunks of chunkCounts) {
    const baseline = await run(false, steps, chunks);
    const durable = await run(true, steps, chunks);
    results.push({
      steps,
      chunks,
      baseline,
      durable,
      ratio: durable.milliseconds / baseline.milliseconds,
    });
    writeFileSync(
      output,
      JSON.stringify(
        {
          revision,
          environment,
          scope:
            'actual Station VoltAgent adapter; scripted zero-network provider; FileMemory; fresh conversation; excludes HTTP/event projection',
          results,
        },
        null,
        2,
      ),
    );
  }
if (args.includes('--profile'))
  await run(true, sizes.at(-1)!, chunkCounts.at(-1)!, true);
clearTimeout(watchdog);
