/**
 * Kiro parity through the real seam: `AcpAdapter` launches the fake ACP agent
 * (the ACP SDK's agent side) through the real `ACPProcess`, driven by a
 * profile recorded from kiro-cli (`fixtures/acp-scripted-profiles`). What the
 * engine received and what Station answered its requests with are read from
 * the fake's own record, not from Station's side.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { ResolvedAgentDefinition } from '@kontourai/station-contracts/provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import {
  KIRO_USER_INPUT_DECLINED_ANSWER,
  KIRO_USER_INPUT_NO_PERSON_ANSWER,
} from '../adapters/acp-input-requests.js';
import { quietLogger, waitFor } from './acp-engine-qualification-harness.js';

const FAKE_AGENT = fileURLToPath(
  new URL('./fixtures/fake-acp-agent.mjs', import.meta.url),
);
const profileOf = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          `./fixtures/acp-scripted-profiles/${name}.json`,
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  );

const makeTempDir = trackTempDirs();
const CONNECTION_ID = 'kiro-under-test';

type Recorded = Record<string, unknown>;

interface Engine {
  adapter: AcpAdapter;
  events: CanonicalRuntimeEvent[];
  record: () => Recorded[];
  start: (
    threadId: string,
    extra?: {
      agent?: ResolvedAgentDefinition;
      resumeCursor?: unknown;
      modelId?: string;
    },
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
  promptSteps?: unknown[],
  adapterOptions: {
    logger?: unknown;
    rewindAnswerTimeoutMs?: number;
    rewindLateAnswerTimeoutMs?: number;
  } = {},
): Engine {
  const dir = makeTempDir('station-acp-kiro-');
  const profilePath = join(dir, 'profile.json');
  const recordPath = join(dir, 'record.jsonl');
  writeFileSync(profilePath, JSON.stringify(profile));
  writeFileSync(recordPath, '');
  const args = [FAKE_AGENT, '--engine-profile', profilePath];
  args.push('--record', recordPath);
  if (promptSteps) {
    const stepsPath = join(dir, 'steps.json');
    writeFileSync(stepsPath, JSON.stringify(promptSteps));
    args.push('--prompt-steps', stepsPath);
  }
  const connection: ACPConnectionConfig = {
    id: CONNECTION_ID,
    name: 'Kiro',
    command: process.execPath,
    args,
    enabled: true,
  };
  const adapter = new AcpAdapter({
    getConnections: async () => [connection],
    logger: quietLogger,
    ...adapterOptions,
  } as ConstructorParameters<typeof AcpAdapter>[0]);
  const events: CanonicalRuntimeEvent[] = [];
  const drained = (async () => {
    for await (const event of adapter.streamEvents()) events.push(event);
  })();
  const cwd = makeTempDir('station-acp-kiro-cwd-');
  const engine: Engine = {
    adapter,
    events,
    record: () =>
      readFileSync(recordPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    start: async (threadId, extra = {}) =>
      (await adapter.startSession({
        provider: 'acp',
        threadId,
        cwd,
        confinement: 'workspace',
        metadata: { connectionId: CONNECTION_ID },
        ...(extra.agent ? { agent: extra.agent } : {}),
        ...(extra.resumeCursor ? { resumeCursor: extra.resumeCursor } : {}),
        ...(extra.modelId ? { modelId: extra.modelId } : {}),
      } as never)) as { resumeCursor?: unknown },
    send: async (threadId, input, modelOptions) =>
      (
        await adapter.sendTurn({
          provider: 'acp',
          threadId,
          input,
          ...(modelOptions ? { modelOptions } : {}),
          confinement: 'workspace',
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

const answersTo = (records: Recorded[], method: string) =>
  records.filter((entry) => entry.clientRequest === method);

const opened = (engine: Engine) =>
  waitFor(
    () =>
      engine.events.find((event) => event.method === 'request.opened') as
        | (CanonicalRuntimeEvent & {
            requestId: string;
            eventId: string;
            payload: { inputRequest: Record<string, unknown> };
          })
        | undefined,
    'request.opened',
  );

const turnText = (engine: Engine, turnId: string) =>
  engine.events
    .filter(
      (event) =>
        event.method === 'content.text-delta' &&
        (event as { turnId?: string }).turnId === turnId,
    )
    .map((event) => (event as { delta: string }).delta)
    .join('');

const userInput = {
  kind: 'client-request',
  method: '_kiro/userInput',
  params: {
    sessionId: '$sessionId',
    toolCallId: 'tool-1',
    question: 'Delete the build folder?',
    options: [
      { title: 'Yes', recommended: true },
      { title: 'No', description: 'Keep it' },
    ],
  },
};

describe.skipIf(process.platform === 'win32')(
  'Kiro parity (real process, recorded kiro-cli profile)',
  () => {
    test('initialize announces exactly the client capabilities Station answers', async () => {
      const engine = launch(profileOf('kiro-v3'));
      await engine.start('announce');
      const init = engine
        .record()
        .find((entry) => entry.method === 'initialize');
      expect(init?.clientMeta).toEqual({
        kiro: { userInput: true, openExternalUrl: true },
      });
      expect(init?.clientElicitation).toEqual({ form: {}, url: {} });
    });

    test('`_kiro/terminal/shell_type` during session/new is answered with the bridge grammar', async () => {
      const engine = launch(profileOf('kiro-v3'));
      await engine.start('shell');
      expect(answersTo(engine.record(), '_kiro/terminal/shell_type')).toEqual([
        {
          clientRequest: '_kiro/terminal/shell_type',
          phase: 'session/new',
          result: { shellType: 'sh' },
        },
      ]);
    });

    test('a declined `_kiro/userInput` answers `answered` with text that is not agreement', async () => {
      const engine = launch(profileOf('kiro-v3'), [userInput]);
      await engine.start('decline');
      const turnId = await engine.send('decline', 'Clean up');
      const asked = await opened(engine);
      expect(asked.payload.inputRequest).toMatchObject({
        source: 'harness:Kiro',
        message: 'Delete the build folder?',
        body: {
          kind: 'form',
          fields: [
            {
              name: 'answer',
              kind: 'choice',
              allowCustom: true,
              options: [
                { value: 'Yes', label: 'Yes (recommended)' },
                { value: 'No', label: 'No', description: 'Keep it' },
              ],
            },
          ],
        },
      });
      await engine.adapter.respondToRequest(
        'decline',
        asked.requestId,
        'decline',
        { expectedRequestEventId: asked.eventId } as never,
      );
      await engine.completed(turnId);
      expect(answersTo(engine.record(), '_kiro/userInput')).toEqual([
        {
          clientRequest: '_kiro/userInput',
          phase: 'prompt',
          result: {
            action: 'answered',
            answer: KIRO_USER_INPUT_DECLINED_ANSWER,
          },
        },
      ]);
    });

    test('an accepted `_kiro/userInput` sends the chosen option, or the person’s own words', async () => {
      const engine = launch(profileOf('kiro-v3'), [userInput, userInput]);
      await engine.start('accept');
      const turnId = await engine.send('accept', 'Clean up');
      const first = await opened(engine);
      await engine.adapter.respondToRequest(
        'accept',
        first.requestId,
        'accept',
        {
          expectedRequestEventId: first.eventId,
          inputContent: { answer: 'Yes' },
        } as never,
      );
      const second = await waitFor(
        () =>
          engine.events.filter(
            (event) => event.method === 'request.opened',
          )[1] as
            | (CanonicalRuntimeEvent & { requestId: string; eventId: string })
            | undefined,
        'second request.opened',
      );
      await engine.adapter.respondToRequest(
        'accept',
        second.requestId,
        'accept',
        {
          expectedRequestEventId: second.eventId,
          inputContent: { answer: { custom: 'Only the cache' } },
        } as never,
      );
      await engine.completed(turnId);
      expect(
        answersTo(engine.record(), '_kiro/userInput').map(
          (entry) => entry.result,
        ),
      ).toEqual([
        { action: 'answered', answer: 'Yes' },
        { action: 'answered', answer: 'Only the cache' },
      ]);
    });

    test('a stopped session answers an open `_kiro/userInput` as unanswered, never as consent', async () => {
      const engine = launch(profileOf('kiro-v3'), [userInput]);
      await engine.start('stop');
      const turnId = await engine.send('stop', 'Clean up');
      await opened(engine);
      await engine.adapter.interruptTurn('stop', turnId);
      await waitFor(
        () => answersTo(engine.record(), '_kiro/userInput')[0],
        'userInput answer',
      );
      expect(answersTo(engine.record(), '_kiro/userInput')[0]?.result).toEqual({
        action: 'answered',
        answer: KIRO_USER_INPUT_NO_PERSON_ANSWER,
      });
    });

    test('an elicitation Station cannot show is declined without asking, never answered with an error', async () => {
      const engine = launch(profileOf('kiro-v3'), [
        {
          kind: 'client-request',
          method: '_kiro/mcp/elicitation',
          params: {
            sessionId: '$sessionId',
            toolCallId: 'tool-1',
            elicitation: {
              message: 'Describe the target',
              requestedSchema: {
                type: 'object',
                properties: {
                  target: {
                    type: 'object',
                    properties: { host: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
        {
          kind: 'client-request',
          method: 'elicitation/create',
          params: {
            sessionId: '$sessionId',
            mode: 'url',
            message: 'Sign in',
            elicitationId: 'e-1',
            url: 'http://insecure.invalid/authorize',
          },
        },
        { kind: 'text', text: 'done' },
      ]);
      await engine.start('unreadable');
      const turnId = await engine.send('unreadable', 'Go');
      await engine.completed(turnId);
      const records = engine.record();
      expect(answersTo(records, '_kiro/mcp/elicitation')[0]?.result).toEqual({
        action: 'decline',
      });
      expect(answersTo(records, 'elicitation/create')[0]?.result).toEqual({
        action: 'decline',
      });
      expect(
        engine.events.some((event) => event.method === 'request.opened'),
      ).toBe(false);
    });

    test('a declared command runs as its request; the same command undeclared stays prompt text', async () => {
      const declared = launch(profileOf('kiro-v3'));
      await declared.start('declared');
      const turnId = await declared.send('declared', '/context');
      await declared.completed(turnId);
      expect(
        declared
          .record()
          .find((entry) => entry.extMethod === '_kiro/session/context'),
      ).toMatchObject({ params: { subcommand: 'show' } });
      expect(
        declared.record().some((entry) => entry.method === 'session/prompt'),
      ).toBe(false);
      expect(turnText(declared, turnId)).toContain('"breakdown"');

      const profile = profileOf('kiro-v3');
      const initialize = profile.initialize as {
        agentCapabilities: { _meta: { kiro: { extensionMethods: string[] } } };
      };
      initialize.agentCapabilities._meta.kiro.extensionMethods =
        initialize.agentCapabilities._meta.kiro.extensionMethods.filter(
          (method) => method !== '_kiro/session/context',
        );
      const undeclared = launch(profile, [{ kind: 'text', text: 'ok' }]);
      await undeclared.start('undeclared');
      const other = await undeclared.send('undeclared', '/context');
      await undeclared.completed(other);
      expect(
        undeclared.record().some((entry) => entry.extMethod !== undefined),
      ).toBe(false);
      expect(
        undeclared.record().find((entry) => entry.method === 'session/prompt'),
      ).toMatchObject({ prompt: [{ type: 'text', text: '/context' }] });
    });

    test('kiro-cli runs its own command over commands/execute; a -32601 falls back to prompt text', async () => {
      const answered = launch(profileOf('kiro-v2'));
      await answered.start('v2');
      const turnId = await answered.send('v2', '/help');
      await answered.completed(turnId);
      expect(
        answered
          .record()
          .find((entry) => entry.extMethod === '_kiro.dev/commands/execute'),
      ).toMatchObject({
        params: { command: { command: 'help', args: {} } },
      });
      expect(turnText(answered, turnId)).toContain('Available Commands');
      expect(
        answered.record().some((entry) => entry.method === 'session/prompt'),
      ).toBe(false);

      const refusing = { ...profileOf('kiro-v2'), extMethodAnswers: {} };
      const fallback = launch(refusing, [{ kind: 'text', text: 'ok' }]);
      await fallback.start('v2-fallback');
      const other = await fallback.send('v2-fallback', '/help');
      await fallback.completed(other);
      const records = fallback.record();
      const executed = records.findIndex(
        (entry) => entry.extMethod === '_kiro.dev/commands/execute',
      );
      const prompted = records.findIndex(
        (entry) => entry.method === 'session/prompt',
      );
      expect(executed).toBeGreaterThanOrEqual(0);
      expect(prompted).toBeGreaterThan(executed);
      expect(records[prompted]).toMatchObject({
        prompt: [{ type: 'text', text: '/help' }],
      });
    });

    test('`/tools trust-all` reaches the engine neither as a command nor as a prompt', async () => {
      const engine = launch(profileOf('kiro-v2'), [
        { kind: 'text', text: 'ok' },
      ]);
      await engine.start('trust-all');
      const turnId = await engine.send('trust-all', '/tools trust-all');
      await engine.completed(turnId);
      const records = engine.record();
      expect(records.some((entry) => entry.extMethod !== undefined)).toBe(
        false,
      );
      expect(records.some((entry) => entry.method === 'session/prompt')).toBe(
        false,
      );
      expect(turnText(engine, turnId)).toContain(
        'Station runs only the read-only forms of /tools',
      );
      // The read-only form still runs as kiro-cli's own command.
      const listed = await engine.send('trust-all', '/tools');
      await engine.completed(listed);
      expect(
        engine
          .record()
          .find((entry) => entry.extMethod === '_kiro.dev/commands/execute'),
      ).toMatchObject({ params: { command: { command: 'tools' } } });
    });

    test('the session agent is sent as a client agent on session/new and again on load', async () => {
      const agent = { slug: 'reviewer' } as ResolvedAgentDefinition;
      const engine = launch(profileOf('kiro-v3'));
      const session = await engine.start('agent', { agent });
      const expected = {
        kiro: {
          customAgents: [
            {
              id: 'station-reviewer',
              description: 'Station agent reviewer',
              prompt: '',
              tools: ['*'],
            },
          ],
          modeId: 'station-reviewer',
        },
      };
      expect(
        engine.record().find((entry) => entry.method === 'session/new')?.meta,
      ).toEqual(expected);
      expect(
        await waitFor(
          () =>
            engine.events.find(
              (event) => event.method === 'session.configured',
            ),
          'session.configured',
        ),
      ).toMatchObject({ metadata: { acpSessionMode: 'station-reviewer' } });
      expect(
        engine.events.some(
          (event) =>
            (event as { code?: string }).code ===
            'acp.agent-projection-unapplied',
        ),
      ).toBe(false);
      await engine.adapter.stopSession('agent');

      await engine.start('agent', {
        agent,
        resumeCursor: session.resumeCursor,
      });
      expect(
        engine.record().find((entry) => entry.method === 'session/load')?.meta,
      ).toEqual(expected);
    });

    test('a model option the engine sends after answering session/new is waited for, not refused', async () => {
      // kiro-cli 3.3.0, Station UI start with model `auto`: one start in two
      // was refused model_not_advertised (dev Station, 2026-11-13).
      const engine = launch({
        ...profileOf('kiro-v3'),
        lateModelOptionMs: 300,
      });
      await engine.start('late-model', { modelId: 'auto' });
      expect(
        engine
          .record()
          .find(
            (entry) =>
              entry.method === 'session/set_config_option' &&
              entry.configId === 'model',
          ),
      ).toBeDefined();
      expect(
        engine.events.find((event) => event.method === 'runtime.error'),
      ).toBeUndefined();
    });

    test('an MCP report from an engine that can reconnect says so', async () => {
      const engine = launch(profileOf('kiro-v3'), [
        {
          kind: 'notification',
          method: '_kiro/mcp/status',
          params: {
            sessionId: '$sessionId',
            servers: [{ name: 'docs', status: 'connected' }],
          },
        },
        { kind: 'text', text: 'ok' },
      ]);
      await engine.start('mcp-reconnect');
      await engine.completed(await engine.send('mcp-reconnect', 'go'));
      const report = await waitFor(
        () =>
          engine.events.find((event) => event.method === 'engine-mcp.status'),
        'engine-mcp.status',
      );
      expect(report).toMatchObject({ reconnect: true });
    });

    test('rewind is refused mid-turn, rewinds to before the chosen turn after it, and refuses a turn it already hid', async () => {
      const engine = launch(
        {
          ...profileOf('kiro-v3'),
          extMethodAnswers: {
            ...(profileOf('kiro-v3').extMethodAnswers as Record<
              string,
              unknown
            >),
            '_kiro/checkpoint/revertMultiple': {
              result: {
                success: true,
                affectedFiles: ['src/a.ts', 'src/b.ts'],
                totalFiles: 2,
              },
            },
          },
        },
        [
          { kind: 'user-message-id' },
          { kind: 'wait-ms', ms: 400 },
          { kind: 'text', text: 'ok' },
        ],
      );
      await engine.start('rewind');
      const first = await engine.send('rewind', 'one');
      // `sendTurn` has returned, so the turn is running.
      expect(await engine.adapter.rewindSession('rewind', first)).toEqual({
        kind: 'refused',
        reason: 'turn-running',
      });
      await engine.completed(first);
      const second = await engine.send('rewind', 'two');
      await engine.completed(second);
      expect(
        await engine.adapter.rewindSession('rewind', 'never-sent'),
      ).toEqual({ kind: 'refused', reason: 'unknown-turn' });
      expect(
        engine
          .record()
          .some(
            (entry) => entry.extMethod === '_kiro/checkpoint/revertMultiple',
          ),
      ).toBe(false);

      expect(await engine.adapter.rewindSession('rewind', second)).toEqual({
        kind: 'rewound',
        beforeTurnId: second,
        hiddenTurnIds: [second],
        affectedFiles: { count: 2, paths: ['src/a.ts', 'src/b.ts'] },
      });
      expect(
        engine
          .record()
          .find(
            (entry) => entry.extMethod === '_kiro/checkpoint/revertMultiple',
          ),
      ).toMatchObject({ params: { messageId: 'msg-2' } });
      expect(
        await waitFor(
          () =>
            engine.events.find(
              (event) =>
                (event as { code?: string }).code === 'acp.session-rewound',
            ),
          'rewind marker',
        ),
      ).toMatchObject({
        details: {
          beforeTurnId: second,
          hiddenTurnIds: [second],
          affectedFileCount: 2,
        },
      });
      // The hidden turn is no longer a rewind point.
      expect(await engine.adapter.rewindSession('rewind', second)).toEqual({
        kind: 'refused',
        reason: 'unknown-turn',
      });
    });

    test('no turn starts while a rewind waits on the engine, and the rewind hides only what it was asked to', async () => {
      const engine = launch(
        {
          ...profileOf('kiro-v3'),
          extMethodAnswers: {
            ...(profileOf('kiro-v3').extMethodAnswers as Record<
              string,
              unknown
            >),
            '_kiro/checkpoint/revertMultiple': {
              delayMs: 800,
              result: { success: true, affectedFiles: [], totalFiles: 0 },
            },
          },
        },
        [{ kind: 'user-message-id' }, { kind: 'text', text: 'ok' }],
      );
      await engine.start('rewind-race');
      const first = await engine.send('rewind-race', 'one');
      await engine.completed(first);
      const rewinding = engine.adapter.rewindSession('rewind-race', first);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(engine.send('rewind-race', 'two')).rejects.toMatchObject({
        name: 'SessionRewindingError',
        kind: 'busy',
        code: 'provider_turn_in_progress',
        message:
          'Station is rewinding this conversation; send again when it finishes.',
      });
      expect(await rewinding).toMatchObject({
        kind: 'rewound',
        hiddenTurnIds: [first],
      });
      expect(
        engine.record().filter((entry) => entry.method === 'session/prompt'),
      ).toHaveLength(1);
      // Once the engine answered, the session takes turns again.
      await engine.completed(await engine.send('rewind-race', 'three'));
    });

    test('a rewind asked while a send is still preparing its turn is refused, and the send goes on', async () => {
      const engine = launch(
        {
          ...profileOf('kiro-v3'),
          requestDelaysMs: {
            'session/set_mode': 800,
            'session/set_config_option': 800,
          },
        },
        [{ kind: 'user-message-id' }, { kind: 'text', text: 'ok' }],
      );
      await engine.start('rewind-prep');
      const first = await engine.send('rewind-prep', 'one');
      await engine.completed(first);
      // The send waits on its mode change (a preparation that may as well
      // be an engine relaunch) when the rewind is asked.
      const sending = engine.send('rewind-prep', 'two', { mode: 'spec' });
      await waitFor(
        () =>
          engine
            .record()
            .some(
              (entry) =>
                entry.method === 'session/set_mode' ||
                entry.method === 'session/set_config_option',
            )
            ? true
            : undefined,
        'mode change reached the engine',
      );
      expect(await engine.adapter.rewindSession('rewind-prep', first)).toEqual({
        kind: 'refused',
        reason: 'send-preparing',
      });
      await engine.completed(await sending);
      expect(
        engine
          .record()
          .some(
            (entry) => entry.extMethod === '_kiro/checkpoint/revertMultiple',
          ),
      ).toBe(false);
    });

    test('a rewind the engine never answers fails in time, marks nothing, and frees the session', async () => {
      const engine = launch(
        {
          ...profileOf('kiro-v3'),
          extMethodAnswers: {
            ...(profileOf('kiro-v3').extMethodAnswers as Record<
              string,
              unknown
            >),
            '_kiro/checkpoint/revertMultiple': {
              delayMs: 600_000,
              result: { success: true, affectedFiles: [], totalFiles: 0 },
            },
          },
        },
        [{ kind: 'user-message-id' }, { kind: 'text', text: 'ok' }],
        { rewindAnswerTimeoutMs: 300 },
      );
      await engine.start('rewind-silent');
      const first = await engine.send('rewind-silent', 'one');
      await engine.completed(first);
      expect(
        await engine.adapter.rewindSession('rewind-silent', first),
      ).toEqual({
        kind: 'failed',
        message:
          'Kiro did not answer the rewind in time. Nothing is marked rewound yet; if the engine applies it later, the conversation says so.',
      });
      expect(
        engine.events.some(
          (event) =>
            (event as { code?: string }).code === 'acp.session-rewound',
        ),
      ).toBe(false);
      // The session takes turns again, and the turn is still a rewind point.
      await engine.completed(await engine.send('rewind-silent', 'two'));
      expect(engine.adapter.sessionContinuity('rewind-silent')).toMatchObject({
        live: true,
        rewind: 'in-place',
      });
    });

    // The engine answers the revert after the rewind's deadline.
    const lateRewindProfile = () => ({
      ...profileOf('kiro-v3'),
      extMethodAnswers: {
        ...(profileOf('kiro-v3').extMethodAnswers as Record<string, unknown>),
        '_kiro/checkpoint/revertMultiple': {
          delayMs: 1500,
          result: { success: true, affectedFiles: ['src/a.ts'], totalFiles: 1 },
        },
      },
    });
    const rewoundEvents = (engine: Engine, code: string) =>
      engine.events.filter(
        (event) => (event as { code?: string }).code === code,
      );

    test('a late rewind with no turn since is applied as on time, and no second rewind starts while it is pending', async () => {
      const engine = launch(
        lateRewindProfile(),
        [{ kind: 'user-message-id' }, { kind: 'text', text: 'ok' }],
        { rewindAnswerTimeoutMs: 200 },
      );
      await engine.start('late-quiet');
      const first = await engine.send('late-quiet', 'one');
      await engine.completed(first);
      expect(
        await engine.adapter.rewindSession('late-quiet', first),
      ).toMatchObject({ kind: 'failed' });
      // Still with the engine: a second rewind is refused, not sent.
      expect(await engine.adapter.rewindSession('late-quiet', first)).toEqual({
        kind: 'refused',
        reason: 'rewind-pending',
      });
      expect(
        engine
          .record()
          .filter(
            (entry) => entry.extMethod === '_kiro/checkpoint/revertMultiple',
          ),
      ).toHaveLength(1);
      expect(
        await waitFor(
          () => rewoundEvents(engine, 'acp.session-rewound')[0],
          'late rewind marker',
        ),
      ).toMatchObject({
        details: {
          beforeTurnId: first,
          hiddenTurnIds: [first],
          affectedFileCount: 1,
        },
      });
      // The ledger was cut: the hidden turn is no longer a rewind point.
      expect(await engine.adapter.rewindSession('late-quiet', first)).toEqual({
        kind: 'refused',
        reason: 'unknown-turn',
      });
    });

    test('a late rewind after a later turn is a warning, logged, and leaves the ledger as it was', async () => {
      const warn = vi.fn();
      const engine = launch(
        lateRewindProfile(),
        [{ kind: 'user-message-id' }, { kind: 'text', text: 'ok' }],
        { rewindAnswerTimeoutMs: 200, logger: { ...quietLogger, warn } },
      );
      await engine.start('late-turn');
      const first = await engine.send('late-turn', 'one');
      await engine.completed(first);
      expect(
        await engine.adapter.rewindSession('late-turn', first),
      ).toMatchObject({ kind: 'failed' });
      const second = await engine.send('late-turn', 'two');
      await engine.completed(second);
      expect(
        await waitFor(
          () => rewoundEvents(engine, 'acp.session-rewound-late')[0],
          'late rewind warning',
        ),
      ).toMatchObject({
        method: 'runtime.warning',
        details: { beforeTurnId: first },
      });
      expect(rewoundEvents(engine, 'acp.session-rewound')).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        { threadId: 'late-turn', beforeTurnId: first },
        'ACP rewind applied by the engine after its deadline and after a later turn',
      );
      // The ledger still holds both turns: the second is still a rewind
      // point (this request times out too, so nothing else changes).
      expect(
        await engine.adapter.rewindSession('late-turn', second),
      ).toMatchObject({ kind: 'failed' });
    });

    const revertAnswering = (answer: Record<string, unknown>) => ({
      ...profileOf('kiro-v3'),
      extMethodAnswers: {
        ...(profileOf('kiro-v3').extMethodAnswers as Record<string, unknown>),
        '_kiro/checkpoint/revertMultiple': answer,
      },
    });

    test('a late rewind still unanswered at its late deadline stops holding rewinds; its answer after that is a warning', async () => {
      const warn = vi.fn();
      const engine = launch(
        revertAnswering({
          delayMs: 1500,
          result: { success: true, affectedFiles: [], totalFiles: 0 },
        }),
        [{ kind: 'user-message-id' }, { kind: 'text', text: 'ok' }],
        {
          rewindAnswerTimeoutMs: 200,
          rewindLateAnswerTimeoutMs: 400,
          logger: { ...quietLogger, warn },
        },
      );
      await engine.start('late-abandoned');
      const first = await engine.send('late-abandoned', 'one');
      await engine.completed(first);
      expect(
        await engine.adapter.rewindSession('late-abandoned', first),
      ).toMatchObject({ kind: 'failed' });
      await waitFor(
        () =>
          warn.mock.calls.some(
            ([, message]) =>
              message ===
              'ACP rewind still unanswered at its late deadline; rewinds are taken again',
          )
            ? true
            : undefined,
        'late deadline',
      );
      expect(
        await waitFor(
          () => rewoundEvents(engine, 'acp.session-rewound-late')[0],
          'late warning',
        ),
      ).toMatchObject({ details: { beforeTurnId: first } });
      // No turn started, yet the transcript is not cut: the answer came
      // after the session stopped waiting for it.
      expect(rewoundEvents(engine, 'acp.session-rewound')).toEqual([]);
    });

    test('a late refusal and a late error are logged, and mark nothing', async () => {
      const refusedWarn = vi.fn();
      const refused = launch(
        revertAnswering({
          delayMs: 600,
          result: { success: false, message: 'nothing to revert' },
        }),
        [{ kind: 'user-message-id' }, { kind: 'text', text: 'ok' }],
        {
          rewindAnswerTimeoutMs: 200,
          logger: { ...quietLogger, warn: refusedWarn },
        },
      );
      await refused.start('late-refused');
      const one = await refused.send('late-refused', 'one');
      await refused.completed(one);
      await refused.adapter.rewindSession('late-refused', one);
      await waitFor(
        () => (refusedWarn.mock.calls.length > 0 ? true : undefined),
        'late refusal log',
      );
      expect(refusedWarn).toHaveBeenCalledWith(
        { threadId: 'late-refused', message: 'nothing to revert' },
        'ACP rewind refused by the engine after its deadline',
      );

      const erroredWarn = vi.fn();
      const errored = launch(
        revertAnswering({
          delayMs: 600,
          error: { code: -32603, message: 'checkpoint store unavailable' },
        }),
        [{ kind: 'user-message-id' }, { kind: 'text', text: 'ok' }],
        {
          rewindAnswerTimeoutMs: 200,
          logger: { ...quietLogger, warn: erroredWarn },
        },
      );
      await errored.start('late-errored');
      const two = await errored.send('late-errored', 'one');
      await errored.completed(two);
      await errored.adapter.rewindSession('late-errored', two);
      await waitFor(
        () =>
          erroredWarn.mock.calls.some(
            ([, message]) => message === 'ACP rewind failed after its deadline',
          )
            ? true
            : undefined,
        'late error log',
      );
      for (const engine of [refused, errored])
        expect(
          engine.events.some((event) =>
            String((event as { code?: string }).code).startsWith(
              'acp.session-rewound',
            ),
          ),
        ).toBe(false);
    });

    test('a late rewind whose engine exits with it unanswered says the engine may have applied it', async () => {
      const engine = launch(
        revertAnswering({ exitAfterMs: 500 }),
        [{ kind: 'user-message-id' }, { kind: 'text', text: 'ok' }],
        { rewindAnswerTimeoutMs: 200 },
      );
      await engine.start('late-exit');
      const first = await engine.send('late-exit', 'one');
      await engine.completed(first);
      expect(
        await engine.adapter.rewindSession('late-exit', first),
      ).toMatchObject({ kind: 'failed' });
      expect(
        await waitFor(
          () => rewoundEvents(engine, 'acp.session-rewound-late')[0],
          'conservative late warning',
        ),
      ).toMatchObject({
        message:
          'Kiro may have applied a rewind before it restarted. Turns from the chosen one on may be hidden from the engine.',
        details: { beforeTurnId: first },
      });
    });

    test('a send refused while preparing its turn frees the session for a rewind', async () => {
      const engine = launch(profileOf('kiro-v3'), [
        { kind: 'user-message-id' },
        { kind: 'text', text: 'ok' },
      ]);
      await engine.start('prep-refused');
      const first = await engine.send('prep-refused', 'one');
      await engine.completed(first);
      // No option of this session takes an effort, so the send is refused
      // during its preparation, before any prompt.
      await expect(
        engine.send('prep-refused', 'two', { effort: 'high' }),
      ).rejects.toMatchObject({ name: 'SendTurnRefusedError' });
      expect(
        await engine.adapter.rewindSession('prep-refused', first),
      ).toMatchObject({ kind: 'rewound', hiddenTurnIds: [first] });
    });

    test('a roster past the child-work bound is logged through the adapter logger, once while it stays over', async () => {
      const warn = vi.fn();
      const roster = (count: number) => ({
        kind: 'notification',
        method: '_kiro.dev/subagent/list_update',
        params: {
          sessionId: '$sessionId',
          subagents: Array.from({ length: count }, (_, index) => ({
            sessionId: `sub-${index}`,
            status: { type: 'working' },
          })),
        },
      });
      const engine = launch(
        profileOf('kiro-v2'),
        [
          roster(65),
          roster(66),
          roster(1),
          roster(65),
          { kind: 'text', text: 'ok' },
        ],
        { logger: { ...quietLogger, warn } },
      );
      await engine.start('roster-bound');
      await engine.completed(await engine.send('roster-bound', 'go'));
      const bound = warn.mock.calls.filter(
        ([, message]) =>
          message ===
          'ACP subagent roster exceeds the child-work bound; its running set is not published',
      );
      // Over, still over (one warning), back under, over again (a second).
      expect(bound).toEqual([
        [
          { threadId: 'roster-bound', running: 65, max: 64 },
          'ACP subagent roster exceeds the child-work bound; its running set is not published',
        ],
        [
          { threadId: 'roster-bound', running: 65, max: 64 },
          'ACP subagent roster exceeds the child-work bound; its running set is not published',
        ],
      ]);
    });

    test('rewind is refused on an engine that declares none, and on a stopped session', async () => {
      const v2 = launch(profileOf('kiro-v2'), [{ kind: 'text', text: 'ok' }]);
      await v2.start('no-rewind');
      const turn = await v2.send('no-rewind', 'one');
      await v2.completed(turn);
      expect(v2.adapter.sessionContinuity('no-rewind')).toEqual({
        live: true,
        fork: 'none',
        rewind: 'none',
      });
      expect(await v2.adapter.rewindSession('no-rewind', turn)).toEqual({
        kind: 'refused',
        reason: 'unsupported',
      });
      await v2.adapter.stopSession('no-rewind');
      expect(v2.adapter.sessionContinuity('no-rewind')).toEqual({
        live: false,
        fork: 'none',
        rewind: 'none',
      });
      expect(await v2.adapter.rewindSession('no-rewind', turn)).toEqual({
        kind: 'refused',
        reason: 'not-live',
      });
    });

    test('a steered turn is rewound from its own prompt id, and forked from its last', async () => {
      const engine = launch(profileOf('kiro-v3'), [
        { kind: 'user-message-id' },
        { kind: 'wait-ms', ms: 400 },
        { kind: 'text', text: 'ok' },
      ]);
      await engine.start('rewind-steer');
      const first = await engine.send('rewind-steer', 'one');
      await engine.completed(first);
      const second = await engine.send('rewind-steer', 'two');
      // msg-2 is assigned at once; steer while the turn waits.
      await waitFor(
        () =>
          engine.record().filter((entry) => entry.method === 'session/prompt')
            .length === 2
            ? true
            : undefined,
        'second prompt',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await engine.adapter.steerTurn('rewind-steer', 'two, but left', second);
      await engine.completed(second);
      expect(
        engine.record().filter((entry) => entry.method === 'session/prompt'),
      ).toHaveLength(3);

      const forked = await engine.adapter.forkSession('rewind-steer', second);
      expect(forked).toHaveProperty('resumeCursor');
      expect(
        engine.record().find((entry) => entry.method === 'session/fork'),
      ).toMatchObject({ meta: { kiro: { messageId: 'msg-3' } } });

      expect(
        await engine.adapter.rewindSession('rewind-steer', second),
      ).toMatchObject({ kind: 'rewound', hiddenTurnIds: [second] });
      // Turn 2's own prompt, not the steer's re-prompt: reverting from msg-3
      // would leave turn 2's first prompt in the engine's history.
      expect(
        engine
          .record()
          .find(
            (entry) => entry.extMethod === '_kiro/checkpoint/revertMultiple',
          ),
      ).toMatchObject({ params: { messageId: 'msg-2' } });
    });

    test('native fork names the turn’s prompt id', async () => {
      const engine = launch(profileOf('kiro-v3'), [
        { kind: 'user-message-id' },
        { kind: 'text', text: 'ok' },
      ]);
      const session = await engine.start('fork');
      const turnId = await engine.send('fork', 'one');
      await engine.completed(turnId);
      expect(engine.adapter.sessionContinuity('fork')).toEqual({
        live: true,
        fork: 'native',
        rewind: 'in-place',
      });
      const forked = await engine.adapter.forkSession('fork', turnId);
      const sessionId = (session.resumeCursor as { acpSessionId: string })
        .acpSessionId;
      expect(forked).toEqual({
        resumeCursor: expect.objectContaining({
          acpSessionId: `${sessionId}-fork`,
        }),
      });
      expect(
        engine.record().find((entry) => entry.method === 'session/fork'),
      ).toEqual({
        method: 'session/fork',
        sessionId,
        meta: { kiro: { messageId: 'msg-1' } },
      });
    });

    test('Kiro agent service subagents arrive as child work, and its session claims no not-reported', async () => {
      const subtask = (status: string) => ({
        kind: 'session-update',
        update: {
          sessionUpdate:
            status === 'in_progress' ? 'tool_call' : 'tool_call_update',
          toolCallId: 'tc-sub',
          title: 'Sub-agent: researcher',
          status,
          _meta: { kiro: { kind: 'agent-subtask', agentSubtaskId: 'sa-1' } },
        },
      });
      const engine = launch(profileOf('kiro-v3'), [
        subtask('in_progress'),
        subtask('completed'),
        { kind: 'text', text: 'ok' },
      ]);
      await engine.start('subagents-v3');
      await engine.completed(await engine.send('subagents-v3', 'go'));
      const deltas = engine.events.flatMap((event) =>
        event.method === 'child-work.updated' ? [event.delta] : [],
      );
      expect(deltas.map((delta) => delta.kind)).toEqual([
        'snapshot',
        'settle',
        'snapshot',
      ]);
      expect(deltas[0]).toMatchObject({
        running: [{ childId: 'sa-1', reporterThreadId: 'subagents-v3' }],
      });
      expect(deltas[1]).toMatchObject({ childId: 'sa-1', status: 'completed' });
    });

    test('a kiro-cli subagent roster arrives as child work', async () => {
      const engine = launch(profileOf('kiro-v2'), [
        {
          kind: 'notification',
          method: '_kiro.dev/subagent/list_update',
          params: {
            sessionId: '$sessionId',
            subagents: [
              {
                sessionId: 'sub-1',
                sessionName: 'review',
                agentName: 'reviewer',
                initialQuery: 'review the diff',
                status: { type: 'working', message: '' },
              },
            ],
          },
        },
        { kind: 'text', text: 'ok' },
      ]);
      await engine.start('subagents-v2');
      await engine.completed(await engine.send('subagents-v2', 'go'));
      const deltas = engine.events.flatMap((event) =>
        event.method === 'child-work.updated' ? [event.delta] : [],
      );
      expect(deltas).toEqual([
        expect.objectContaining({
          kind: 'snapshot',
          running: [
            expect.objectContaining({
              childId: 'sub-1',
              title: 'review the diff',
              kindLabel: 'reviewer',
            }),
          ],
        }),
      ]);
    });

    test('an ACP engine with no subagent reporter says its child work is not reported', async () => {
      const goose = JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL(
              './fixtures/acp-engine-profiles/goose.json',
              import.meta.url,
            ),
          ),
          'utf8',
        ),
      );
      // It sends both Kiro subagent wires anyway: neither is read.
      const engine = launch(goose, [
        {
          kind: 'notification',
          method: '_kiro.dev/subagent/list_update',
          params: {
            sessionId: '$sessionId',
            subagents: [{ sessionId: 'sub-1', status: { type: 'working' } }],
          },
        },
        {
          kind: 'session-update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-sub',
            title: 'Sub-agent: researcher',
            status: 'in_progress',
            _meta: { kiro: { kind: 'agent-subtask', agentSubtaskId: 'sa-1' } },
          },
        },
        { kind: 'text', text: 'ok' },
      ]);
      await engine.start('no-subagents');
      await engine.completed(await engine.send('no-subagents', 'go'));
      expect(
        engine.events
          .filter((event) => event.method === 'child-work.updated')
          .map((event) => (event as { delta: { kind: string } }).delta.kind),
      ).toEqual(['not-reported']);
      expect(
        await waitFor(
          () =>
            engine.events.find(
              (event) => event.method === 'child-work.updated',
            ),
          'not-reported',
        ),
      ).toMatchObject({
        delta: {
          kind: 'not-reported',
          reporterThreadId: 'no-subagents',
          reason: 'This engine reports no subagents to Station over ACP.',
        },
      });
      const kiro = launch(profileOf('kiro-v3'), [{ kind: 'text', text: 'ok' }]);
      await kiro.start('kiro-reports');
      // A later event has drained, so an earlier not-reported would have too.
      await kiro.completed(await kiro.send('kiro-reports', 'go'));
      expect(
        kiro.events.some((event) => event.method === 'child-work.updated'),
      ).toBe(false);
    });

    test('a credential request before initialize is refused on a custom command', async () => {
      const engine = launch({
        ...profileOf('kiro-v3'),
        initializeRequests: [
          { method: '_kiro/auth/getAccessToken', params: {} },
        ],
      });
      await engine.start('token');
      expect(answersTo(engine.record(), '_kiro/auth/getAccessToken')).toEqual([
        {
          clientRequest: '_kiro/auth/getAccessToken',
          phase: 'initialize',
          error: expect.objectContaining({ code: -32601 }),
        },
      ]);
    });
  },
);
