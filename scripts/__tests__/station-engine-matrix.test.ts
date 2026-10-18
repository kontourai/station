import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { TurnProvenanceEnvelope } from '../../packages/contracts/src/turn-provenance.js';
import {
  checkOutputs,
  checkServedConnection,
  checkServedModel,
  renderMatrix,
} from '../lib/engine-matrix.mjs';

const exec = promisify(execFile);
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
        '| Engine | Connection | Requested model | Scenario | Verdict | Served by | Served as | Failure |',
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
  | 'extra-stored';

async function runCli(fault?: Fault) {
  const directory = await mkdtemp(join(tmpdir(), 'station-matrix-'));
  const requests: Array<{ url: string; body?: any }> = [];
  const sessions = new Map<
    string,
    {
      secret?: string;
      turns: Array<{ id: string; model: string; text: string; file?: string }>;
      stopped: boolean;
    }
  >();
  const observer = join(directory, 'observer.mjs');
  // Independent rendered fixture. It never reads the stored-output endpoint.
  await writeFile(
    observer,
    `export async function observeOutputs({sessionId,turnId}) { const match = /:artifact:(.+)$/.exec(turnId); return {sessionId,turnId,names: ${fault === 'extra-rendered' ? "['phantom.txt']" : 'match ? [match[1]] : []'}}; }\nexport const scenarios = [{ id: 'extension', async run(ctx) { await ctx.recall(ctx.model); } }];\n`,
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
    const reject = () => {
      response.statusCode = 400;
      response.end(
        JSON.stringify({ success: false, error: 'fixture refusal' }),
      );
    };
    if (url === '/api/connections/agents')
      return send(
        fault === 'isolation'
          ? [connection, { ...connection, id: 'other' }]
          : [connection],
      );
    if (url === '/api/orchestration/providers/fake/models')
      return send(
        (fault === 'one-model' ? ['model-1'] : ['model-1', 'model-2']).map(
          (id) => ({ id, name: id, originalId: id }),
        ),
      );
    if (url === '/api/orchestration/commands') {
      if (body.type === 'startSession') {
        if (fault === 'start') return reject();
        sessions.set(body.input.threadId, { turns: [], stopped: false });
        return send({ threadId: body.input.threadId });
      }
      const session = sessions.get(body.threadId ?? body.input?.threadId);
      if (!session) return reject();
      if (body.type === 'stopSession') {
        session.stopped = true;
        if (fault === 'cleanup') return reject();
        return send(null);
      }
      if (body.type === 'sendTurn') {
        const input: string = body.input.input;
        const initial =
          /Remember this secret for this conversation: ([\w-]+)\./.exec(input);
        if (initial) session.secret = initial[1];
        const file = /Create (station-matrix-[\w-]+\.txt) /.exec(input)?.[1];
        const id = `${session.turns.length + 1}${file ? `:artifact:${file}` : ''}`;
        const text =
          initial || file ? 'STATION_SMOKE_OK' : (session.secret ?? 'forgot');
        session.turns.push({
          id,
          model: body.input.modelId,
          text,
          file: input.includes('declare_output') ? file : undefined,
        });
        session.stopped = false;
        return send({ turnId: id });
      }
    }
    const match = /\/sessions\/([^/]+)\/(events|messages|outputs)/.exec(url);
    if (!match) return reject();
    const [, sessionId, resource] = match;
    const session = sessions.get(sessionId);
    if (!session) return reject();
    if (resource === 'events')
      return send(
        fault === 'timeout'
          ? []
          : session.turns.map((turn) => ({
              method: 'turn.completed',
              turnId: turn.id,
              sessionId,
              provider: 'fake',
            })),
      );
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
                : turn.model,
            fault === 'wrong-engine' ? 'fallback' : 'fake',
          ),
        })),
      );
    return send({
      version: 'session-outputs/v1',
      partial: false,
      items: session.turns
        .filter((turn) => turn.file)
        .flatMap((turn) => [
          {
            turnId: turn.id,
            descriptor: { kind: 'workspace-file', relativePath: turn.file },
          },
          ...(fault === 'extra-stored'
            ? [
                {
                  turnId: turn.id,
                  descriptor: {
                    kind: 'workspace-file',
                    relativePath: 'extra.txt',
                  },
                },
              ]
            : []),
        ]),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port');
    let code = 0;
    let stdout = '';
    try {
      ({ stdout } = await exec(
        process.execPath,
        [
          script,
          '--matrix',
          '--confirm-billable-engine-matrix',
          `--origin=http://127.0.0.1:${address.port}`,
          '--cwd=/disposable/server/workspace',
          '--connection=test-engine',
          `--output-dir=${directory}`,
          `--timeout-ms=${fault === 'timeout' ? 100 : 5000}`,
          ...(fault === 'no-observer' ? [] : [`--scenario-module=${observer}`]),
        ],
        childOptions,
      ));
    } catch (error) {
      const failure = error as Error & { code: number; stdout: string };
      code = failure.code;
      stdout = failure.stdout;
    }
    const files = await readdir(directory);
    const markdown = files.find((file) => file.endsWith('.md'));
    return {
      code,
      stdout,
      result: stdout ? JSON.parse(stdout) : null,
      markdown: markdown
        ? await readFile(join(directory, markdown), 'utf8')
        : null,
      requests,
      sessions,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

describe('matrix CLI against a loopback stub API (no providers)', () => {
  it('refuses before credentials or network without the matrix-specific confirmation, with exit 2', async () => {
    await expect(
      exec(
        process.execPath,
        [script, '--matrix', '--confirm-billable-one-turn'],
        { ...childOptions, env: { ...process.env, STATION_CREDENTIAL: '' } },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('--confirm-billable-engine-matrix'),
    });
  });

  it('runs all advertised models, switches and back, recycles the same session, writes reports and registers extensions', async () => {
    const { code, stdout, result, markdown, requests, sessions } =
      await runCli();
    expect(code).toBe(0);
    expect(stdout).not.toContain(childOptions.env.STATION_CREDENTIAL);
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
  ] as const)(
    'exits 1 and records %s without retrying a send',
    async (fault) => {
      const { code, result } = await runCli(fault);
      expect(code).toBe(1);
      expect(result.rows.some((row: any) => row.status === 'fail')).toBe(true);
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

  it.each(['missing-model', 'no-observer', 'one-model'] as const)(
    'records %s as unverified and exits 1',
    async (fault) => {
      const { code, result } = await runCli(fault);
      expect(code).toBe(1);
      expect(result.rows.some((row: any) => row.status === 'unverified')).toBe(
        true,
      );
      expect(result.rows.some((row: any) => row.status === 'fail')).toBe(false);
    },
  );

  it('refuses a non-isolated inventory before starting sessions', async () => {
    const { code, requests, result } = await runCli('isolation');
    expect(code).toBe(1);
    expect(result).toBeNull();
    expect(requests.map((request) => request.url)).toEqual([
      '/api/connections/agents',
    ]);
  });
});
