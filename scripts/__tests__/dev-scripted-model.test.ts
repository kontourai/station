import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { OllamaAdapter } from '../../src-server/providers/adapters/ollama-adapter.js';
import {
  SCRIPTED_MODEL_SCENARIOS,
  startScriptedModelServer,
} from '../dev-scripted-model.mjs';

/**
 * The dev scripted model (scripts/dev-scripted-model.mjs) is only useful if
 * Station's REAL Ollama adapter, over real HTTP and the real ai-sdk
 * OpenAI-compatible plumbing, turns each scenario into the canonical events
 * orchestration persists. No fetch mock: the adapter talks to the server.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function runScenario(model: string, input = 'go') {
  const { origin, close } = await startScriptedModelServer({ delayMs: 0 });
  closers.push(close);
  const adapter = new OllamaAdapter(origin);
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  const threadId = `thread-${model}`;
  await adapter.startSession({ provider: 'ollama', threadId, modelId: model });
  // A failed generation rejects sendTurn as well as publishing runtime.error.
  const sent = adapter.sendTurn({ threadId, input }).then(
    () => undefined,
    (error: unknown) => error,
  );
  const events: CanonicalRuntimeEvent[] = [];
  for (let index = 0; index < 2000; index += 1) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
    if (
      next.value.method === 'turn.completed' ||
      next.value.method === 'runtime.error'
    ) {
      break;
    }
  }
  const text = events
    .filter((event) => event.method === 'content.text-delta')
    .map((event) => (event as { delta: string }).delta)
    .join('');
  return { events, text, terminal: events.at(-1), sendError: await sent };
}

function scriptedText(model: string, prompt = 'go') {
  return SCRIPTED_MODEL_SCENARIOS[model]
    .steps(prompt)
    .map((step) => ('text' in step ? step.text : ''))
    .join('');
}

describe('dev scripted model through the real OllamaAdapter', () => {
  test('lists every scenario as an available model', async () => {
    const { origin, close } = await startScriptedModelServer({ delayMs: 0 });
    closers.push(close);
    const catalog = await new OllamaAdapter(origin).listModels();
    expect(catalog.map((model) => model.id).sort()).toEqual(
      Object.keys(SCRIPTED_MODEL_SCENARIOS).sort(),
    );
  });

  test('showcase streams the whole script as many deltas and completes with stop', async () => {
    const { events, text, terminal, sendError } =
      await runScenario('scripted-showcase');
    expect(sendError).toBeUndefined();
    expect(events.map((event) => event.method)).toContain('turn.started');
    expect(
      events.filter((event) => event.method === 'content.text-delta').length,
    ).toBeGreaterThan(20);
    expect(text).toBe(scriptedText('scripted-showcase'));
    expect(terminal?.method).toBe('turn.completed');
    expect((terminal as { finishReason?: string }).finishReason).toBe('stop');
    expect((terminal as { outputText?: string }).outputText).toBe(
      scriptedText('scripted-showcase'),
    );
  });

  test('echo answers from the prompt the adapter actually sent', async () => {
    const { text } = await runScenario('scripted-echo', 'ping 42');
    expect(text).toBe('You said: ping 42');
  });

  test('truncated completes with max-tokens, not stop', async () => {
    const { terminal } = await runScenario('scripted-truncated');
    expect(terminal?.method).toBe('turn.completed');
    expect((terminal as { finishReason?: string }).finishReason).toBe(
      'max-tokens',
    );
  });

  test('error fails the turn with runtime.error after partial text', async () => {
    const { events, terminal, sendError, text } =
      await runScenario('scripted-error');
    expect(text).toBe(scriptedText('scripted-error'));
    expect(terminal?.method).toBe('runtime.error');
    expect(sendError).toBeInstanceOf(Error);
    expect(events.some((event) => event.method === 'turn.completed')).toBe(
      false,
    );
  });
});
