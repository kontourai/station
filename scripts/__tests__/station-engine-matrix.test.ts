import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { TurnProvenanceEnvelope } from '../../packages/contracts/src/turn-provenance.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  checkOutputs,
  checkServedConnection,
  checkServedModel,
  renderMatrix,
} from '../lib/engine-matrix.mjs';

const exec = promisify(execFile);
const makeTempDir = trackTempDirs();
const script = fileURLToPath(
  new URL('../station-agent-smoke.mjs', import.meta.url),
);
const connection = {
  id: 'test-engine',
  enabled: true,
  type: 'test',
  config: { provider: 'fake' },
};
const childOptions = {
  windowsHide: true,
  timeout: 15_000,
  maxBuffer: 1024 * 1024,
  env: { ...process.env, STATION_CREDENTIAL: 'private-test-credential' },
};

function provenance(
  sessionId: string,
  turnId: string,
  model: string | null,
  engine = 'fake',
): TurnProvenanceEnvelope {
  const unavailable = {
    state: 'unavailable',
    reason: 'not-captured-by-station',
  } as const;
  const observedFrom = [
    { eventId: `event-${turnId}`, method: 'turn.completed' as const },
  ];
  return {
    envelopeVersion: 1,
    sessionId,
    turnId,
    outcome: 'completed',
    observedAt: '2026-10-18T12:00:00.000Z',
    engine: { state: 'observed', value: { provider: engine }, observedFrom },
    requestedModel: { state: 'observed', value: 'model-1', observedFrom },
    reportedModel: model
      ? { state: 'observed', value: model, observedFrom }
      : unavailable,
    tools: unavailable,
    usage: unavailable,
    routingReceipt: unavailable,
    sources: unavailable,
    trustReport: unavailable,
  };
}

describe('engine matrix verdicts', () => {
  it.each([
    ['claude-sonnet-4-5', 'claude-sonnet-4-5', 'pass'],
    ['claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5-20250929', 'pass'],
    ['anthropic.claude-3-7-sonnet-20250219-v1:0', 'claude-3-7-sonnet', 'pass'],
    ['gpt-4.1', 'openai/gpt-4.1-2025-04-14', 'pass'],
    ['claude-sonnet-4-5', 'openai/claude-sonnet-4-5', 'fail'],
    ['anthropic/claude-sonnet-4-5', 'google/claude-sonnet-4-5', 'fail'],
    ['gpt-4.1', 'anthropic/gpt-4.1', 'fail'],
    ['claude-sonnet-4-5', 'openrouter/anthropic/claude-sonnet-4-5', 'pass'],
    ['claude-sonnet-4-5', 'openrouter/openai/claude-sonnet-4-5', 'fail'],
    ['claude-sonnet-4-5', 'claude-sonnet-4-5@20250929', 'pass'],
    [
      'claude-sonnet-4-5',
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'pass',
    ],
    ['claude-sonnet-4-5', 'us.anthropic.claude-opus-4-5-20250929-v1:0', 'fail'],
    ['claude-sonnet-4-5', 'claude-sonnet-4-5-mini@20250929', 'fail'],
    [
      'claude-sonnet-4-5@20250929',
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'pass',
    ],
    ['gpt-4.1', 'gpt-4.1-mini', 'fail'],
    ['gpt-4.1-mini', 'gpt-4.1', 'fail'],
    ['gpt-4.1', 'gpt-4.2', 'fail'],
    ['claude-sonnet-4-5', 'claude-opus-4-5', 'fail'],
    ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'fail'],
    ['gpt-4.1', 'gpt-4.1-v2', 'fail'],
    ['gpt-4.1', 'gpt-4.1-latest', 'fail'],
    ['gpt-4.1', 'untrusted/gpt-4.1', 'fail'],
    ['gpt-4.1-2025-04-14', 'gpt-4.1-2025-05-14', 'fail'],
    ['gpt-4.1', null, 'unverified'],
    [
      'anthropic.claude-3-7-sonnet-20250219-v1:0',
      'anthropic.claude-3-7-sonnet-20250219-v2:0',
      'fail',
    ],
  ])(
    'compares requested %s to reported %s: %s',
    (requested, reported, verdict) => {
      expect(checkServedModel(requested, reported)).toBe(verdict);
    },
  );

  it('resolves the observed engine through an unambiguous enabled connection', () => {
    expect(checkServedConnection('test-engine', 'fake', [connection])).toBe(
      'pass',
    );
    expect(checkServedConnection('test-engine', 'other', [connection])).toBe(
      'fail',
    );
    expect(checkServedConnection('test-engine', null, [connection])).toBe(
      'unverified',
    );
    expect(
      checkServedConnection('test-engine', 'fake', [
        connection,
        { ...connection, id: 'other' },
      ]),
    ).toBe('fail');
  });

  it.each([
    [['a', 'b'], ['b', 'a'], 'pass'],
    [['a'], ['a', 'a'], 'fail'],
    [['a', 'a'], ['a'], 'fail'],
    [['a'], ['b'], 'fail'],
    [[], [], 'pass'],
    [[], null, 'unverified'],
    [null, [], 'unverified'],
    [['a'], 'a', 'fail'],
  ])(
    'compares complete output multisets %j and %j',
    (stored, rendered, expected) => {
      expect(checkOutputs(stored, rendered)).toBe(expected);
    },
  );

  it('renders dated rows, served identities and escaped failures without implying live evidence', () => {
    expect(
      renderMatrix({
        generatedAt: '2026-10-18T12:00:00.000Z',
        evidence: 'stub-api; no providers',
        rows: [
          {
            engine: 'fake',
            connectionId: 'test-engine',
            model: 'model-1',
            scenario: 'first',
            status: 'fail',
            turns: [{ servedBy: 'other', reportedModel: 'model-2' }],
            failure: 'wrong | model\nagain',
          },
        ],
      }),
    ).toBe(
      [
        '# Engine verification matrix — 2026-10-18',
        '',
        'Generated: 2026-10-18T12:00:00.000Z. Evidence: stub-api; no providers.',
        'A missing model or rendered-output observation is unverified. This report does not alter the catalog.',
        '',
        '| Engine | Connection | Requested model | Scenario | Verdict | Engine-inferred connection | Served as | Failure |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| fake | test-engine | model-1 | first | fail | other | model-2 | wrong \\| model again |',
        '',
      ].join('\n'),
    );
  });
});

type Fault =
  | 'substitution'
  | 'missing-model'
  | 'wrong-engine'
  | 'extra-rendered'
  | 'no-observer'
  | 'start'
  | 'timeout'
  | 'isolation'
  | 'cleanup'
  | 'one-model'
  | 'extra-stored'
  | 'wrong-follow-up'
  | 'forget-on-stop'
  | 'no-op-stop'
  | 'no-loaded-api'
  | 'resume-unobservable'
  | 'wrong-content'
  | 'observer-identity'
  | 'duplicate-scenario'
  | 'session-error'
  | 'old-session-error'
  | 'credential-error'
  | 'claude-alias'
  | 'unresolved-alias'
  | 'overspend'
  | 'legacy-extension';

async function runCli(
  fault?: Fault,
  options: { confirmed?: boolean; args?: string[]; credential?: string } = {},
) {
  const directory = makeTempDir('station-matrix-');
  const requests: Array<{ url: string; body?: any }> = [];
  const sessions = new Map<
    string,
    {
      secret?: string;
      turns: Array<{
        id: string;
        model: string;
        text: string;
        file?: string;
        content?: string;
      }>;
      events: Array<{
        eventId: string;
        method: string;
        turnId?: string;
        message?: string;
      }>;
      stopped: boolean;
    }
  >();
  const claude = fault === 'claude-alias' || fault === 'unresolved-alias';
  const engine = claude ? 'claude' : 'fake';
  const credential = options.credential ?? childOptions.env.STATION_CREDENTIAL;
  const entries = claude
    ? [
        {
          id: 'sonnet',
          name: 'Sonnet',
          originalId: 'sonnet',
          ...(fault === 'claude-alias'
            ? { resolvedModel: 'claude-sonnet-4-5' }
            : {}),
        },
        {
          id: 'default',
          name: 'Default',
          originalId: 'default',
          ...(fault === 'claude-alias'
            ? { resolvedModel: 'claude-opus-4-5' }
            : {}),
        },
      ]
    : (fault === 'one-model' ? ['model-1'] : ['model-1', 'model-2']).map(
        (id) => ({ id, name: id, originalId: id }),
      );
  const observer = join(directory, 'observer.mjs');
  // This independent rendered fixture never reads the stored-output endpoint.
  await writeFile(
    observer,
    `export async function observeOutputs({sessionId,turnId}) { const match = /:artifact:(.+)$/.exec(turnId); return {sessionId,turnId: ${fault === 'observer-identity' ? "'different-turn'" : 'turnId'},names: ${fault === 'extra-rendered' ? "['phantom.txt']" : 'match ? [match[1]] : []'}}; }\nexport const scenarios = [{ id: '${fault === 'duplicate-scenario' ? 'first' : 'extension'}', ${fault === 'legacy-extension' ? '' : 'maxTurns: 1,'} async run(ctx) { ${fault === 'overspend' ? 'for (let i=0;i<3;i++)' : ''} await ctx.recall(ctx.model); } }];\n`,
  );
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    const url = request.url ?? '';
    requests.push({ url, body });
    response.setHeader('content-type', 'application/json');
    const send = (data: unknown) =>
      response.end(JSON.stringify({ success: true, data }));
    const reject = (message = 'fixture refusal') => {
      response.statusCode = 400;
      response.end(JSON.stringify({ success: false, error: message }));
    };
    if (url === '/api/connections/agents')
      return send(
        fault === 'isolation'
          ? [connection, { ...connection, id: 'other' }]
          : [{ ...connection, config: { provider: engine } }],
      );
    if (url === `/api/orchestration/providers/${engine}/models`)
      return send(entries);
    if (url === '/api/orchestration/sessions/loaded') {
      if (fault === 'no-loaded-api') return reject('loaded state unavailable');
      return send(
        [...sessions]
          .filter(([, session]) => !session.stopped)
          .map(([threadId]) => ({ threadId, isLoaded: true })),
      );
    }
    if (url === '/api/orchestration/commands') {
      if (body.type === 'startSession') {
        if (fault === 'start') return reject();
        sessions.set(body.input.threadId, {
          turns: [],
          stopped: false,
          events:
            fault === 'old-session-error'
              ? [
                  {
                    eventId: 'old-error',
                    method: 'runtime.error',
                    message: 'historical error',
                  },
                ]
              : [],
        });
        return send({ threadId: body.input.threadId });
      }
      const session = sessions.get(body.threadId ?? body.input?.threadId);
      if (!session) return reject();
      if (body.type === 'stopSession') {
        if (fault === 'cleanup') return reject();
        if (fault !== 'no-op-stop') session.stopped = true;
        if (fault === 'forget-on-stop') session.secret = undefined;
        return send(null);
      }
      if (body.type === 'sendTurn') {
        const input: string = body.input.input;
        const initial =
          /Remember this secret for this conversation: ([\w-]+)\./.exec(input);
        if (initial) session.secret = initial[1];
        const file = /Create (station-matrix-[\w-]+\.txt) /.exec(input)?.[1];
        const content =
          /containing exactly (STATION_MATRIX_ARTIFACT:[\w-]+)/.exec(
            input,
          )?.[1];
        const id = `${session.turns.length + 1}${file ? `:artifact:${file}` : ''}`;
        const text =
          fault === 'wrong-follow-up' && session.turns.length === 1
            ? 'wrong recall'
            : initial || file
              ? 'STATION_SMOKE_OK'
              : (session.secret ?? 'forgot');
        session.turns.push({
          id,
          model: body.input.modelId,
          text,
          file: input.includes('declare_output') ? file : undefined,
          content,
        });
        if (fault !== 'resume-unobservable' || !session.stopped)
          session.stopped = false;
        session.events.push({
          eventId: `end-${id}`,
          method: 'turn.completed',
          turnId: id,
        });
        if (fault === 'session-error' || fault === 'credential-error')
          session.events.push({
            eventId: `error-${id}`,
            method: 'runtime.error',
            message:
              fault === 'credential-error'
                ? `Runtime rejected ${credential}; context unavailable`
                : 'Session transport disconnected',
          });
        return send({ turnId: id });
      }
    }
    const match = /\/sessions\/([^/]+)\/(events|messages|outputs)(.*)/.exec(
      url,
    );
    if (!match) return reject();
    const [, sessionId, resource, suffix] = match;
    const session = sessions.get(sessionId);
    if (!session) return reject();
    if (resource === 'events')
      return send(fault === 'timeout' ? [] : session.events);
    if (resource === 'messages')
      return send(
        session.turns.map((turn) => ({
          role: 'assistant',
          turnId: turn.id,
          parts: [{ type: 'text', text: turn.text }],
          provenance: provenance(
            sessionId,
            turn.id,
            fault === 'missing-model'
              ? null
              : fault === 'substitution'
                ? 'other-family'
                : claude
                  ? turn.model === 'sonnet'
                    ? 'claude-sonnet-4-5'
                    : 'claude-opus-4-5'
                  : turn.model,
            fault === 'wrong-engine' ? 'fallback' : engine,
          ),
        })),
      );
    const items = session.turns
      .filter((turn) => turn.file)
      .map((turn) => ({
        ref: { sessionId, eventId: `file-${turn.id}` },
        turnId: turn.id,
        descriptor: { kind: 'workspace-file', relativePath: turn.file },
      }));
    if (suffix.endsWith('/inspect')) {
      const eventId = decodeURIComponent(suffix.slice(1, -'/inspect'.length));
      const item = items.find((candidate) => candidate.ref.eventId === eventId);
      if (!item) return reject('Output not found');
      return send({
        version: 'session-outputs/v1',
        item,
        kind: 'text',
        text:
          fault === 'wrong-content'
            ? 'wrong artifact bytes'
            : session.turns.find((turn) => turn.id === item.turnId)?.content,
      });
    }
    return send({
      version: 'session-outputs/v1',
      partial: false,
      items:
        fault === 'extra-stored'
          ? items.flatMap((item) => [
              item,
              {
                ...item,
                descriptor: {
                  kind: 'workspace-file',
                  relativePath: 'extra.txt',
                },
              },
            ])
          : items,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port');
    let code = 0;
    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await exec(
        process.execPath,
        [
          script,
          '--matrix',
          ...(options.confirmed === false
            ? []
            : ['--confirm-billable-engine-matrix']),
          `--origin=http://127.0.0.1:${address.port}`,
          '--cwd=/disposable/server/workspace',
          '--connection=test-engine',
          `--output-dir=${directory}`,
          `--timeout-ms=${fault === 'timeout' ? 100 : 5000}`,
          ...(fault === 'no-observer' ? [] : [`--scenario-module=${observer}`]),
          ...(options.args ?? []),
        ],
        {
          ...childOptions,
          env: { ...childOptions.env, STATION_CREDENTIAL: credential },
        },
      ));
    } catch (error) {
      const failure = error as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      code = failure.code;
      stdout = failure.stdout;
      stderr = failure.stderr;
    }
    const files = await readdir(directory);
    const markdown = files.find((file) => file.endsWith('.md'));
    const jsonFile = files.find((file) => file.endsWith('.json'));
    return {
      code,
      stdout,
      stderr,
      result: stdout ? JSON.parse(stdout) : null,
      markdown: markdown
        ? await readFile(join(directory, markdown), 'utf8')
        : null,
      jsonFile: jsonFile
        ? await readFile(join(directory, jsonFile), 'utf8')
        : null,
      requests,
      sessions,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('matrix CLI against a loopback stub API (no providers)', () => {
  it('refuses without matrix confirmation with all other arguments valid and zero requests', async () => {
    const { code, stderr, requests } = await runCli(undefined, {
      confirmed: false,
      args: ['--confirm-billable-one-turn'],
    });
    expect(code).toBe(2);
    expect(stderr).toContain('--confirm-billable-engine-matrix');
    expect(requests).toEqual([]);
  });

  it('runs all advertised models, switches and back, recycles the same session, writes reports and registers extensions', async () => {
    const { code, result, markdown, requests, sessions } = await runCli();
    expect(code).toBe(0);
    expect(result.rows).toHaveLength(12);
    expect(result.rows.every((row: any) => row.status === 'pass')).toBe(true);
    expect(
      result.rows
        .filter((row: any) => row.scenario === 'model-switch')
        .map((row: any) => row.turns.map((turn: any) => turn.requestedModel)),
    ).toEqual([
      ['model-2', 'model-1'],
      ['model-1', 'model-2'],
    ]);
    expect(sessions.size).toBe(2);
    for (const [id, session] of sessions) {
      const commands = requests
        .filter(
          (request) =>
            request.body?.threadId === id ||
            request.body?.input?.threadId === id,
        )
        .map((request) => request.body.type);
      expect(commands).toEqual([
        'startSession',
        'sendTurn',
        'sendTurn',
        'sendTurn',
        'sendTurn',
        'sendTurn',
        'stopSession',
        'sendTurn',
        'sendTurn',
        'stopSession',
      ]);
      expect(session.stopped).toBe(true);
      const followups = requests
        .filter(
          (request) =>
            request.body?.type === 'sendTurn' &&
            request.body.input.threadId === id,
        )
        .slice(1);
      expect(
        followups.every(
          (request) => !request.body.input.input.includes(session.secret),
        ),
      ).toBe(true);
    }
    expect(markdown).toContain(
      '| fake | test-engine | model-1 | recycle | pass | test-engine | model-1 |',
    );
  });

  it.each([
    'substitution',
    'wrong-engine',
    'extra-rendered',
    'extra-stored',
    'start',
    'timeout',
    'cleanup',
    'wrong-follow-up',
    'forget-on-stop',
    'session-error',
    'wrong-content',
  ] as const)(
    'exits 1 and records %s without retrying a send',
    async (fault) => {
      const { code, result, requests } = await runCli(fault);
      expect(code).toBe(1);
      expect(result.rows.some((row: any) => row.status === 'fail')).toBe(true);
      const expectedSends = {
        substitution: 2,
        'wrong-engine': 2,
        'extra-rendered': 2,
        'extra-stored': 10,
        start: 0,
        timeout: 2,
        cleanup: 10,
        'wrong-follow-up': 4,
        'forget-on-stop': 12,
        'session-error': 2,
        'wrong-content': 10,
      };
      const sends = requests.filter(
        (request) => request.body?.type === 'sendTurn',
      );
      expect(sends).toHaveLength(expectedSends[fault]);
      expect(
        new Set(sends.map((request) => request.body.input.clientTurnId)).size,
      ).toBe(sends.length);
      if (fault === 'wrong-follow-up' || fault === 'forget-on-stop') {
        const failedScenario =
          fault === 'wrong-follow-up' ? 'follow-up' : 'recycle';
        expect(
          result.rows
            .filter((row: any) => row.scenario === failedScenario)
            .every(
              (row: any) =>
                row.status === 'fail' &&
                row.turns.at(-1).checks.response === 'fail',
            ),
        ).toBe(true);
      }
      if (fault === 'session-error')
        expect(result.rows[0].failure).toContain(
          'Session transport disconnected',
        );
      if (fault === 'wrong-content')
        expect(
          result.rows.find((row: any) => row.scenario === 'artifact').failure,
        ).toContain('artifactContent');
      if (fault === 'substitution')
        expect(result.rows[0].failure).toContain('servedModel');
      if (fault === 'wrong-engine')
        expect(result.rows[0].failure).toContain('servedConnection');
      if (fault === 'extra-rendered')
        expect(result.rows[0].failure).toContain('outputs');
      if (fault === 'extra-stored')
        expect(
          result.rows.find((row: any) => row.scenario === 'artifact').failure,
        ).toContain('artifact');
      if (fault === 'timeout')
        expect(result.rows[0].failure).toContain('timed out');
    },
  );

  it.each([
    'missing-model',
    'no-observer',
    'one-model',
    'observer-identity',
    'unresolved-alias',
    'no-op-stop',
    'no-loaded-api',
    'resume-unobservable',
  ] as const)('records %s as unverified and exits 1', async (fault) => {
    const { code, result } = await runCli(fault);
    expect(code).toBe(1);
    expect(result.rows.some((row: any) => row.status === 'unverified')).toBe(
      true,
    );
    expect(result.rows.some((row: any) => row.status === 'fail')).toBe(false);
    if (fault === 'unresolved-alias')
      expect(result.rows[0].failure).toContain('alias without resolution');
  });

  it('refuses a non-isolated inventory before starting sessions', async () => {
    const { code, requests, result } = await runCli('isolation');
    expect(code).toBe(1);
    expect(result).toBeNull();
    expect(requests.map((request) => request.url)).toEqual([
      '/api/connections/agents',
    ]);
  });
  it('compares Claude-shaped catalog resolved identities while sending SDK aliases', async () => {
    const { code, result, requests } = await runCli('claude-alias');
    expect(code).toBe(0);
    expect(result.rows[0].turns[0]).toMatchObject({
      requestedModel: 'sonnet',
      comparisonModel: 'claude-sonnet-4-5',
      reportedModel: 'claude-sonnet-4-5',
      checks: { servedModel: 'pass' },
    });
    expect(
      requests
        .filter((request) => request.body?.type === 'sendTurn')
        .every((request) =>
          ['sonnet', 'default'].includes(request.body.input.modelId),
        ),
    ).toBe(true);
  });

  it('refuses a plan at max+1 before any session or turn is sent', async () => {
    const { code, stderr, requests, sessions } = await runCli(undefined, {
      args: ['--max-turns=13'],
    });
    expect(code).toBe(1);
    expect(stderr).toContain('Planned 14 turns exceeds --max-turns=13');
    expect(sessions.size).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      '/api/connections/agents',
      '/api/orchestration/providers/fake/models',
    ]);
  });

  it.each([
    { ids: ['model-2', 'model-2'], selected: ['model-2'], max: 5, exit: 1 },
    {
      ids: ['model-2', 'model-1'],
      selected: ['model-2', 'model-1'],
      max: 14,
      exit: 0,
    },
  ])(
    'prints the plan and restricts every send to the repeatable allowlist $ids',
    async ({ ids, selected, max, exit }) => {
      const { code, stderr, result, requests } = await runCli(undefined, {
        args: [...ids.map((id) => `--model=${id}`), `--max-turns=${max}`],
      });
      expect(code).toBe(exit);
      expect(JSON.parse(stderr)).toMatchObject({
        type: 'engine-matrix-plan',
        modelIds: selected,
        plannedTurnCount: max,
        maxTurns: max,
      });
      expect(result.sentTurns).toBe(max);
      const sends = requests.filter(
        (request) => request.body?.type === 'sendTurn',
      );
      expect(sends).toHaveLength(max);
      expect(
        sends.every((request) => selected.includes(request.body.input.modelId)),
      ).toBe(true);
      if (selected.length === 1)
        expect(
          result.rows.find((row: any) => row.scenario === 'model-switch')
            .status,
        ).toBe('unverified');
    },
  );

  it('enforces the runtime ceiling if an extension exceeds its declared estimate', async () => {
    const { code, result, requests } = await runCli('overspend', {
      args: ['--max-turns=14'],
    });
    expect(code).toBe(1);
    expect(
      requests.filter((request) => request.body?.type === 'sendTurn'),
    ).toHaveLength(14);
    expect(
      result.rows.some((row: any) =>
        row.failure?.includes('Hard turn ceiling'),
      ),
    ).toBe(true);
  });

  it('keeps legacy additionalScenarios valid and reserves the remaining ceiling for unknown extension sends', async () => {
    const { code, result, stderr } = await runCli('legacy-extension');
    expect(code).toBe(0);
    expect(result.sentTurns).toBe(14);
    expect(JSON.parse(stderr).plannedTurnCount).toBe(24);
  });

  it('refuses duplicate scenario ids before starting any session', async () => {
    const { code, stderr, requests, sessions } =
      await runCli('duplicate-scenario');
    expect(code).toBe(1);
    expect(stderr).toContain('Duplicate scenario id');
    expect(sessions.size).toBe(0);
    expect(requests.some((request) => request.body?.type === 'sendTurn')).toBe(
      false,
    );
  });

  it('redacts an echoed credential from errors, stdout and both report files while preserving useful error context', async () => {
    const { code, result, stdout, stderr, markdown, jsonFile } =
      await runCli('credential-error');
    expect(code).toBe(1);
    expect(result.rows[0].failure).toContain('[redacted]; context unavailable');
    for (const output of [stdout, stderr, markdown, jsonFile])
      expect(output).not.toContain(childOptions.env.STATION_CREDENTIAL);
    expect(jsonFile).toBe(`${stdout.trim()}\n`);
  });

  it('refuses implausibly short credentials without requests or character-wide replacement', async () => {
    const { code, stderr, requests } = await runCli(undefined, {
      credential: 'x',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('Credential must contain at least 16 characters');
    expect(requests).toEqual([]);
  });

  it('does not attribute an old session-level runtime error to a new completed turn', async () => {
    expect((await runCli('old-session-error')).code).toBe(0);
  });

  it('records an actual API loaded/unloaded/resumed transition and detects a no-op stop', async () => {
    const good = await runCli();
    const noop = await runCli('no-op-stop');
    expect(
      good.result.rows
        .filter((row: any) => row.scenario === 'recycle')
        .map((row: any) => row.recycleEvidence),
    ).toEqual(
      Array(2).fill({
        loadedBefore: true,
        loadedAfterStop: false,
        loadedAfterRecall: true,
      }),
    );
    const rows = noop.result.rows.filter(
      (row: any) => row.scenario === 'recycle',
    );
    expect(rows.map((row: any) => row.status)).toEqual([
      'unverified',
      'unverified',
    ]);
    expect(
      rows.every((row: any) => row.failure.includes('unload transition')),
    ).toBe(true);
  });
  it('refuses an unadvertised model selector without falling back to the whole catalog', async () => {
    const { code, stderr, requests, sessions } = await runCli(undefined, {
      args: ['--model=not-advertised'],
    });
    expect(code).toBe(1);
    expect(stderr).toContain('--model is not advertised');
    expect(sessions.size).toBe(0);
    expect(requests).toHaveLength(2);
  });
});
