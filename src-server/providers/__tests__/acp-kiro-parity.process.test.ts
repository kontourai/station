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
import { afterEach, describe, expect, test } from 'vitest';
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
    extra?: { agent?: ResolvedAgentDefinition; resumeCursor?: unknown },
  ) => Promise<{ resumeCursor?: unknown }>;
  send: (threadId: string, input: string) => Promise<string>;
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
  });
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
      } as never)) as { resumeCursor?: unknown },
    send: async (threadId, input) =>
      (
        await adapter.sendTurn({
          provider: 'acp',
          threadId,
          input,
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

    test('rewind is refused mid-turn and runs to the next turn’s prompt id after it', async () => {
      const engine = launch(profileOf('kiro-v3'), [
        { kind: 'user-message-id' },
        { kind: 'wait-ms', ms: 400 },
        { kind: 'text', text: 'ok' },
      ]);
      await engine.start('rewind');
      const first = await engine.send('rewind', 'one');
      // `sendTurn` has returned, so the turn is running.
      expect(await engine.adapter.rewindSession('rewind', first)).toEqual({
        kind: 'failed',
        message: 'A turn is running; stop it before rewinding.',
      });
      await engine.completed(first);
      const second = await engine.send('rewind', 'two');
      await engine.completed(second);
      expect(
        engine
          .record()
          .some(
            (entry) => entry.extMethod === '_kiro/checkpoint/revertMultiple',
          ),
      ).toBe(false);

      expect(await engine.adapter.rewindSession('rewind', first)).toMatchObject(
        {
          kind: 'answered',
          success: true,
        },
      );
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
        details: { toTurnId: first, hiddenTurnIds: [second] },
      });
    });

    test('native fork names the turn’s prompt id; discarding deletes the engine session', async () => {
      const engine = launch(profileOf('kiro-v3'), [
        { kind: 'user-message-id' },
        { kind: 'text', text: 'ok' },
      ]);
      const session = await engine.start('fork');
      const turnId = await engine.send('fork', 'one');
      await engine.completed(turnId);
      expect(engine.adapter.sessionContinuity('fork')).toEqual({
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
      await engine.adapter.discardSession('fork');
      expect(
        engine.record().find((entry) => entry.method === 'session/delete'),
      ).toEqual({ method: 'session/delete', sessionId });
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
