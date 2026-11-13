/**
 * What an ACP engine's session and prompt answers carry, read through the real
 * seam: `AcpAdapter` launches the fake ACP agent (the ACP SDK's agent side)
 * through the real `ACPProcess`, driven by the profile recorded from
 * Antigravity CLI 1.5.8 (`fixtures/acp-scripted-profiles`). The behavior is
 * engine-agnostic; that engine is the recorded one that advertises
 * `session/resume`, a `thought_level` option and a prompt answer's `usage`.
 * What the engine received is read from the fake's own record.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { assembleTurnProvenanceEnvelopes } from '@kontourai/station-shared/turn-provenance-fold';
import { foldUsageEvents } from '@kontourai/station-shared/usage-fold';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { quietLogger, waitFor } from './acp-engine-qualification-harness.js';

const FAKE_AGENT = fileURLToPath(
  new URL('./fixtures/fake-acp-agent.mjs', import.meta.url),
);
const PROFILE: Record<string, unknown> = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/acp-scripted-profiles/antigravity-1.5.8.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

type Frame = {
  capture: string;
  dir: 'C->E' | 'E->C';
  msg: { id?: number; method?: string; params?: any; result?: any };
};
const FRAMES: Frame[] = readFileSync(
  fileURLToPath(
    new URL(
      '../../services/acp/__tests__/fixtures/antigravity-1.5.8-session-frames.jsonl',
      import.meta.url,
    ),
  ),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

/** A recorded frame, by capture and predicate; a missing one fails loudly. */
function frame(capture: string, match: (frame: Frame) => boolean): Frame {
  const found = FRAMES.find(
    (entry) => entry.capture === capture && match(entry),
  );
  if (!found) throw new Error(`No recorded frame in ${capture}`);
  return found;
}

const makeTempDir = trackTempDirs();
const CONNECTION_ID = 'engine-under-test';

type Recorded = Record<string, unknown>;

interface Engine {
  adapter: AcpAdapter;
  events: CanonicalRuntimeEvent[];
  record: () => Recorded[];
  start: (
    threadId: string,
    resumeCursor?: unknown,
    selection?: { modelId?: string; modelOptions?: Record<string, unknown> },
  ) => Promise<{ resumeCursor?: unknown }>;
  send: (
    threadId: string,
    input: string,
    modelOptions?: Record<string, unknown>,
  ) => Promise<string>;
  completed: (turnId: string) => Promise<CanonicalRuntimeEvent>;
  stop: () => Promise<void>;
}

const engines: Engine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
});

function launch(
  profile: Record<string, unknown>,
  promptSteps: unknown[],
): Engine {
  const dir = makeTempDir('station-acp-answers-');
  const profilePath = join(dir, 'profile.json');
  const recordPath = join(dir, 'record.jsonl');
  const stepsPath = join(dir, 'steps.json');
  writeFileSync(profilePath, JSON.stringify(profile));
  writeFileSync(recordPath, '');
  writeFileSync(stepsPath, JSON.stringify(promptSteps));
  const connection: ACPConnectionConfig = {
    id: CONNECTION_ID,
    name: 'Engine',
    command: process.execPath,
    args: [
      FAKE_AGENT,
      '--engine-profile',
      profilePath,
      '--record',
      recordPath,
      '--prompt-steps',
      stepsPath,
    ],
    enabled: true,
  };
  const adapter = new AcpAdapter({
    getConnections: async () => [connection],
    logger: quietLogger,
  });
  const events: CanonicalRuntimeEvent[] = [];
  const drained = (async () => {
    for await (const event of adapter.streamEvents()) events.push(event);
  })();
  const cwd = makeTempDir('station-acp-answers-cwd-');
  const engine: Engine = {
    adapter,
    events,
    record: () =>
      readFileSync(recordPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    start: async (threadId, resumeCursor, selection) =>
      (await adapter.startSession({
        provider: 'acp',
        threadId,
        cwd,
        confinement: 'workspace',
        metadata: { connectionId: CONNECTION_ID },
        ...(resumeCursor ? { resumeCursor } : {}),
        ...(selection?.modelId ? { modelId: selection.modelId } : {}),
        ...(selection?.modelOptions
          ? { modelOptions: selection.modelOptions }
          : {}),
      } as never)) as { resumeCursor?: unknown },
    send: async (threadId, input, modelOptions) =>
      (
        await adapter.sendTurn({
          provider: 'acp',
          threadId,
          input,
          confinement: 'workspace',
          ...(modelOptions ? { modelOptions } : {}),
        } as never)
      ).turnId,
    completed: (turnId) =>
      waitFor(
        () =>
          events.find(
            (event) =>
              event.method === 'turn.completed' &&
              (event as { turnId?: string }).turnId === turnId,
          ),
        `turn.completed ${turnId}`,
      ),
    stop: async () => {
      await adapter.stopAll();
      await drained;
    },
  };
  engines.push(engine);
  return engine;
}

const TEXT_TURN = [{ kind: 'text', text: 'ok' }];

describe.skipIf(process.platform === 'win32')(
  'ACP session and prompt answers (real process, recorded Antigravity 1.5.8 profile)',
  () => {
    test('a reopened session gets its model and effort back when the engine resumes on its defaults', async () => {
      // The fake keeps options per process, so like Antigravity 1.5.8 (whose
      // reattached conversation came back on the account default model) a
      // relaunched engine resumes on the profile's defaults: model
      // `gemini-4-argon`, thinking `medium`.
      const selection = {
        modelId: 'gemini-3.8-flash',
        modelOptions: { effort: 'low', mode: 'plan' },
      };
      const engine = launch(PROFILE, TEXT_TURN);
      const first = await engine.start('again', undefined, selection);
      await engine.adapter.stopSession('again');
      const before = engine.record().length;

      await engine.start('again', first.resumeCursor, selection);
      const afterReopen = engine.record().slice(before);
      // Mode first, as at a fresh start (a mode can carry its own model).
      expect(
        afterReopen.map((entry) =>
          entry.method === 'session/set_config_option'
            ? entry.configId
            : entry.method === 'session/set_mode'
              ? `mode:${entry.modeId}`
              : entry.method,
        ),
      ).toEqual([
        'initialize',
        'session/resume',
        expect.stringMatching(/^(mode|mode:plan)$/),
        'model',
        'thought_level',
      ]);
      // The reopen's own `session.configured` (the start's is the first),
      // saying what the engine now runs, not only what was asked for.
      const configured = (await waitFor(
        () =>
          engine.events.filter(
            (event) => event.method === 'session.configured',
          )[1],
        'the reopen session.configured',
      )) as { metadata?: Record<string, unknown> };
      expect(configured.metadata?.reportedModel).toBe('gemini-3.8-flash');
      expect(configured.metadata).toMatchObject({
        acpSessionMode: 'plan',
      });
    });

    test('a reopen whose effort the resumed session does not offer is skipped, not refused', async () => {
      const engine = launch(PROFILE, TEXT_TURN);
      const first = await engine.start('skip', undefined, {
        modelOptions: { effort: 'low' },
      });
      await engine.adapter.stopSession('skip');
      const before = engine.record().length;
      // `max` is not among the recorded options (low, medium, high).
      await engine.start('skip', first.resumeCursor, {
        modelOptions: { effort: 'max' },
      });
      expect(
        engine
          .record()
          .slice(before)
          .map((entry) => entry.method),
      ).toEqual(['initialize', 'session/resume']);
      // Nor is it reported as in effect.
      const configured = (await waitFor(
        () =>
          engine.events.filter(
            (event) => event.method === 'session.configured',
          )[1],
        'the reopen session.configured',
      )) as { metadata?: Record<string, unknown> };
      expect(
        configured.metadata?.effectiveModelOptions ?? {},
      ).not.toHaveProperty('effort');
    });

    test('a reopened session that already has its model and effort is not set again', async () => {
      const selection = {
        modelId: 'gemini-4-argon',
        modelOptions: { effort: 'medium' },
      };
      const engine = launch(PROFILE, TEXT_TURN);
      const first = await engine.start('same', undefined, selection);
      await engine.adapter.stopSession('same');
      const before = engine.record().length;

      await engine.start('same', first.resumeCursor, selection);
      expect(
        engine
          .record()
          .slice(before)
          .map((entry) => entry.method),
      ).toEqual(['initialize', 'session/resume']);
    });

    test('a reopened session changes mode and effort through what its resume answer advertised', async () => {
      // The recorded engine answers `session/resume` with the same modes and
      // config options as `session/new` (capture `subagent-cancel-resume-load`,
      // answer id 7).
      const resumed = frame(
        'subagent-cancel-resume-load',
        (entry) => entry.dir === 'E->C' && entry.msg.id === 7,
      ).msg.result;
      expect(
        resumed.configOptions.map((option: { id: string }) => option.id),
      ).toEqual(['model', 'thought_level', 'mode']);

      const engine = launch(PROFILE, TEXT_TURN);
      const first = await engine.start('reopen');
      await engine.adapter.stopSession('reopen');
      const configuredBefore = engine.events.filter(
        (event) => event.method === 'session.configured',
      ).length;

      await engine.start('reopen', first.resumeCursor);
      expect(
        engine.record().filter((entry) => entry.method === 'session/resume'),
      ).toHaveLength(1);
      expect(
        engine.record().some((entry) => entry.method === 'session/load'),
      ).toBe(false);
      const reopened = await waitFor(
        () =>
          engine.events.filter(
            (event) => event.method === 'session.configured',
          )[configuredBefore],
        'session.configured after resume',
      );
      expect(
        (reopened as { metadata?: Record<string, unknown> }).metadata,
      ).toMatchObject({
        acpSessionMode: 'default',
        acpSessionModes: expect.arrayContaining([
          expect.objectContaining({ id: 'plan' }),
        ]),
      });

      const setBefore = engine
        .record()
        .filter((entry) => entry.method === 'session/set_config_option').length;
      const turnId = await engine.send('reopen', 'plan it', {
        mode: 'plan',
        effort: 'high',
      });
      await engine.completed(turnId);
      expect(
        engine
          .record()
          .filter((entry) => entry.method === 'session/set_config_option')
          .slice(setBefore)
          .map((entry) => entry.configId),
      ).toEqual(['mode', 'thought_level']);
      expect(
        engine.events.find((event) => event.method === 'runtime.error'),
      ).toBeUndefined();
    });

    test("an engine not recorded reporting per-turn usage has its answer's usage left unpublished", async () => {
      // Same recorded answer, but the handshake names another engine: its
      // figures could be session totals, so none are summed as a turn's.
      const answer = frame(
        'station-capabilities-turn',
        (entry) => entry.dir === 'E->C' && entry.msg.id === 5,
      ).msg.result;
      const initialize = PROFILE.initialize as Record<string, unknown>;
      const engine = launch(
        {
          ...PROFILE,
          initialize: {
            ...initialize,
            agentInfo: { name: 'Another ACP Engine', version: '1.0.0' },
          },
          promptResponse: { usage: answer.usage },
        },
        TEXT_TURN,
      );
      await engine.start('other');
      const turnId = await engine.send('other', 'hi');
      await engine.completed(turnId);
      expect(
        engine.events.filter(
          (event) =>
            event.method === 'token-usage.updated' &&
            'promptTokens' in (event as object),
        ),
      ).toEqual([]);
    });

    test("a prompt answer's usage is that turn's token usage, beside the context pair", async () => {
      // The first turn of capture `station-capabilities-turn`: its last
      // `usage_update` and the `usage` its prompt answer carried.
      const answer = frame(
        'station-capabilities-turn',
        (entry) => entry.dir === 'E->C' && entry.msg.id === 5,
      ).msg.result;
      const contextUpdate = frame(
        'station-capabilities-turn',
        (entry) =>
          entry.msg.params?.update?.sessionUpdate === 'usage_update' &&
          entry.msg.params.update.used === 8340,
      ).msg.params.update;
      expect(answer.usage).toEqual({
        inputTokens: 10377,
        outputTokens: 48,
        cachedReadTokens: 6170,
        cachedWriteTokens: 0,
        thoughtTokens: 0,
        totalTokens: 16595,
      });

      const engine = launch(
        { ...PROFILE, promptResponse: { usage: answer.usage } },
        [
          { kind: 'update', update: contextUpdate },
          { kind: 'text', text: 'red, blue' },
        ],
      );
      await engine.start('usage');
      const turnId = await engine.send('usage', 'Which color?');
      await engine.completed(turnId);

      const turnEvents = engine.events.filter(
        (event) => (event as { turnId?: string }).turnId === turnId,
      );
      const usage = turnEvents.filter(
        (event) => event.method === 'token-usage.updated',
      );
      expect(usage).toHaveLength(2);
      expect(usage[0]).toMatchObject({
        contextTokens: 8340,
        contextWindowTokens: 1048576,
      });
      expect(usage[0]).not.toHaveProperty('promptTokens');
      const reported = usage[1];
      expect(reported).toMatchObject({
        provider: 'acp',
        promptTokens: 10377,
        completionTokens: 48,
        totalTokens: 16595,
        cacheReadTokens: 6170,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      });
      for (const absent of [
        'contextTokens',
        'contextWindowTokens',
        'reportedCost',
        'reportedCostUsd',
      ])
        expect(reported).not.toHaveProperty(absent);
      // Published before the turn ends, so the turn's record holds it.
      expect(turnEvents.indexOf(usage[1])).toBeLessThan(
        turnEvents.findIndex((event) => event.method === 'turn.completed'),
      );

      // The session fold counts it once and keeps the context pair.
      expect(foldUsageEvents(engine.events)).toMatchObject({
        inputTokens: 10377,
        outputTokens: 48,
        totalTokens: 16595,
        cacheReadTokens: 6170,
        contextTokens: 8340,
        contextWindowTokens: 1048576,
      });
      // And the turn's own provenance reads it as this turn's usage.
      const envelope = assembleTurnProvenanceEnvelopes(engine.events).find(
        (entry) => entry.turnId === turnId,
      );
      expect(envelope?.usage).toMatchObject({
        state: 'observed',
        value: { inputTokens: 10377, outputTokens: 48, totalTokens: 16595 },
      });
    });
  },
);
