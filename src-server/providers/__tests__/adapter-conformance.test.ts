import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { SendTurnRefusedError } from '../adapter-shape.js';
import type { ConformanceEngine } from './adapter-conformance-fixtures.js';
import {
  ConformanceClaudeChild,
  createConformanceEngine,
  FILE,
  IMAGE,
  PNG,
  THREAD,
} from './adapter-conformance-fixtures.js';
import {
  ADAPTERS,
  expectCanonicalSessionLifecycle,
} from './adapter-contract-test-utils.js';

const { spawnFake } = vi.hoisted(() => ({ spawnFake: vi.fn() }));
vi.mock('../adapters/claude-code-spawn.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/claude-code-spawn.js')>();
  return {
    ...actual,
    createClaudeEngineProcess: (_spawn?: never, wrap?: never) =>
      actual.createClaudeEngineProcess(spawnFake, wrap),
  };
});

const makeTempDir = trackTempDirs();
const terminal = (event: CanonicalRuntimeEvent) =>
  event.method === 'turn.completed' ||
  event.method === 'turn.aborted' ||
  event.method === 'runtime.error';

// Each entry is a reproduced adapter defect, not permission to omit the check.
// Keep the same assertions under it.fails: fixing the adapter makes this suite red
// until its known-gap designation is removed.
const gaps = {
  active: new Set(['codex', 'bedrock', 'ollama']),
  interrupt: new Set(['claude', 'codex', 'acp']),
  attachment: new Set(['codex', 'muse', 'station-agent', 'bedrock', 'ollama']),
};

function exempt(adapter: string, reason: string) {
  // The focused/default reporter hides skipped names. Emit every reason even there.
  beforeAll(() => {
    process.stdout.write(`[adapter-conformance] ${adapter}: ${reason}\n`);
  });
  it.skip(reason, () => {});
}

for (const name of ADAPTERS) {
  describe(`ProviderAdapterShape conformance: ${name}`, () => {
    beforeAll(() => {
      for (const [category, adapters] of Object.entries(gaps)) {
        if (adapters.has(name))
          process.stdout.write(
            `[adapter-conformance] ${name}: KNOWN GAP ${category} (it.fails; see named contract assertion)\n`,
          );
      }
    });
    let engine: ConformanceEngine;
    let root: string;
    let cwd: string;
    const events: Array<{ event: CanonicalRuntimeEvent; at: number }> = [];
    let signal: AbortController;
    let reader: Promise<void>;
    const published = () => events.map(({ event }) => event);
    const texts = () =>
      published().filter((event) => event.method === 'content.text-delta');
    const started = () =>
      published().filter((event) => event.method === 'turn.started');
    const terminals = () => published().filter(terminal);
    const sends: Array<Promise<unknown>> = [];
    const beginSend = (
      input: Parameters<ConformanceEngine['adapter']['sendTurn']>[0],
    ) => {
      const state: { value?: unknown; error?: unknown; settled: boolean } = {
        settled: false,
      };
      const pending = engine.adapter.sendTurn(input).then(
        (value) => {
          state.value = value;
          state.settled = true;
        },
        (error: unknown) => {
          state.error = error;
          state.settled = true;
        },
      );
      sends.push(pending);
      return state;
    };
    const settle = async (count: number) => {
      await expect.poll(() => terminals().length).toBe(count);
    };
    const send = async (attachments?: (typeof IMAGE)[]) => {
      const count = engine.inputs().length;
      const starts = started().length;
      const state = beginSend({
        threadId: THREAD,
        input: 'conformance prompt',
        attachments,
      });
      await expect
        .poll(() => engine.inputs().length, {
          message: 'engine observed prompt',
        })
        .toBe(count + 1);
      await expect.poll(() => started().length).toBe(starts + 1);
      expect(state.error).toBeUndefined();
      const event = started().at(-1)!;
      return {
        threadId: event.threadId,
        turnId: event.turnId!,
        receipt: state,
      };
    };

    beforeEach(async () => {
      root = makeTempDir('adapter-conformance-');
      cwd = join(root, 'workspace');
      mkdirSync(cwd);
      events.length = 0;
      sends.length = 0;
      spawnFake.mockImplementation(
        (command, args, options) =>
          new ConformanceClaudeChild(command, args, options),
      );
      engine = createConformanceEngine(name, cwd);
      signal = new AbortController();
      reader = (async () => {
        for await (const event of engine.adapter.streamEvents({
          signal: signal.signal,
        }))
          events.push({ event, at: performance.now() });
      })();
      await engine.start();
    });
    afterEach(async () => {
      try {
        await engine?.cleanup();
        await Promise.all(sends);
      } finally {
        signal?.abort();
        await reader;
        vi.unstubAllGlobals();
      }
    });

    it('lifecycle — adapter-shape.ts hasSession: "THIS PROCESS currently holds a live engine binding"; contracts/runtime-events.ts TurnCompletedEvent: start → send → completed and follow-up', async () => {
      expect(await engine.adapter.hasSession(THREAD)).toBe(true);
      const first = await send();
      engine.text('first');
      engine.complete();
      await settle(1);
      await expect
        .poll(() => first.receipt.value)
        .toMatchObject({ threadId: THREAD, turnId: first.turnId });
      const second = await send();
      engine.text('follow-up');
      engine.complete();
      await settle(2);
      await expect
        .poll(() => second.receipt.value)
        .toMatchObject({ threadId: THREAD, turnId: second.turnId });
      expect(second.turnId).not.toBe(first.turnId);
      expect(first.threadId).toBe(THREAD);
      expect(second.threadId).toBe(THREAD);
      const methods = published().map((event) => event.method);
      expectCanonicalSessionLifecycle(methods);
      expect(terminals()).toEqual([
        expect.objectContaining({
          method: 'turn.completed',
          turnId: first.turnId,
          finishReason: 'stop',
        }),
        expect.objectContaining({
          method: 'turn.completed',
          turnId: second.turnId,
          finishReason: 'stop',
        }),
      ]);
      for (const turn of [first, second]) {
        const own = published().filter((event) => event.turnId === turn.turnId);
        expect(own[0]?.method).toBe('turn.started');
        expect(own.at(-1)?.method).toBe('turn.completed');
      }
      await engine.adapter.stopSession(THREAD);
      expect(await engine.adapter.hasSession(THREAD)).toBe(false);
    });

    const interruptTest = gaps.interrupt.has(name) ? it.fails : it;
    interruptTest(
      `interrupt — adapter-shape.ts ProviderInterruptTurnResult: "Target-specific result"; cancelled requires terminal delivery and suppresses late engine text${gaps.interrupt.has(name) ? ' [KNOWN GAP: late text is published after cancelled]' : ''}`,
      async () => {
        const turn = await send();
        engine.text('before-stop');
        await expect.poll(() => texts().length).toBe(1);
        const result = await engine.adapter.interruptTurn(THREAD, turn.turnId);
        expect(result).toEqual({ outcome: 'cancelled', turnId: turn.turnId });
        expect(engine.stopped(), 'stop reached the engine transport').toBe(
          true,
        );
        await settle(1);
        expect(terminals()[0]).toMatchObject({
          method: 'turn.aborted',
          turnId: turn.turnId,
        });
        engine.late();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(texts().map((event) => event.delta)).toEqual(['before-stop']);
        expect(terminals()).toHaveLength(1);
      },
    );

    const activeTest = gaps.active.has(name) ? it.fails : it;
    activeTest(
      `pre-effect refusal — adapter-shape.ts SendTurnRefusedError: "no engine was invoked, no prompt was sent, and no turn.started was published"${gaps.active.has(name) ? ' [KNOWN GAP: running turn is accepted instead of refused]' : ''}`,
      async () => {
        await send();
        const before = engine.inputs().length;
        const starts = started().length;
        const refused = beginSend({
          threadId: THREAD,
          input: 'must not reach engine',
        });
        await expect
          .poll(() => refused.settled || engine.inputs().length > before)
          .toBe(true);
        // A plain error is indeterminate, never accepted as a pre-effect refusal.
        expect(refused.error).toBeInstanceOf(SendTurnRefusedError);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(engine.inputs()).toHaveLength(before);
        expect(started()).toHaveLength(starts);
      },
    );

    if (name === 'claude') {
      exempt(
        name,
        'EXEMPT undeclared attachment — Claude declares both image-input and file-input; the contract has no third attachment kind',
      );
    } else {
      const attachmentTest = gaps.attachment.has(name) ? it.fails : it;
      attachmentTest(
        `capability refusal — adapter-shape.ts AttachmentInputUnsupportedError: "pre-effect refusal ... carrying a structured code"${gaps.attachment.has(name) ? ' [KNOWN GAP: absent capability is ignored or refused without attachment_input_unsupported]' : ''}`,
        async () => {
          const attachment = engine.adapter.metadata.capabilities.includes(
            'image-input',
          )
            ? FILE
            : IMAGE;
          const capability =
            attachment.kind === 'image' ? 'image-input' : 'file-input';
          expect(engine.adapter.metadata.capabilities).not.toContain(
            capability,
          );
          const refused = beginSend({
            threadId: THREAD,
            input: 'refuse',
            attachments: [attachment],
          });
          await expect
            .poll(() => refused.settled || engine.inputs().length > 0)
            .toBe(true);
          expect(refused.error).toMatchObject({
            code: 'attachment_input_unsupported',
          });
          await new Promise((resolve) => setTimeout(resolve, 10));
          expect(engine.inputs()).toHaveLength(0);
          expect(started()).toHaveLength(0);
        },
      );
    }

    if (name === 'acp') {
      it('pre-effect refusal — adapter-shape.ts AttachmentInputUnsupportedError: engine "did not advertise a needed capability"; absent session image support refuses before prompt', async () => {
        engine.refuseImage!();
        const refused = beginSend({
          threadId: THREAD,
          input: 'refuse image',
          attachments: [IMAGE],
        });
        await expect.poll(() => refused.settled).toBe(true);
        expect(refused.error).toMatchObject({
          code: 'attachment_input_unsupported',
        });
        expect(engine.inputs()).toHaveLength(0);
        expect(started()).toHaveLength(0);
      });
      it('pre-effect refusal — adapter-shape.ts SendTurnRefusedError: "Input validation" sends no malformed attachment to the engine', async () => {
        const refused = beginSend({
          threadId: THREAD,
          input: 'refuse malformed image',
          attachments: [{ ...IMAGE, dataUrl: 'invalid' }],
        });
        await expect.poll(() => refused.settled).toBe(true);
        expect(refused.error).toBeInstanceOf(SendTurnRefusedError);
        expect(engine.inputs()).toHaveLength(0);
        expect(started()).toHaveLength(0);
      });
    }

    if (name === 'bedrock' || name === 'ollama') {
      exempt(
        name,
        'EXEMPT declared image-input — adapter does not declare image-input; session-lifecycle is exercised by the shared lifecycle check',
      );
    } else {
      it('capability delivery — contracts/chat-attachment.ts: "Provider-neutral, request-scoped chat attachment"; declared image-input delivers the actual bytes to the engine', async () => {
        expect(engine.adapter.metadata.capabilities).toContain('image-input');
        await send([IMAGE]);
        expect(engine.receivedImage()).toEqual(PNG);
        engine.complete();
        await settle(1);
      });
    }

    it('event delivery — adapter-shape.ts streamEvents and contracts/runtime-events.ts ContentTextDeltaEvent: ordered deltas arrive before engine completion, with observed arrival spread', async () => {
      const turn = await send();
      engine.text('one');
      await expect
        .poll(() => texts().map((event) => event.delta))
        .toEqual(['one']);
      expect(terminals()).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const releasedSecond = performance.now();
      engine.text('two');
      await expect
        .poll(() => texts().map((event) => event.delta))
        .toEqual(['one', 'two']);
      expect(terminals()).toHaveLength(0);
      const arrivals = events.filter(
        ({ event }) => event.method === 'content.text-delta',
      );
      expect(arrivals[0].at).toBeLessThan(releasedSecond);
      expect(arrivals[1].at).toBeGreaterThanOrEqual(releasedSecond);
      expect(arrivals[1].at - arrivals[0].at).toBeGreaterThanOrEqual(25);
      expect(texts().every((event) => event.turnId === turn.turnId)).toBe(true);
      engine.complete();
      await settle(1);
      const own = published().filter((event) => event.turnId === turn.turnId);
      expect(
        own
          .filter(
            (event) =>
              event.method === 'turn.started' ||
              event.method === 'content.text-delta' ||
              terminal(event),
          )
          .map((event) => event.method),
      ).toEqual([
        'turn.started',
        'content.text-delta',
        'content.text-delta',
        'turn.completed',
      ]);
    });

    it('stream cancellation — adapter-shape.ts streamEvents: "Implementations must settle pending reads when the signal is aborted"', async () => {
      const abort = new AbortController();
      const iterator = engine.adapter
        .streamEvents({ signal: abort.signal })
        [Symbol.asyncIterator]();
      // The primary reader has drained startup; this read is pending on an empty queue.
      const pending = iterator.next();
      abort.abort();
      await expect(pending).resolves.toMatchObject({ done: true });
    });

    if (name === 'muse') {
      it('interrupt uncertainty — adapter-shape.ts ProviderInterruptTurnResult: termination-unconfirmed is never cancelled', async () => {
        const turn = await send();
        engine.unconfirmTermination!();
        const result = await engine.adapter.interruptTurn(THREAD, turn.turnId);
        expect(result).toEqual({
          outcome: 'termination-unconfirmed',
          turnId: turn.turnId,
        });
        await settle(1);
        expect(terminals()[0]).not.toMatchObject({
          method: 'turn.completed',
          finishReason: 'cancelled',
        });
      });
    } else {
      exempt(
        name,
        'EXEMPT termination-unconfirmed simulation — this adapter has no termination-unconfirmed result path; confirmed cancellation is exercised above',
      );
    }

    if (name === 'codex') {
      it('outputs — contracts/runtime-events.ts ToolCompletedEvent.attachments: "Images the tool returned"; host-file bytes require an existing file within the workspace', async () => {
        await send();
        writeFileSync(join(cwd, 'inside.png'), PNG);
        writeFileSync(join(root, 'outside.png'), PNG);
        symlinkSync(join(root, 'outside.png'), join(cwd, 'escape.png'));
        const cases = [
          ['inside.png', true],
          ['../outside.png', false],
          [join(root, 'outside.png'), false],
          ['escape.png', false],
          ['missing.png', false],
        ] as const;
        for (const [index, [path, allowed]] of cases.entries()) {
          const id = `view-${index}`;
          engine.outputFile!(path, id);
          await expect
            .poll(() =>
              published().find(
                (event) =>
                  event.method === 'tool.completed' && event.toolCallId === id,
              ),
            )
            .toBeDefined();
          const event = published().find(
            (event) =>
              event.method === 'tool.completed' && event.toolCallId === id,
          );
          if (event?.method !== 'tool.completed')
            throw new Error('Missing tool completion');
          if (allowed)
            expect(event.attachments?.[0]?.dataUrl).toBe(IMAGE.dataUrl);
          else expect(event.attachments).toBeUndefined();
        }
        engine.complete();
        await settle(1);
      });
    } else {
      exempt(
        name,
        `EXEMPT host-file outputs — ${name} does not resolve engine-reported output paths into host files at this seam; Session Outputs workspace-file declarations belong to runtime/native-output-declaration, outside ProviderAdapterShape`,
      );
    }
  });
}
