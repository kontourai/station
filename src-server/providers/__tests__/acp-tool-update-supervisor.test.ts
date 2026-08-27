import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { EventStore } from '../../services/orchestration/event-store.js';
import type {
  CanonicalRuntimeEvent,
  ProviderSession,
} from '../adapter-shape.js';
import {
  ACP_TOOL_UPDATE_LIMITS,
  AcpToolUpdateGlobalBudget,
  AcpToolUpdateSupervisor,
} from '../adapters/acp-tool-update-supervisor.js';

function session(threadId = 'thread-1'): ProviderSession {
  return {
    provider: 'acp',
    threadId,
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function harness(options?: {
  budget?: AcpToolUpdateGlobalBudget;
  now?: () => number;
  threadId?: string;
}) {
  const events: CanonicalRuntimeEvent[] = [];
  return {
    events,
    supervisor: new AcpToolUpdateSupervisor(
      session(options?.threadId),
      (event) => events.push(event),
      options?.budget,
      options?.now,
    ),
  };
}

const text = (value: string) => [
  { type: 'content', content: { type: 'text', text: value } },
];

describe('AcpToolUpdateSupervisor', () => {
  test('never stringifies an original untrusted raw value to estimate omission', () => {
    const source = readFileSync(
      new URL('../adapters/acp-tool-update-supervisor.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('JSON.stringify(value)');
    expect(source).not.toContain('private estimate(');
  });

  test('does not inspect a hostile second raw field after the first consumes the budget', () => {
    const traps = { ownKeys: 0, descriptor: 0, get: 0 };
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          traps.ownKeys += 1;
          throw new Error('ownKeys');
        },
        getOwnPropertyDescriptor() {
          traps.descriptor += 1;
          throw new Error('descriptor');
        },
        get() {
          traps.get += 1;
          throw new Error('get');
        },
      },
    );
    const { events, supervisor } = harness();
    supervisor.acceptStarted({
      toolCallId: 'exhausted',
      rawInput: 'a'.repeat(ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerCall * 2),
      hasRawInput: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'exhausted',
      rawOutput: hostile,
      hasRawOutput: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'exhausted',
      status: 'completed',
      hasStatus: true,
    });
    expect(traps).toEqual({ ownKeys: 0, descriptor: 0, get: 0 });
    expect(events.at(-1)).toMatchObject({
      method: 'tool.completed',
      outputReceipt: { truncated: true, fullOutput: 'unavailable' },
    });
  });

  test('omits an unfit cyclic/accessor raw property without re-reading it and persists the terminal', () => {
    const nested: Record<string, unknown> = {
      payload: 'a'.repeat(ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerCall * 2),
    };
    nested.self = nested;
    const rawInput: Record<string, unknown> = {};
    Object.defineProperty(rawInput, 'accessor', {
      enumerable: true,
      get() {
        throw new Error('must not read');
      },
    });
    rawInput.unfit = nested;
    const { events, supervisor } = harness();
    supervisor.acceptStarted({
      toolCallId: 'unfit',
      rawInput,
      hasRawInput: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'unfit',
      status: 'completed',
      hasStatus: true,
    });
    const terminal = events.at(-1)!;
    expect(terminal).toMatchObject({
      method: 'tool.completed',
      outputReceipt: {
        truncated: true,
        reasons: expect.arrayContaining(['bytes', 'cycle', 'getter']),
        omittedBytesAtLeast: expect.any(Number),
        fullOutput: 'unavailable',
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'acp-unfit-store-'));
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    try {
      expect(() => store.appendEvent(terminal)).not.toThrow();
      expect(store.listEvents('thread-1')).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('projects raw input under one aggregate encoded-byte budget with a useful tail', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({
      toolCallId: 'raw-string',
      rawInput: `${'discard'.repeat(2000)}✓tail`,
      hasRawInput: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'raw-string',
      status: 'completed',
      hasStatus: true,
    });
    const started = events.find((event) => event.method === 'tool.started');
    const terminal = events.at(-1);
    expect(started).toMatchObject({
      arguments: expect.stringContaining('✓tail'),
    });
    expect(terminal).toMatchObject({
      method: 'tool.completed',
      outputReceipt: {
        truncated: true,
        reasons: expect.arrayContaining(['bytes']),
        retainedBytes: expect.any(Number),
        omittedBytesAtLeast: expect.any(Number),
        fullOutput: 'unavailable',
      },
    });
    expect(
      Buffer.byteLength(JSON.stringify((started as any).arguments)),
    ).toBeLessThanOrEqual(ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerCall);
  });

  test('counts object JSON structure against one raw aggregate budget', () => {
    const { events, supervisor } = harness();
    const rawInput = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `field-${index}`,
        `${'discard'.repeat(200)}tail-${index}`,
      ]),
    );
    supervisor.acceptStarted({
      toolCallId: 'raw-object',
      rawInput,
      hasRawInput: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'raw-object',
      status: 'completed',
      hasStatus: true,
    });
    const started = events.find(
      (event) => event.method === 'tool.started',
    ) as any;
    const terminal = events.at(-1);
    const encoded = JSON.stringify(started.arguments);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(
      ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerCall,
    );
    expect(encoded).toContain('tail-0');
    expect(terminal).toMatchObject({
      outputReceipt: {
        truncated: true,
        reasons: expect.arrayContaining(['bytes']),
        retainedBytes: expect.any(Number),
      },
    });
  });

  test('raw structural projection receipts cycles, depth, and hostile traps', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deep = { a: { b: { c: { d: { e: 'beyond' } } } } };
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
        getOwnPropertyDescriptor() {
          throw new Error('descriptor');
        },
        get() {
          throw new Error('get');
        },
      },
    );
    for (const [id, rawInput, reason] of [
      ['cycle', cyclic, 'cycle'],
      ['depth', deep, 'depth'],
      ['hostile', hostile, 'getter'],
    ] as const) {
      const { events, supervisor } = harness();
      supervisor.acceptStarted({ toolCallId: id, rawInput, hasRawInput: true });
      supervisor.acceptUpdate({
        toolCallId: id,
        status: 'completed',
        hasStatus: true,
      });
      expect(events.at(-1)).toMatchObject({
        outputReceipt: {
          truncated: true,
          reasons: expect.arrayContaining([reason]),
          fullOutput: 'unavailable',
        },
      });
    }
  });

  test('a bounded raw terminal persists through EventStore ingress', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({
      toolCallId: 'persisted',
      rawOutput: Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [
          `field-${index}`,
          `${'discard'.repeat(200)}tail-${index}`,
        ]),
      ),
      hasRawOutput: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'persisted',
      status: 'completed',
      hasStatus: true,
    });
    const terminal = events.at(-1)!;
    const dir = mkdtempSync(join(tmpdir(), 'acp-supervisor-store-'));
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    try {
      expect(() => store.appendEvent(terminal)).not.toThrow();
      expect(store.listEvents('thread-1')).toEqual([
        expect.objectContaining({ payload: terminal }),
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the mapper inventory has no bypass or unbounded raw-value renderer', () => {
    const source = readFileSync(
      new URL('../adapters/acp-adapter-events.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('stringifyRawValue');
    expect(source).not.toContain('toolUpdateSupervisor?');
    expect(source).toContain('toolUpdateSupervisor: AcpToolUpdateSupervisor');
  });

  test('one pending redraw is flushed before a status-only terminal and retained content is used', () => {
    vi.useFakeTimers();
    const { events, supervisor } = harness();
    supervisor.acceptStarted({
      toolCallId: 'call',
      name: 'run',
      hasName: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'call',
      content: text('one'),
      hasContent: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'call',
      content: text('two'),
      hasContent: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'call',
      status: 'completed',
      hasStatus: true,
    });

    expect(events.map((event) => event.method)).toEqual([
      'tool.started',
      'tool.progress',
      'tool.progress',
      'tool.completed',
    ]);
    expect(events.at(-1)).toMatchObject({
      method: 'tool.completed',
      output: [{ type: 'text', text: 'two' }],
    });
    vi.useRealTimers();
  });

  test('omitted replacement fields retain, explicit null clears, and metadata does not invent progress', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({
      toolCallId: 'retained',
      rawInput: { old: true },
      hasRawInput: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'retained',
      content: text('kept'),
      hasContent: true,
    });
    const beforeMetadata = events.length;
    supervisor.acceptUpdate({
      toolCallId: 'retained',
      name: 'renamed',
      hasName: true,
    });
    expect(events).toHaveLength(beforeMetadata + 1);
    expect(events.at(-1)).toMatchObject({
      method: 'tool.started',
      toolName: 'renamed',
    });
    supervisor.acceptUpdate({
      toolCallId: 'retained',
      status: 'completed',
      hasStatus: true,
    });
    expect(events.at(-1)).toMatchObject({
      method: 'tool.completed',
      output: [{ type: 'text', text: 'kept' }],
    });

    supervisor.acceptStarted({ toolCallId: 'cleared' });
    supervisor.acceptUpdate({
      toolCallId: 'cleared',
      content: text('gone'),
      hasContent: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'cleared',
      content: null,
      hasContent: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'cleared',
      status: 'completed',
      hasStatus: true,
    });
    expect(events.at(-1)).toMatchObject({ method: 'tool.completed' });
    expect(events.at(-1)).not.toHaveProperty('output');
  });

  test('preserves mixed content encounter order and excludes image bytes', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'mixed' });
    supervisor.acceptUpdate({
      toolCallId: 'mixed',
      hasContent: true,
      content: [
        { type: 'content', content: { type: 'text', text: 'before' } },
        { type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'file:///a', text: 'resource' },
          },
        },
        {
          type: 'content',
          content: {
            type: 'image',
            uri: 'https://image.example/a',
            mimeType: 'image/png',
            data: 'secret-bytes',
          },
        },
      ],
    });
    supervisor.acceptUpdate({
      toolCallId: 'mixed',
      status: 'completed',
      hasStatus: true,
    });
    expect(events.at(-1)).toMatchObject({
      output: [
        { type: 'text', text: 'before' },
        { type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' },
        { type: 'resource', uri: 'file:///a', text: 'resource' },
        {
          type: 'image',
          uri: 'https://image.example/a',
          omitted: 'image-bytes',
        },
      ],
      outputReceipt: { truncated: true, fullOutput: 'unavailable' },
    });
    expect(JSON.stringify(events.at(-1))).not.toContain('secret-bytes');
  });

  test('keeps a useful UTF-8 tail and survives poisoned ownKeys, descriptors, and getters', () => {
    const { events, supervisor } = harness();
    const poisoned = new Proxy([], {
      ownKeys() {
        throw new Error('ownKeys');
      },
      getOwnPropertyDescriptor() {
        throw new Error('descriptor');
      },
      get() {
        throw new Error('get');
      },
    });
    supervisor.acceptStarted({ toolCallId: 'poison' });
    supervisor.acceptUpdate({
      toolCallId: 'poison',
      content: poisoned,
      hasContent: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'poison',
      status: 'completed',
      hasStatus: true,
    });
    expect(events.at(-1)).toMatchObject({
      outputReceipt: {
        truncated: true,
        reasons: expect.arrayContaining(['getter']),
      },
    });

    const { events: longEvents, supervisor: long } = harness();
    long.acceptStarted({ toolCallId: 'long' });
    long.acceptUpdate({
      toolCallId: 'long',
      content: text(`${'discard'.repeat(2000)}✓tail`),
      hasContent: true,
    });
    long.acceptUpdate({
      toolCallId: 'long',
      status: 'completed',
      hasStatus: true,
    });
    expect(JSON.stringify(longEvents.at(-1))).toContain('✓tail');
  });

  test('bounds 10,001 updates and reports unavailable full output honestly', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'noisy' });
    for (
      let index = 0;
      index < ACP_TOOL_UPDATE_LIMITS.maxUpdatesPerCall + 1;
      index++
    ) {
      supervisor.acceptUpdate({
        toolCallId: 'noisy',
        content: text(String(index)),
        hasContent: true,
      });
    }
    supervisor.acceptUpdate({
      toolCallId: 'noisy',
      status: 'completed',
      hasStatus: true,
    });
    expect(events.at(-1)).toMatchObject({
      method: 'tool.completed',
      outputReceipt: {
        truncated: true,
        omittedUpdates: 1,
        fullOutput: 'unavailable',
      },
    });
  });

  test('bounds 65 per-session calls and 513 adapter-wide calls', () => {
    const local = harness();
    for (
      let index = 0;
      index < ACP_TOOL_UPDATE_LIMITS.maxCallsPerSession + 1;
      index++
    ) {
      local.supervisor.acceptStarted({ toolCallId: `local-${index}` });
    }
    expect(
      local.events.filter((event) => event.method === 'tool.started'),
    ).toHaveLength(64);

    const budget = new AcpToolUpdateGlobalBudget();
    const supervisors = Array.from({ length: 9 }, (_, index) =>
      harness({ budget, threadId: `global-${index}` }),
    );
    for (let index = 0; index < 513; index++) {
      supervisors[index % supervisors.length].supervisor.acceptStarted({
        toolCallId: `global-call-${index}`,
      });
    }
    expect(
      supervisors
        .flatMap(({ events }) => events)
        .filter((event) => event.method === 'tool.started'),
    ).toHaveLength(512);
    supervisors.forEach(({ supervisor }) => supervisor.dispose());
  });

  test('cancellation, teardown, tombstone expiry, and late updates remain bounded', () => {
    vi.useFakeTimers();
    let clock = 0;
    const { events, supervisor } = harness({ now: () => clock });
    supervisor.acceptStarted({ toolCallId: 'cancel' });
    supervisor.acceptUpdate({
      toolCallId: 'cancel',
      content: text('latest'),
      hasContent: true,
    });
    supervisor.cancelAll();
    expect(events.at(-1)).toMatchObject({
      method: 'tool.completed',
      status: 'cancelled',
    });
    const beforeLate = events.length;
    supervisor.acceptUpdate({
      toolCallId: 'cancel',
      content: text('late'),
      hasContent: true,
    });
    expect(events).toHaveLength(beforeLate);
    clock += ACP_TOOL_UPDATE_LIMITS.tombstoneTtlMs + 1;
    supervisor.acceptStarted({ toolCallId: 'cancel' });
    expect(events.at(-1)).toMatchObject({ method: 'tool.started' });
    supervisor.dispose();
    vi.advanceTimersByTime(ACP_TOOL_UPDATE_LIMITS.cadenceMs + 1);
    expect(
      events.filter((event) => event.method === 'tool.completed'),
    ).toHaveLength(2);
    vi.useRealTimers();
  });
});
