import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type {
  OnEndHookArgs,
  OnStartHookArgs,
  OnStepFinishHookArgs,
  StreamTextFinishResult,
  VoltAgentTextStreamPart,
} from '@voltagent/core';

type ObservabilityConfig = NonNullable<
  ConstructorParameters<
    typeof import('@voltagent/core').VoltAgentObservability
  >[0]
>;
type SpanProcessor = NonNullable<ObservabilityConfig['spanProcessors']>[number];
type ReadableSpan = Parameters<SpanProcessor['onEnd']>[0];

const require = createRequire(import.meta.url);
const [format, mode] = process.argv.slice(2);
assert.ok(format === 'cjs' || format === 'esm', 'FLUSH_KEEPER_FORMAT');
assert.ok(
  mode === 'always-fulfill' ||
    mode === 'always-reject' ||
    mode === 'auto' ||
    mode === 'never',
  'FLUSH_KEEPER_MODE',
);
const enabled = mode.startsWith('always-');
const agentId = `flush-keeper-${format}-${mode}`;
const agentName = `Flush keeper ${format} ${mode}`;
const events: string[] = [];
const failures: string[] = [];
const unexpected: unknown[] = [];
const starts: OnStartHookArgs[] = [];
const steps: OnStepFinishHookArgs[] = [];
const ends: OnEndHookArgs[] = [];
const finishes: StreamTextFinishResult[] = [];
const streamEvents: VoltAgentTextStreamPart[] = [];
const rootStarts: string[] = [];
const rootEnds: ReadableSpan[] = [];
const flushTasks: Promise<void>[] = [];
const flushErrors: unknown[] = [];
let flushCalls = 0;
let flushSettled = 0;
let processorShutdowns = 0;
let released = false;
let consumerState: 'pending' | 'eof' | 'rejected' = 'pending';
let text = '';
let heldCheckpoint: Record<string, unknown> | undefined;
let release!: () => void;
let entered!: () => void;
const hold = new Promise<void>((resolveHold) => {
  release = () => {
    released = true;
    resolveHold();
  };
});
const flushEntered = new Promise<void>((resolveEntered) => {
  entered = resolveEntered;
});
const rejection = new Error('FLUSH_KEEPER_EXPORTER_REJECTION');
const deadline: { error?: Error } = {};
let rejectWatchdog!: (error: Error) => void;
const watchdog = new Promise<never>((_, reject) => {
  rejectWatchdog = reject;
});
void watchdog.catch(() => {});
const timer = setTimeout(() => {
  const error = new Error(
    'FLUSH_KEEPER_WATCHDOG: NOT_PROVEN; not an ordering discriminator',
  );
  deadline.error = error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
  release();
  rejectWatchdog(error);
}, 10_000);
const within = <T,>(task: Promise<T>) => Promise.race([task, watchdog]);
const observe = <T,>(task: Promise<T>) =>
  task.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
function recordFailure(error: unknown) {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  failures.push(detail);
  process.stderr.write(`${detail}\n`);
}
const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
const summarizeUsage = (value: StreamTextFinishResult['usage']) => ({
  inputTokens: value?.inputTokens,
  outputTokens: value?.outputTokens,
  totalTokens: value?.totalTokens,
});
const cleanup = {
  acquisition: 'absent',
  consumer: 'absent',
  processor: [] as string[],
  shutdown: false,
  storage: false,
  processorShutdowns: 0,
};
let storage:
  | InstanceType<typeof import('@voltagent/core').InMemoryObservabilityAdapter>
  | undefined;
let observability:
  | InstanceType<typeof import('@voltagent/core').VoltAgentObservability>
  | undefined;
let acquisition: ReturnType<typeof observe<void>> | undefined;
let consumption: ReturnType<typeof observe<void>> | undefined;
let model:
  | InstanceType<typeof import('ai/test').MockLanguageModelV3>
  | undefined;
let versions: { core: string; ai: string } | undefined;
let entries: Record<string, { path: string; sha256: string }> | undefined;

function assertDataComplete() {
  assert.equal(text, 'FLUSH_KEEPER', 'FLUSH_KEEPER_TEXT');
  const finishEvents = streamEvents.filter((event) => event.type === 'finish');
  assert.equal(finishEvents.length, 1, 'FLUSH_KEEPER_FINISH_COUNT');
  assert.equal(finishEvents[0].finishReason, 'stop');
  assert.equal(finishEvents[0].rawFinishReason, 'stop');
  assert.deepEqual(summarizeUsage(finishEvents[0].totalUsage), usage);
  assert.deepEqual(
    streamEvents
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.text),
    ['FLUSH_KEEPER'],
  );
  assert.deepEqual(
    streamEvents.filter(
      (event) =>
        event.type === 'error' ||
        event.type === 'abort' ||
        event.type === 'input-guardrail-blocked',
    ),
    [],
  );
  assert.equal(starts.length, 1, 'FLUSH_KEEPER_START_CALLBACK');
  assert.equal(steps.length, 1, 'FLUSH_KEEPER_STEP_CALLBACK');
  assert.equal(ends.length, 1, 'FLUSH_KEEPER_END_CALLBACK');
  assert.equal(finishes.length, 1, 'FLUSH_KEEPER_FINISH_CALLBACK');
  assert.equal(starts[0].agent.id, agentId);
  assert.equal(steps[0].agent, starts[0].agent);
  assert.equal(ends[0].agent, starts[0].agent);
  const step: unknown = steps[0].step;
  assert.ok(
    step &&
      typeof step === 'object' &&
      'text' in step &&
      'finishReason' in step,
  );
  assert.equal(step.text, 'FLUSH_KEEPER');
  assert.equal(step.finishReason, 'stop');
  assert.equal(ends[0].error, undefined);
  const output = ends[0].output;
  assert.ok(output && 'text' in output && 'finishReason' in output);
  assert.equal(output.text, 'FLUSH_KEEPER');
  assert.equal(output.finishReason, 'stop');
  assert.equal(finishes[0].text, 'FLUSH_KEEPER');
  assert.equal(finishes[0].finishReason, 'stop');
  assert.deepEqual(summarizeUsage(finishes[0].usage), usage);
  assert.deepEqual(summarizeUsage(finishes[0].totalUsage), usage);
  assert.equal(finishes[0].steps?.length, 1);
  assert.equal(finishes[0].steps?.[0].text, 'FLUSH_KEEPER');
  assert.deepEqual(unexpected, []);
  assert.equal(
    model?.doStreamCalls.length,
    1,
    'FLUSH_KEEPER_NATIVE_STREAM_CALL',
  );
  assert.equal(model?.doGenerateCalls.length, 0, 'FLUSH_KEEPER_NO_GENERATE');
  assert.deepEqual(
    model?.doStreamCalls[0].prompt
      .filter((message) => message.role === 'user')
      .flatMap((message) =>
        message.content.map((part) =>
          part.type === 'text' ? part.text : part.type,
        ),
      ),
    ['reply once'],
    'FLUSH_KEEPER_NATIVE_USER_INPUT',
  );
  assert.equal(rootStarts.length, 1, 'FLUSH_KEEPER_REAL_ROOT_STARTED');
  assert.equal(rootEnds.length, 1, 'FLUSH_KEEPER_REAL_ROOT_ENDED');
  const root = rootEnds[0];
  assert.equal(root.spanContext().spanId, rootStarts[0]);
  assert.equal(root.ended, true);
  assert.equal(root.parentSpanContext, undefined);
  assert.equal(root.attributes['entity.id'], agentId);
  assert.equal(root.attributes['agent.state'], 'completed');
  assert.equal(root.attributes.output, 'FLUSH_KEEPER');
  assert.equal(root.status.code, 1);
  assert.ok(root.endTime[0] > 0);
  assert.ok(events.indexOf('onStart') < events.indexOf('onStepFinish'));
  assert.ok(events.indexOf('onStepFinish') < events.indexOf('onEnd'));
  assert.ok(events.indexOf('onEnd') < events.indexOf('userOnFinish'));
}

try {
  const core: typeof import('@voltagent/core') =
    format === 'cjs'
      ? require('@voltagent/core')
      : await within(import('@voltagent/core'));
  const testModels: typeof import('ai/test') =
    format === 'cjs' ? require('ai/test') : await within(import('ai/test'));
  const entryPath = (specifier: string) =>
    format === 'cjs'
      ? require.resolve(specifier)
      : fileURLToPath(import.meta.resolve(specifier));
  const corePath = entryPath('@voltagent/core');
  const aiPath = entryPath('ai');
  const aiTestPath = entryPath('ai/test');
  function packageVersion(path: string): string {
    const metadata: unknown = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(
      metadata &&
        typeof metadata === 'object' &&
        'version' in metadata &&
        typeof metadata.version === 'string',
    );
    return metadata.version;
  }
  versions = {
    core: packageVersion(resolve(dirname(corePath), '../package.json')),
    ai: packageVersion(resolve(dirname(aiPath), '../package.json')),
  };
  assert.deepEqual(
    versions,
    { core: '2.11.0', ai: '6.0.317' },
    'FLUSH_KEEPER_INSTALLED_VERSIONS',
  );
  entries = Object.fromEntries(
    Object.entries({ core: corePath, ai: aiPath, aiTest: aiTestPath }).map(
      ([name, path]) => {
        assert.equal(
          basename(path),
          format === 'cjs' ? 'index.js' : 'index.mjs',
          'FLUSH_KEEPER_NATIVE_EXPORT_BRANCH',
        );
        return [
          name,
          {
            path,
            sha256: createHash('sha256')
              .update(readFileSync(path))
              .digest('hex'),
          },
        ];
      },
    ),
  );
  const integrations: unknown = Reflect.get(
    globalThis,
    'AI_SDK_TELEMETRY_INTEGRATIONS',
  );
  assert.ok(
    integrations === undefined ||
      (Array.isArray(integrations) && integrations.length === 0),
    'FLUSH_KEEPER_AMBIENT_AI_INTEGRATION',
  );
  const otel: unknown = Reflect.get(
    globalThis,
    Symbol.for('opentelemetry.js.api.1'),
  );
  if (otel && typeof otel === 'object') {
    for (const key of ['trace', 'context', 'propagation']) {
      assert.equal(
        Reflect.get(otel, key),
        undefined,
        'FLUSH_KEEPER_AMBIENT_OTEL_PROVIDER',
      );
    }
  }
  const registry = core.AgentRegistry.getInstance();
  assert.equal(
    registry.getGlobalObservability(),
    undefined,
    'FLUSH_KEEPER_PRISTINE_REGISTRY',
  );
  const processor: SpanProcessor = {
    onStart(span) {
      if (span.name === agentName && span.attributes['entity.id'] === agentId) {
        rootStarts.push(span.spanContext().spanId);
        events.push('root-start');
      }
    },
    onEnd(span) {
      if (span.name === agentName && span.attributes['entity.id'] === agentId) {
        rootEnds.push(span);
        events.push('root-end');
      }
    },
    forceFlush() {
      flushCalls++;
      events.push('flush-enter');
      entered();
      const task = (async () => {
        await hold;
        if (mode === 'always-reject') throw rejection;
      })();
      flushTasks.push(task);
      void task.then(
        () => {
          flushSettled++;
          events.push('flush-exit');
        },
        (error: unknown) => {
          flushSettled++;
          flushErrors.push(error);
          events.push('flush-rejected');
        },
      );
      return task;
    },
    async shutdown() {
      processorShutdowns++;
      events.push('processor-shutdown');
    },
  };
  storage = new core.InMemoryObservabilityAdapter({ cleanupIntervalMs: 0 });
  observability = new core.VoltAgentObservability({
    storage,
    flushOnFinishStrategy:
      mode === 'auto' ? 'auto' : mode === 'never' ? 'never' : 'always',
    voltOpsSync: { sampling: { strategy: 'never' } },
    spanFilters: { enabled: false },
    spanProcessors: [processor],
  });
  registry.setGlobalObservability(observability);
  assert.equal(registry.getGlobalObservability(), observability);
  model = new testModels.MockLanguageModelV3({
    doStream: {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 'answer' });
          controller.enqueue({
            type: 'text-delta',
            id: 'answer',
            delta: 'FLUSH_KEEPER',
          });
          controller.enqueue({ type: 'text-end', id: 'answer' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    },
  });
  const agent = new core.Agent({
    id: agentId,
    name: agentName,
    instructions: 'Reply once.',
    model,
    memory: false,
    summarization: false,
    workspace: false,
    workspaceSkillsPrompt: false,
    toolRouting: false,
    feedback: false,
    maxSteps: 1,
    maxRetries: 0,
    hooks: {
      onStart(args) {
        starts.push(args);
        events.push('onStart');
      },
      onStepFinish(args) {
        steps.push(args);
        events.push('onStepFinish');
      },
      onEnd(args) {
        ends.push(args);
        events.push('onEnd');
      },
      onError(args) {
        unexpected.push(args);
      },
      onRetry(args) {
        unexpected.push(args);
      },
      onFallback(args) {
        unexpected.push(args);
      },
    },
  });
  assert.equal(registry.getGlobalObservability(), observability);
  acquisition = observe(
    (async () => {
      const result = await agent.streamText('reply once', {
        maxSteps: 1,
        maxRetries: 0,
        onFinish(value: StreamTextFinishResult) {
          finishes.push(value);
          events.push('userOnFinish');
        },
      });
      const stream = result.fullStream;
      consumption = observe(
        (async () => {
          try {
            for await (const event of stream) {
              streamEvents.push(event);
              if (event.type === 'text-delta') text += event.text;
              if (event.type === 'finish') events.push('finish-event');
            }
            consumerState = 'eof';
            events.push('consumer-eof');
          } catch (error) {
            consumerState = 'rejected';
            events.push('consumer-error');
            throw error;
          }
        })(),
      );
    })(),
  );
  const acquired = await within(acquisition);
  assert.equal(acquired.status, 'fulfilled', 'FLUSH_KEEPER_ACQUISITION_FAILED');
  assert.ok(consumption, 'FLUSH_KEEPER_CONSUMER_MISSING');
  if (enabled) {
    const first = await within(
      Promise.race([
        flushEntered.then(() => 'entered' as const),
        consumption.then(() => 'early-consumer' as const),
      ]),
    );
    assert.equal(
      first,
      'entered',
      'FLUSH_KEEPER_MISSING_ENTRY_OR_EARLY_CONSUMER: NOT_PROVEN',
    );
    await within(nextTurn());
    heldCheckpoint = {
      flushCalls,
      flushSettled,
      released,
      consumerState,
      events: [...events],
    };
    assert.equal(registry.getGlobalObservability(), observability);
    assert.equal(flushCalls, 1, 'FLUSH_KEEPER_SINGLE_FLUSH_ENTRY');
    assert.equal(flushSettled, 0, 'FLUSH_KEEPER_PROCESSOR_STILL_HELD');
    assert.equal(released, false);
    assertDataComplete();
    assert.ok(events.indexOf('userOnFinish') < events.indexOf('flush-enter'));
    assert.ok(events.indexOf('root-end') < events.indexOf('flush-enter'));
    assert.equal(
      consumerState,
      'pending',
      'FLUSH_KEEPER_ORDERING_EOF_WHILE_FLUSH_HELD',
    );
    release();
    const outcomes = await within(Promise.allSettled(flushTasks));
    assert.deepEqual(
      outcomes,
      mode === 'always-reject'
        ? [{ status: 'rejected', reason: rejection }]
        : [{ status: 'fulfilled', value: undefined }],
    );
  }
  const consumed = await within(consumption);
  assert.equal(consumed.status, 'fulfilled', 'FLUSH_KEEPER_CONSUMER_FAILED');
  assert.equal(consumerState, 'eof');
  assertDataComplete();
  assert.equal(registry.getGlobalObservability(), observability);
  assert.equal(flushCalls, enabled ? 1 : 0);
  assert.equal(flushSettled, enabled ? 1 : 0);
  assert.deepEqual(flushErrors, mode === 'always-reject' ? [rejection] : []);
  if (enabled) {
    const settled = events.indexOf(
      mode === 'always-reject' ? 'flush-rejected' : 'flush-exit',
    );
    assert.ok(
      settled >= 0 && settled < events.indexOf('consumer-eof'),
      'FLUSH_KEEPER_ORDERING_FLUSH_SETTLED_BEFORE_EOF',
    );
  }
} catch (error) {
  recordFailure(error);
} finally {
  release();
  try {
    if (acquisition) {
      const result = await acquisition;
      cleanup.acquisition = result.status;
      if (result.status === 'rejected') recordFailure(result.reason);
    }
    if (consumption) {
      const result = await consumption;
      cleanup.consumer = result.status;
      if (result.status === 'rejected') recordFailure(result.reason);
    }
    const outcomes = await Promise.allSettled(flushTasks);
    cleanup.processor = outcomes.map((outcome) => outcome.status);
    for (const outcome of outcomes) {
      if (
        outcome.status === 'rejected' &&
        !(mode === 'always-reject' && outcome.reason === rejection)
      )
        recordFailure(outcome.reason);
    }
  } finally {
    try {
      if (observability) {
        await observability.shutdown();
        cleanup.shutdown = true;
        assert.equal(processorShutdowns, 1, 'FLUSH_KEEPER_PROCESSOR_SHUTDOWN');
      }
    } catch (error) {
      recordFailure(error);
    } finally {
      try {
        storage?.destroy();
        cleanup.storage = storage !== undefined;
      } catch (error) {
        recordFailure(error);
      } finally {
        cleanup.processorShutdowns = processorShutdowns;
        clearTimeout(timer);
      }
    }
  }
}
const deadlineFailure = deadline.error;
if (
  deadlineFailure &&
  !failures.some((failure) => failure.includes(deadlineFailure.message))
)
  recordFailure(deadlineFailure);
process.stdout.write(
  `${JSON.stringify({
    schema: 'volt-stream-finish-flush/1',
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    format,
    mode,
    versions,
    entries,
    text,
    finishReason: finishes[0]?.finishReason,
    usage: summarizeUsage(finishes[0]?.usage),
    callbacks: {
      start: starts.length,
      step: steps.length,
      end: ends.length,
      finish: finishes.length,
    },
    nativeCalls: {
      stream: model?.doStreamCalls.length,
      generate: model?.doGenerateCalls.length,
    },
    root: {
      ended: rootEnds[0]?.ended,
      state: rootEnds[0]?.attributes['agent.state'],
    },
    forceFlush: {
      calls: flushCalls,
      settled: flushSettled,
      rejected: flushErrors.length,
    },
    consumer: consumerState,
    heldCheckpoint,
    events,
    cleanup,
    failures,
  })}\n`,
);
if (failures.length > 0) process.exitCode = 1;
