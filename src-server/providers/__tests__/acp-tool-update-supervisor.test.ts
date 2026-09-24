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
        // `secret-bytes` is not a PNG, so it becomes no attachment — and the
        // output says so rather than dropping it silently.
        {
          type: 'text',
          text: '[image not shown: the data is not a image/png image]',
        },
      ],
      outputReceipt: { truncated: true, fullOutput: 'unavailable' },
    });
    expect(events.at(-1)).not.toHaveProperty('attachments');
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

  /**
   * station#1569 (item 4): the session ending is not a cancellation. Dispose
   * used to run `cancelAll`, so every open ACP call ended `cancelled` — a
   * claim that someone stopped it — where the only observed facts are that no
   * result arrived and that nobody can say whether the tool ran.
   */
  describe('session end settles open calls as unresolved (station#1569 item 4)', () => {
    test('dispose publishes unresolved, not cancelled, for every open call', () => {
      const { events, supervisor } = harness();
      supervisor.acceptStarted({
        toolCallId: 'open-1',
        name: 'shell',
        hasName: true,
      });
      supervisor.acceptStarted({ toolCallId: 'open-2' });

      supervisor.dispose();

      const terminals = events.filter(
        (event) => event.method === 'tool.completed',
      );
      expect(terminals).toHaveLength(2);
      expect(terminals[0]).toMatchObject({
        toolCallId: 'open-1',
        toolName: 'shell',
        status: 'unresolved',
        output:
          'No result was reported before the session ended; whether the tool ran is unknown.',
      });
      expect(terminals[1]).toMatchObject({
        toolCallId: 'open-2',
        status: 'unresolved',
      });
      expect(
        terminals.some(
          (event) => (event as { status?: string }).status === 'cancelled',
        ),
      ).toBe(false);
    });

    test('an interrupt still cancels — only session end is unresolved', () => {
      // The discriminating control: `cancelAll` is the interrupt path
      // (`cancelTurn`), where someone really did stop the turn.
      const { events, supervisor } = harness();
      supervisor.acceptStarted({ toolCallId: 'open-1' });

      supervisor.cancelAll();

      expect(events.at(-1)).toMatchObject({
        method: 'tool.completed',
        status: 'cancelled',
      });
    });

    test('a call that already reported is not settled again', () => {
      const { events, supervisor } = harness();
      supervisor.acceptStarted({ toolCallId: 'done' });
      supervisor.acceptUpdate({
        toolCallId: 'done',
        status: 'completed',
        content: text('ok'),
        hasContent: true,
      });

      supervisor.dispose();

      const terminals = events.filter(
        (event) => event.method === 'tool.completed',
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ status: 'success' });
    });
  });
});

describe('AcpToolUpdateSupervisor — images a tool returned', () => {
  const PNG_1X1_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const imageBlock = (data = PNG_1X1_BASE64, mimeType = 'image/png') => ({
    type: 'content',
    content: { type: 'image', data, mimeType },
  });

  test('an image from an earlier content redraw is published with the bare terminal', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'shot', title: 'Screenshot' });
    supervisor.acceptUpdate({
      toolCallId: 'shot',
      hasContent: true,
      content: [...text('captured'), imageBlock()],
    });
    supervisor.acceptUpdate({
      toolCallId: 'shot',
      status: 'completed',
      hasStatus: true,
    });
    const completed = events.at(-1) as any;
    expect(completed).toMatchObject({
      method: 'tool.completed',
      status: 'success',
      attachments: [
        {
          kind: 'image',
          name: 'image-1.png',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`,
        },
      ],
    });
    // Progress redraws and the text output never carry the bytes.
    for (const event of events.slice(0, -1))
      expect(JSON.stringify(event)).not.toContain(PNG_1X1_BASE64);
    expect(JSON.stringify(completed.output)).not.toContain(PNG_1X1_BASE64);
  });

  test('a later content redraw replaces the images of the earlier one', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'redraw' });
    supervisor.acceptUpdate({
      toolCallId: 'redraw',
      hasContent: true,
      content: [imageBlock()],
    });
    supervisor.acceptUpdate({
      toolCallId: 'redraw',
      hasContent: true,
      content: text('no image any more'),
    });
    supervisor.acceptUpdate({
      toolCallId: 'redraw',
      status: 'completed',
      hasStatus: true,
    });
    expect(events.at(-1)).not.toHaveProperty('attachments');
  });

  test('images beyond the session hold budget are named, not kept', () => {
    const budget = new AcpToolUpdateGlobalBudget();
    const { events, supervisor } = harness({ budget });
    // Five 4 MiB images fit one result's count limit but not the 15 MiB
    // per-session hold: the collector already refuses past 15 MiB combined,
    // so fill the session from a second open call instead.
    const big = Buffer.concat([
      Buffer.from(PNG_1X1_BASE64, 'base64'),
      Buffer.alloc(4 * 1024 * 1024),
    ]).toString('base64');
    supervisor.acceptStarted({ toolCallId: 'first' });
    supervisor.acceptUpdate({
      toolCallId: 'first',
      hasContent: true,
      content: [imageBlock(big), imageBlock(big), imageBlock(big)],
    });
    supervisor.acceptStarted({ toolCallId: 'second' });
    supervisor.acceptUpdate({
      toolCallId: 'second',
      hasContent: true,
      content: [imageBlock(big)],
    });
    supervisor.acceptUpdate({
      toolCallId: 'second',
      status: 'completed',
      hasStatus: true,
    });
    const second = events.at(-1) as any;
    expect(second).not.toHaveProperty('attachments');
    expect(second.output).toContainEqual({
      type: 'text',
      text: '[image not shown: 1 image(s) exceeded what Station holds for open tool calls]',
    });
    // Releasing the first call frees its hold for the next result.
    supervisor.acceptUpdate({
      toolCallId: 'first',
      status: 'completed',
      hasStatus: true,
    });
    expect((events.at(-1) as any).attachments).toHaveLength(3);
    supervisor.acceptStarted({ toolCallId: 'third' });
    supervisor.acceptUpdate({
      toolCallId: 'third',
      hasContent: true,
      content: [imageBlock(big)],
      status: 'completed',
      hasStatus: true,
    });
    expect((events.at(-1) as any).attachments).toHaveLength(1);
  });

  test('the terminal persists through EventStore as a blob reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-image-'));
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    try {
      const supervisor = new AcpToolUpdateSupervisor(session(), (event) =>
        store.appendEvent(store.projectLiveEvent(event)),
      );
      supervisor.acceptStarted({ toolCallId: 'persist' });
      supervisor.acceptUpdate({
        toolCallId: 'persist',
        hasContent: true,
        content: [imageBlock()],
        status: 'completed',
        hasStatus: true,
      });
      const terminal = store
        .listEvents('thread-1')
        .map((event) => event.payload)
        .find((event) => event.method === 'tool.completed') as any;
      expect(terminal.attachments[0].blobRef).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(terminal.attachments[0]).not.toHaveProperty('dataUrl');
      expect(
        store.listAttachmentThreads(terminal.attachments[0].blobRef),
      ).toEqual(['thread-1']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AcpToolUpdateSupervisor — image bytes never ride text', () => {
  const PNG_1X1_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const probe = PNG_1X1_BASE64.slice(20, 44);
  const dataUri = `data:image/png;base64,${PNG_1X1_BASE64}`;

  test('a data: image uri is not printed into progress text', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'uri' });
    supervisor.acceptUpdate({
      toolCallId: 'uri',
      hasContent: true,
      content: [{ type: 'content', content: { type: 'image', uri: dataUri } }],
    });
    const progress = events.find((event) => event.method === 'tool.progress');
    expect(progress).toMatchObject({
      message: '[image: [inline image data omitted]]',
    });
    expect(JSON.stringify(events)).not.toContain(probe);
  });

  test('a data: image uri is not printed into a failed call error', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'fail' });
    supervisor.acceptUpdate({
      toolCallId: 'fail',
      hasContent: true,
      content: [{ type: 'image', uri: dataUri, mimeType: 'image/png' }],
      status: 'failed',
      hasStatus: true,
    });
    const terminal = events.at(-1) as any;
    expect(terminal.status).toBe('error');
    expect(terminal.error).toContain('[inline image data omitted]');
    expect(JSON.stringify(events)).not.toContain(probe);
  });

  test('rawOutput data URLs and image-shaped payloads are replaced whole', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'raw' });
    supervisor.acceptUpdate({
      toolCallId: 'raw',
      hasRawOutput: true,
      rawOutput: {
        screenshot: dataUri,
        blocks: [
          { type: 'image', data: PNG_1X1_BASE64, mimeType: 'image/png' },
        ],
      },
      status: 'completed',
      hasStatus: true,
    });
    const terminal = events.at(-1) as any;
    expect(terminal.output).toEqual({
      screenshot: '[inline image data omitted]',
      blocks: [
        {
          type: 'image',
          data: '[inline image data omitted]',
          mimeType: 'image/png',
        },
      ],
    });
    expect(JSON.stringify(events)).not.toContain(probe);
  });

  test('a bare data URL rawOutput is replaced, not tail-truncated', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'bare' });
    supervisor.acceptUpdate({
      toolCallId: 'bare',
      hasRawOutput: true,
      rawOutput: `data:image/png;base64,${'A'.repeat(20_000)}`,
      status: 'completed',
      hasStatus: true,
    });
    expect((events.at(-1) as any).output).toBe('[inline image data omitted]');
  });
});

describe('AcpToolUpdateSupervisor — redaction under a nearly spent budget', () => {
  test('a data URL rawOutput is never tail-truncated into a base64 slice when little budget is left', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'tight' });
    // rawInput takes almost the whole per-call budget, leaving rawOutput
    // fewer bytes than the placeholder itself — the one path where the raw
    // projector re-tails its input string.
    supervisor.acceptUpdate({
      toolCallId: 'tight',
      hasRawInput: true,
      rawInput: 'x'.repeat(ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerCall - 17),
    });
    supervisor.acceptUpdate({
      toolCallId: 'tight',
      hasRawOutput: true,
      rawOutput: `data:image/png;base64,${'QUJD'.repeat(200)}WFla`,
      status: 'completed',
      hasStatus: true,
    });
    expect(JSON.stringify(events)).not.toContain('WFla');
    expect(JSON.stringify(events)).not.toContain('QUJD');
  });
});

describe('AcpToolUpdateSupervisor — embedded and nested image data', () => {
  const tail = 'WFla';
  const dataUri = `data:image/png;base64,${'QUJD'.repeat(200)}${tail}`;

  test('a data URL inside prose is redacted in progress text and rawOutput', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'prose' });
    supervisor.acceptUpdate({
      toolCallId: 'prose',
      hasContent: true,
      content: text(`Screenshot: ${dataUri} saved`),
    });
    supervisor.acceptUpdate({
      toolCallId: 'prose',
      hasRawOutput: true,
      rawOutput: `Screenshot: ${dataUri}`,
      status: 'completed',
      hasStatus: true,
    });
    expect(
      events.find((event) => event.method === 'tool.progress'),
    ).toMatchObject({
      message: 'Screenshot: [inline image data omitted] saved',
    });
    expect(JSON.stringify(events)).not.toContain(tail);
  });

  test.each([
    ['a data-URL property', (pad: string) => ({ pad, screenshot: dataUri })],
    [
      'an image-shaped property',
      (pad: string) => ({
        pad,
        image: { type: 'image', data: `${'QUJD'.repeat(200)}${tail}` },
      }),
    ],
  ])(
    '%s never leaks a base64 suffix when earlier properties nearly fill the budget',
    (_label, build) => {
      // Sweep the padding so the nested property lands on every leftover
      // budget from "fits" down to "nothing left": the fallback that tails a
      // string must only ever see the redacted text.
      for (
        let padLength = ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerCall - 80;
        padLength < ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerCall;
        padLength += 1
      ) {
        const { events, supervisor } = harness();
        supervisor.acceptStarted({ toolCallId: 'nested' });
        supervisor.acceptUpdate({
          toolCallId: 'nested',
          hasRawOutput: true,
          rawOutput: build('x'.repeat(padLength)),
          status: 'completed',
          hasStatus: true,
        });
        const serialized = JSON.stringify(events);
        expect(serialized, `pad ${padLength}`).not.toContain(tail);
        expect(serialized, `pad ${padLength}`).not.toContain('QUJD');
      }
    },
  );
});

describe('AcpToolUpdateSupervisor — omission notes on a failed call', () => {
  test('a failed call states the omission in its error text', () => {
    const { events, supervisor } = harness();
    supervisor.acceptStarted({ toolCallId: 'failed' });
    supervisor.acceptUpdate({
      toolCallId: 'failed',
      hasContent: true,
      content: [
        ...text('capture failed'),
        {
          type: 'content',
          content: {
            type: 'image',
            data: 'PHN2Zy8+',
            mimeType: 'image/svg+xml',
          },
        },
      ],
      status: 'failed',
      hasStatus: true,
    });
    const terminal = events.at(-1) as any;
    expect(terminal.status).toBe('error');
    expect(terminal.error).toBe(
      'capture failed\n[image omitted]\n[image not shown: image/svg+xml is not a supported image type]',
    );
  });
});
