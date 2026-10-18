import { AssertionError, ok as assertContract } from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  afterAll,
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

// #3834 asks whether concurrent sends must refuse, supersede, or overwrite.
// Until decided, pin each adapter's actual behavior without calling it a defect.
const concurrent = {
  codex: 'overwrite',
  bedrock: 'supersede',
  ollama: 'supersede',
} as const;
const attachmentGaps = new Set([
  'codex',
  'muse',
  'station-agent',
  'bedrock',
  'ollama',
]);

interface GapObservation {
  satisfied: boolean;
  healthy(): void;
}

/** Only this exact assertion may be inverted; setup/other failures must stay red. */
function knownGap(
  category: 'DEFECT' | 'HARDENING',
  name: string,
  failure: string,
  observe: () => Promise<GapObservation>,
) {
  describe(`${category}: ${name}`, () => {
    let observation: GapObservation | undefined;
    let preparationError: unknown;
    const unexpectedSignatures: unknown[] = [];
    afterAll(() => {
      expect(
        unexpectedSignatures,
        `Only the pinned gap assertion may fail: ${failure}`,
      ).toEqual([]);
    });
    beforeAll(() => {
      process.stdout.write(
        `[adapter-conformance] ${category}: ${name}; pinned failure: ${failure}\n`,
      );
    });
    beforeEach(async () => {
      observation = undefined;
      preparationError = undefined;
      try {
        observation = await observe();
      } catch (error) {
        preparationError = error;
      }
    });
    it('passing prerequisites remain normal assertions', () => {
      if (preparationError) throw preparationError;
      expect(observation).toBeDefined();
      observation!.healthy();
    });
    it.fails(`known gap: ${failure}`, async ({ annotate, onTestFinished }) => {
      // Vitest also inverts teardown errors. Audit the complete raw error list
      // after teardown, then assert it outside the it.fails inversion.
      onTestFinished(({ task }) => {
        const errors = task.result?.errors ?? [];
        if (
          errors.length !== 1 ||
          errors[0].name !== 'AssertionError' ||
          errors[0].message !== failure
        ) {
          unexpectedSignatures.push(
            errors.map(({ name, message }) => ({ name, message })),
          );
        }
      });
      if (preparationError || !observation) {
        await annotate(
          `Unexpected preparation failure: ${String(preparationError)}`,
        );
        return; // Unexpected success makes it.fails RED, never masks the error.
      }
      try {
        assertContract(observation.satisfied, failure);
      } catch (error) {
        if (error instanceof AssertionError && error.message === failure)
          throw error;
        await annotate(`Unexpected gap failure: ${String(error)}`);
        // A different error must also become an unexpected success (RED).
      }
    });
  });
}

function exempt(adapter: string, reason: string) {
  // The focused/default reporter hides skipped names. Emit every reason even there.
  beforeAll(() => {
    process.stdout.write(`[adapter-conformance] ${adapter}: ${reason}\n`);
  });
  it.skip(reason, () => {});
}

const registrations = [
  ...ADAPTERS.map((name) => ({
    name,
    label: name as string,
    transport: 'serve' as const,
  })),
  {
    name: 'muse' as const,
    label: 'muse exec fallback',
    transport: 'exec-fallback' as const,
  },
];
for (const { name, label, transport } of registrations) {
  describe(`ProviderAdapterShape conformance: ${label}`, () => {
    beforeAll(() => {
      if (name in concurrent)
        process.stdout.write(
          `[adapter-conformance] CONTRACT-UNDECIDED #3834: ${label} concurrent send = ${concurrent[name as keyof typeof concurrent]}\n`,
        );
      if (name === 'muse')
        process.stdout.write(
          `[adapter-conformance] Muse production transport: ${transport}\n`,
        );
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
      engine = createConformanceEngine(name, cwd, transport);
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

    const quiet = () => new Promise((resolve) => setTimeout(resolve, 30));
    const textAttributionIsValid = (
      late: CanonicalRuntimeEvent[],
      stoppedTurn: string,
    ) => {
      const all = published();
      return late.every(
        (event) =>
          event.turnId &&
          event.turnId !== stoppedTurn &&
          all
            .slice(0, all.indexOf(event))
            .some(
              (start) =>
                start.method === 'turn.started' &&
                start.turnId === event.turnId,
            ),
      );
    };
    const stop = async () => {
      const turn = await send();
      engine.text('before-stop');
      await expect.poll(() => texts().length).toBe(1);
      const result = await engine.adapter.interruptTurn(THREAD, turn.turnId);
      return { turn, result };
    };
    it('interrupt — target-specific cancellation reaches the engine and publishes its terminal before the captured engine response', async () => {
      const { turn, result } = await stop();
      expect(result).toEqual({ outcome: 'cancelled', turnId: turn.turnId });
      expect(engine.stopped(), 'stop reached the engine transport').toBe(true);
      await settle(1);
      expect(terminals()[0]).toMatchObject({
        method: 'turn.aborted',
        turnId: turn.turnId,
      });
      // Codex sends turn/completed status:interrupted; Claude emits its
      // error_during_execution result; ACP resolves prompt(stopReason:cancelled).
      engine.settleInterrupt();
      await quiet();
      if (name !== 'codex')
        expect(
          terminals().filter((event) => event.turnId === turn.turnId),
        ).toHaveLength(1);
      // Codex's duplicate after its captured response is isolated below.
      if (name !== 'claude' && name !== 'codex' && name !== 'acp') {
        // These transports already suppress old-turn output after stopping.
        // Keep their passing guard outside every known-gap inversion.
        engine.late();
        await quiet();
        expect(texts().map((event) => event.delta)).toEqual(['before-stop']);
        expect(
          terminals().filter((event) => event.turnId === turn.turnId),
        ).toHaveLength(1);
      }
    });

    if (name === 'claude') {
      it('interrupt — #2324 permits a NEW engine-opened turn after the interrupted result; every new delta has that started turn id', async () => {
        const { turn, result } = await stop();
        expect(result.outcome).toBe('cancelled');
        expect(engine.stopped()).toBe(true);
        engine.settleInterrupt();
        await quiet();
        const offset = published().length;
        engine.late();
        await expect.poll(() => started().length).toBe(2);
        await expect.poll(() => texts().length).toBe(2);
        const late = published()
          .slice(offset)
          .filter((event) => event.method === 'content.text-delta');
        expect(late).toHaveLength(1);
        expect(textAttributionIsValid(late, turn.turnId)).toBe(true);
        expect(started()[1].turnId).not.toBe(turn.turnId);
        expect(
          terminals().filter((event) => event.turnId === turn.turnId),
        ).toHaveLength(1);
        engine.complete();
        await settle(2);
      });
      knownGap(
        'DEFECT',
        'Claude text in the interrupt-ack/result window',
        'Claude must not publish text on the aborted turn between interrupt acknowledgement and result',
        async () => {
          // Match the capture: the client turn completes, then the engine
          // opens a task-notification turn of its own before it is interrupted.
          await send();
          engine.text('setup');
          engine.complete();
          await settle(1);
          engine.text('before-stop');
          await expect.poll(() => started().length).toBe(2);
          await expect.poll(() => texts().length).toBe(2);
          const providerStart = started()[1];
          const turn = { turnId: providerStart.turnId! };
          const result = await engine.adapter.interruptTurn(
            THREAD,
            turn.turnId,
          );
          const offset = published().length;
          engine.late();
          await quiet(); // The old message is still open: result withheld.
          const late = published()
            .slice(offset)
            .filter((event) => event.method === 'content.text-delta');
          engine.settleInterrupt();
          await quiet();
          return {
            satisfied: textAttributionIsValid(late, turn.turnId),
            healthy: () => {
              expect(result).toEqual({
                outcome: 'cancelled',
                turnId: turn.turnId,
              });
              expect(providerStart.metadata?.trigger).toBe('provider');
              expect(engine.inputs()).toHaveLength(1);
              expect(engine.stopped()).toBe(true);
              expect(
                terminals().filter((event) => event.turnId === turn.turnId),
              ).toHaveLength(1);
              expect(
                terminals().find((event) => event.turnId === turn.turnId),
              ).toMatchObject({
                method: 'turn.aborted',
                turnId: turn.turnId,
              });
            },
          };
        },
      );
    }
    if (name === 'codex') {
      knownGap(
        'DEFECT',
        'Codex duplicate terminal after captured interrupted notification',
        'Codex must publish only one terminal for the captured client interrupt sequence',
        async () => {
          const { turn, result } = await stop();
          const before = terminals().filter(
            (event) => event.turnId === turn.turnId,
          );
          engine.settleInterrupt();
          await quiet();
          const after = terminals().filter(
            (event) => event.turnId === turn.turnId,
          );
          return {
            satisfied: after.length === 1,
            healthy: () => {
              expect(result).toEqual({
                outcome: 'cancelled',
                turnId: turn.turnId,
              });
              expect(
                engine.stopped(),
                'stop reached the engine transport',
              ).toBe(true);
              expect(before).toEqual([
                expect.objectContaining({
                  method: 'turn.aborted',
                  turnId: turn.turnId,
                }),
              ]);
              expect(after.every((event) => event.turnId === turn.turnId)).toBe(
                true,
              );
            },
          };
        },
      );
    }
    if (name === 'codex') {
      knownGap(
        'HARDENING',
        'Codex adapter has no guard if the engine sends a late delta (not present in the three client-interrupt captures)',
        'Codex must suppress an engine delta for an already aborted turn',
        async () => {
          const { turn, result } = await stop();
          const initial = terminals().filter(
            (event) => event.turnId === turn.turnId,
          );
          engine.settleInterrupt();
          await quiet();
          const offset = published().length;
          engine.late();
          await quiet();
          const late = published()
            .slice(offset)
            .filter((event) => event.method === 'content.text-delta');
          return {
            satisfied: textAttributionIsValid(late, turn.turnId),
            healthy: () => {
              expect(result).toEqual({
                outcome: 'cancelled',
                turnId: turn.turnId,
              });
              expect(
                engine.stopped(),
                'stop reached the engine transport',
              ).toBe(true);
              expect(initial).toHaveLength(1);
              expect(terminals()[0]).toMatchObject({
                method: 'turn.aborted',
                turnId: turn.turnId,
              });
            },
          };
        },
      );
    }
    if (name === 'acp') {
      for (const phase of [
        'before prompt resolves',
        'after prompt resolves',
      ] as const) {
        knownGap(
          'DEFECT',
          `ACP unscoped post-cancel text ${phase}`,
          `ACP must attribute or suppress post-cancel text ${phase}`,
          async () => {
            const { turn, result } = await stop();
            if (phase === 'after prompt resolves') {
              engine.settleInterrupt();
              await quiet();
            }
            const offset = published().length;
            engine.late();
            await quiet();
            const late = published()
              .slice(offset)
              .filter((event) => event.method === 'content.text-delta');
            if (phase === 'before prompt resolves') {
              engine.settleInterrupt();
              await quiet();
            }
            return {
              satisfied:
                phase === 'before prompt resolves'
                  ? late.every((event) => event.turnId === turn.turnId)
                  : late.every(
                      (event) =>
                        event.turnId &&
                        started().some(
                          (start) => start.turnId === event.turnId,
                        ),
                    ),
              healthy: () => {
                expect(result).toEqual({
                  outcome: 'cancelled',
                  turnId: turn.turnId,
                });
                expect(engine.stopped()).toBe(true);
                expect(
                  terminals().filter((event) => event.turnId === turn.turnId),
                ).toHaveLength(1);
                expect(terminals()[0]).toMatchObject({
                  method: 'turn.aborted',
                  turnId: turn.turnId,
                });
              },
            };
          },
        );
      }
    }

    it(`concurrent send — #3834 actual behavior: ${name in concurrent ? concurrent[name as keyof typeof concurrent] : 'refuse'}`, async () => {
      const first = await send();
      const behavior =
        name in concurrent
          ? concurrent[name as keyof typeof concurrent]
          : 'refuse';
      const second = beginSend({
        threadId: THREAD,
        input: 'second concurrent send',
      });
      await expect
        .poll(() => second.settled || engine.inputs().length === 2)
        .toBe(true);
      if (behavior === 'refuse') {
        expect(second.error).toBeInstanceOf(SendTurnRefusedError);
        expect(engine.inputs()).toHaveLength(1);
        expect(started()).toHaveLength(1);
        expect(terminals()).toHaveLength(0);
        engine.complete();
        await settle(1);
      } else {
        expect(second.error).toBeUndefined();
        await expect.poll(() => started().length).toBe(2);
        expect(engine.inputs()).toHaveLength(2);
        const secondId = started()[1].turnId;
        expect(secondId).not.toBe(first.turnId);
        if (behavior === 'supersede')
          expect(terminals()).toEqual([
            expect.objectContaining({
              method: 'turn.aborted',
              turnId: first.turnId,
              reason: 'superseded',
            }),
          ]);
        else expect(terminals()).toHaveLength(0); // Codex overwrites its active pointer.
        engine.complete();
        await settle(behavior === 'supersede' ? 2 : 1);
        expect(terminals().at(-1)).toMatchObject({
          method: 'turn.completed',
          turnId: secondId,
        });
      }
    });

    if (name === 'claude') {
      exempt(
        name,
        'EXEMPT undeclared attachment — Claude declares both image-input and file-input; the contract has no third attachment kind',
      );
    } else {
      const observeAttachment = async () => {
        const attachment = engine.adapter.metadata.capabilities.includes(
          'image-input',
        )
          ? FILE
          : IMAGE;
        const refused = beginSend({
          threadId: THREAD,
          input: 'refuse',
          attachments: [attachment],
        });
        await expect
          .poll(() => refused.settled || engine.inputs().length > 0)
          .toBe(true);
        await quiet();
        return {
          refused,
          capability:
            attachment.kind === 'image' ? 'image-input' : 'file-input',
        };
      };
      if (attachmentGaps.has(name)) {
        knownGap(
          'DEFECT',
          `${label} unsupported attachment refusal`,
          `${label} must refuse undeclared attachments pre-effect with attachment_input_unsupported`,
          async () => {
            const { refused, capability } = await observeAttachment();
            const code =
              refused.error &&
              typeof refused.error === 'object' &&
              'code' in refused.error
                ? refused.error.code
                : undefined;
            return {
              satisfied:
                code === 'attachment_input_unsupported' &&
                engine.inputs().length === 0 &&
                started().length === 0,
              healthy: () => {
                expect(engine.adapter.metadata.capabilities).not.toContain(
                  capability,
                );
                if (name === 'codex' || name === 'muse') {
                  expect(refused.error).toBeInstanceOf(Error);
                  expect((refused.error as Error).message).toBe(
                    `${name === 'codex' ? 'Codex' : 'Muse Code'} cannot take non-image files. Paste the file's text into the message instead.`,
                  );
                  expect(engine.inputs()).toHaveLength(0);
                  expect(started()).toHaveLength(0);
                } else {
                  expect(refused.error).toBeUndefined();
                  expect(engine.inputs()).toHaveLength(1);
                  expect(started()).toHaveLength(1);
                }
              },
            };
          },
        );
      } else {
        it('capability refusal — AttachmentInputUnsupportedError is pre-effect and carries attachment_input_unsupported', async () => {
          const { refused, capability } = await observeAttachment();
          expect(engine.adapter.metadata.capabilities).not.toContain(
            capability,
          );
          expect(refused.error).toMatchObject({
            code: 'attachment_input_unsupported',
          });
          expect(engine.inputs()).toHaveLength(0);
          expect(started()).toHaveLength(0);
        });
      }
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

    if (
      name === 'claude' ||
      (name === 'muse' && transport === 'exec-fallback')
    ) {
      it('fixture fidelity — real adapter receives message/block framing or unique monotonic Muse records', async () => {
        await send();
        engine.text('one');
        engine.text('two');
        await expect.poll(() => texts().length).toBe(2);
        const messages = engine.wireMessages!();
        if (name === 'claude') {
          const kinds = messages
            .filter((message) => message.type === 'stream_event')
            .map((message) => (message.event as { type: string }).type);
          expect(kinds).toEqual([
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_delta',
          ]);
        } else {
          const records = messages.filter(
            (message) => message.payload_type === 'run.output.delta',
          );
          expect(records).toHaveLength(2);
          expect(new Set(records.map((record) => record.id)).size).toBe(2);
          expect(Number(records[1].sequence)).toBeGreaterThan(
            Number(records[0].sequence),
          );
        }
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
        expect(engine.stopped()).toBe(transport === 'serve');
        if (transport === 'serve') expect(terminals()).toHaveLength(0);
        engine.settleInterrupt();
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
        `EXEMPT host-path confinement — ${label}: ${name === 'claude' || name === 'acp' ? 'ToolCompletedEvent.attachments accepts engine-supplied inline bytes; no engine path is dereferenced by this projection. The inline-image allowlist/byte validation is separate from host-path confinement.' : 'this adapter does not dereference an engine-reported output path.'} Session Outputs workspace-file declarations are validated by the native output runtime, outside this seam.`,
      );
    }
  });
}
