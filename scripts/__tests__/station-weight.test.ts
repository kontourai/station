import {
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  contextSwitchDelta,
  evaluateRun,
  formatAttribution,
  hostFingerprint,
  hostFingerprintInputs,
  IDLE_CPU_GAP,
  idleCpuMetric,
  killEligibility,
  LEFTOVER_GAP,
  linuxProcessTable,
  measureRequestConversation,
  memoryByRole,
  ownedTree,
  parseFootprint,
  parseProcStat,
  processRole,
  processTable,
  recordedRoots,
  restMetric,
  runOwnership,
  runTagging,
  runTagKind,
  sampleTreeCpu,
  serverHeapReport,
  signalIfSame,
  spawnControlChild,
  taggedRows,
  withMemory,
} from '../bench/station-weight.mjs';
import {
  evaluateBudgets,
  formatValue,
  formatVerdicts,
  gateOutcome,
  recordBaseline,
  STATION_WEIGHT_BUDGETS,
} from '../bench/station-weight-budgets.mjs';
import {
  analyzeConversationTurn,
  diffAgainstControl,
  findTurnRequest,
  markersReached,
  requestConversationTurns,
  summarizeRequest,
} from '../bench/station-weight-request.mjs';
import {
  STUB_MAX_BODY_BYTES,
  STUB_REPLY_TEXT,
  startStubAnthropic,
} from '../bench/station-weight-stub.mjs';
import { darwinWakeupMetric } from '../bench/station-weight-wakeups.mjs';

const stubs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
});

async function stub() {
  const started = await startStubAnthropic();
  stubs.push(started);
  return started;
}

const ENGINE_TOOLS = [
  {
    name: 'Bash',
    description: 'Run a command.',
    input_schema: { type: 'object' as const },
  },
  {
    name: 'Read',
    description: 'Read a file.',
    input_schema: { type: 'object' as const },
  },
];

/** A turn shaped like the engine's: system blocks, a system message, tools. */
function engineTurn({
  sessionId,
  versionSuffix,
  userText,
  extraLines = [],
  extraTools = [],
}: {
  sessionId: string;
  versionSuffix: string;
  userText: string;
  extraLines?: string[];
  extraTools?: typeof ENGINE_TOOLS;
}) {
  return {
    model: 'claude-sonnet-5-5',
    max_tokens: 1024,
    // Where the engine sends its session id (recorded runs): not in any text.
    metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
    system: [
      {
        type: 'text' as const,
        text: `x-anthropic-billing-header: cc_version=2.1.318.${versionSuffix}; cc_entrypoint=sdk-ts;`,
      },
      { type: 'text' as const, text: 'You are a Claude agent.' },
    ],
    tools: [...ENGINE_TOOLS, ...extraTools],
    messages: [
      {
        role: 'user' as 'user' | 'assistant',
        content: [
          {
            type: 'text' as const,
            text: ['Deferred tools:', 'WebFetch', ...extraLines].join('\n'),
          },
          { type: 'text' as const, text: userText },
        ],
      },
    ],
  };
}

async function sendThrough(
  endpoint: { url: string },
  body: ReturnType<typeof engineTurn>,
) {
  const client = new Anthropic({ baseURL: endpoint.url, apiKey: 'not-a-key' });
  const stream = client.messages.stream(body);
  return (await stream.finalMessage()).content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

const INJECTED = '[Station preamble: something Station tells the engine]';

const makeTempDir = trackTempDirs();

describe('station-weight stub endpoint', () => {
  test('answers a real streaming client and records the request without credentials', async () => {
    const endpoint = await stub();
    const body = engineTurn({
      sessionId: 'a',
      versionSuffix: 'aaa',
      userText: 'hi',
    });
    expect(await sendThrough(endpoint, body)).toBe(STUB_REPLY_TEXT);
    expect(endpoint.requests).toHaveLength(1);
    const [recorded] = endpoint.requests;
    expect(recorded).toMatchObject({ method: 'POST', path: '/v1/messages' });
    expect(recorded.body).toMatchObject({ model: body.model, stream: true });
    expect(Object.keys(recorded.headers)).not.toContain('x-api-key');
    expect(Object.keys(recorded.headers)).not.toContain('authorization');
  });

  test('records an unmodelled route as a 404 instead of answering it', async () => {
    const endpoint = await stub();
    const response = await fetch(`${endpoint.url}/v1/models`);
    expect(response.status).toBe(404);
    expect(endpoint.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/models',
    ]);
  });

  test('refuses a body one byte over its bound rather than truncating it', async () => {
    const endpoint = await stub();
    const response = await fetch(`${endpoint.url}/v1/messages`, {
      method: 'POST',
      body: 'x'.repeat(STUB_MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(endpoint.requests[0]).toMatchObject({
      refused: 'body-too-large',
      body: null,
    });
  });
});

describe('station-weight request analysis', () => {
  test.each(['refused dispatch', 'replayed completion'])(
    'the diagnostic caller fails closed on %s',
    async (fault) => {
      const turns = requestConversationTurns('caller');
      const result = await measureRequestConversation({
        api: {
          call: async (method: string) =>
            method === 'POST'
              ? fault === 'refused dispatch'
                ? { status: 409, json: { success: false }, text: 'refused' }
                : {
                    status: 200,
                    json: {
                      data: {
                        sessionId: 'session',
                        providerTurnId: 'old-turn',
                      },
                    },
                    text: '',
                  }
              : {
                  status: 200,
                  json: {
                    data: {
                      events: [
                        {
                          method: 'turn.completed',
                          turnId: 'old-turn',
                          finishReason: 'stop',
                          outputText: 'ok',
                        },
                      ],
                    },
                  },
                  text: '',
                },
        },
        cwd: process.cwd(),
        env: {},
        executable: process.execPath,
        turns,
        markers: {},
        stub: { requests: [] },
        sideCallWindowMs: 0,
      });
      expect(result.status).toBe('not_measured');
      expect(
        result.turns.map((turn: { status: string }) => turn.status),
      ).toEqual(['not_measured', 'not_measured', 'not_measured']);
      expect(result.reason).toContain(
        fault === 'refused dispatch' ? 'HTTP 409' : 'expected successful reply',
      );
      const evaluated = evaluateRun(
        { ...resultAtBaseline(), requestConversation: result },
        { reportOnly: true },
      );
      expect(evaluated.gate.passed).toBe(false);
      expect(evaluated.gate.reasons.join()).toContain(
        'request conversation NOT_MEASURED',
      );
    },
  );

  test('pairs HTTP-captured ordinals, observes duplicated guidance and rejects missing rules or replayed history', async () => {
    const turns = requestConversationTurns('fixture');
    const endpoint = await startStubAnthropic({ turns });
    stubs.push(endpoint);
    const rules = { claudeMd: 'fixture-claude', agentsMd: 'fixture-agents' };
    const first = engineTurn({
      sessionId: 'station',
      versionSuffix: 'aaa',
      userText: turns[0].prompt,
      extraLines: Object.values(rules),
    });
    expect(await sendThrough(endpoint, first)).toBe(turns[0].reply);
    const firstAnalysis = analyzeConversationTurn({
      calls: endpoint.requests.slice(0, 1),
      turns,
      index: 0,
      markers: rules,
    });
    const next = structuredClone(first);
    next.messages.push(
      { role: 'assistant', content: [{ type: 'text', text: turns[0].reply }] },
      { role: 'user', content: [{ type: 'text', text: turns[1].prompt }] },
    );
    await sendThrough(endpoint, next);
    const second = analyzeConversationTurn({
      calls: endpoint.requests.slice(1, 2),
      turns,
      index: 1,
      markers: rules,
      previous: firstAnalysis.request.body,
    });
    expect(second.report.text.repeatedFromPrevious.bytes).toBeGreaterThan(0);
    expect(second.report.text.newSincePrevious.excerpts).toEqual([
      turns[0].reply,
      turns[1].prompt,
    ]);
    const duplicate = structuredClone(next);
    duplicate.system.push({
      type: 'text',
      text: 'Station guidance\nStation guidance',
    });
    await sendThrough(endpoint, duplicate);
    const changed = analyzeConversationTurn({
      calls: endpoint.requests.slice(2, 3),
      turns,
      index: 1,
      markers: rules,
    });
    expect(
      diffAgainstControl(changed.request.body, second.request.body).addedText,
    ).toMatchObject({
      bytes: 34,
      lineCount: 2,
      excerpts: ['Station guidance', 'Station guidance'],
    });
    for (const [name, broken, reason] of [
      [
        'missing rules',
        {
          ...next,
          messages: next.messages.map((message, index) =>
            index
              ? message
              : {
                  ...message,
                  content: [{ type: 'text', text: turns[0].prompt }],
                },
          ),
        },
        'repository rules missing',
      ],
      [
        'replayed reply',
        {
          ...next,
          messages: next.messages.map((message) =>
            message.role === 'assistant'
              ? { ...message, content: [{ type: 'text', text: 'ok' }] }
              : message,
          ),
        },
        'history',
      ],
      [
        'reply after next prompt',
        {
          ...next,
          messages: [next.messages[0], next.messages[2], next.messages[1]],
        },
        'interleaved history',
      ],
      [
        'skipped ordinal',
        { ...next, messages: [next.messages.at(-1)] },
        'history',
      ],
    ] as const) {
      const from = endpoint.requests.length;
      await sendThrough(endpoint, broken as typeof first);
      expect(
        () =>
          analyzeConversationTurn({
            calls: endpoint.requests.slice(from),
            turns,
            index: 1,
            markers: rules,
          }),
        name,
      ).toThrow(reason);
    }
    expect(() =>
      analyzeConversationTurn({
        calls: endpoint.requests.slice(1, 3),
        turns,
        index: 1,
        markers: rules,
      }),
    ).toThrow('expected one request, found 2');
  });

  test('isolates exactly what the Station turn adds beyond the control turn', async () => {
    const endpoint = await stub();
    await sendThrough(
      endpoint,
      engineTurn({
        sessionId: crypto.randomUUID(),
        versionSuffix: 'c01',
        userText: 'hi',
      }),
    );
    await sendThrough(
      endpoint,
      engineTurn({
        sessionId: crypto.randomUUID(),
        versionSuffix: 'f9e',
        userText: `${INJECTED}\nhi`,
        extraLines: ['mcp__station-browser__browser_open'],
        extraTools: [
          {
            name: 'AskUserQuestion',
            description: 'Ask.',
            input_schema: { type: 'object' as const },
          },
        ],
      }),
    );
    const [control, station] = endpoint.requests.map((request) =>
      findTurnRequest([request], 'hi'),
    );
    expect(control).toBeDefined();
    expect(station).toBeDefined();
    const diff = diffAgainstControl(station.body, control.body);
    // Session ids (in metadata) and the per-request version suffix cancel out.
    expect(diff.addedText.excerpts).toEqual([
      'mcp__station-browser__browser_open',
      INJECTED,
    ]);
    expect(diff.addedText.bytes).toBe(
      Buffer.byteLength(INJECTED) +
        1 +
        'mcp__station-browser__browser_open'.length +
        1,
    );
    expect(diff.removedText.lineCount).toBe(0);
    expect(diff.addedTools).toEqual(['AskUserQuestion']);
    expect(diff.addedNamedTools).toEqual([
      'mcp__station-browser__browser_open',
    ]);
    const summary = summarizeRequest(station.body, station.bodyBytes);
    expect(summary).toMatchObject({
      claudeCodeVersion: '2.1.318',
      toolCount: 3,
      mcpTools: {
        loadedCount: 0,
        namedOnlyCount: 1,
        byServer: { 'station-browser': 1 },
      },
    });
    expect(
      markersReached(station.body, { injected: INJECTED, absent: 'nope' }),
    ).toEqual({
      injected: true,
      absent: false,
    });
  });

  test('does not mistake a tool-less side call for the turn', async () => {
    const endpoint = await stub();
    const side = engineTurn({
      sessionId: 'x',
      versionSuffix: 'a',
      userText: 'hi',
    });
    await sendThrough(endpoint, { ...side, tools: [] });
    expect(findTurnRequest(endpoint.requests, 'hi')).toBeUndefined();
  });
});

describe('station-weight request diff blind spots', () => {
  const control = () =>
    engineTurn({ sessionId: 'c', versionSuffix: 'a', userText: 'hi' });

  test('a tool Station keeps by name but whose definition grew counts its growth', () => {
    const station = control();
    const added = 'x'.repeat(190_000);
    station.tools = station.tools.map((tool) =>
      tool.name === 'Bash'
        ? { ...tool, description: `${tool.description}${added}` }
        : tool,
    );
    const diff = diffAgainstControl(station, control());
    expect(diff.addedTools).toEqual([]);
    expect(diff.changedTools).toEqual([
      expect.objectContaining({ name: 'Bash', growthBytes: 190_000 }),
    ]);
    expect(diff.addedToolDefinitionBytes).toBe(190_000);
  });

  test('a definition grown with hex text counts every byte it grew', () => {
    // Hex runs and ids are not normalized inside a definition: a description
    // growing from 32 to 190,000 hex characters is 189,968 bytes of growth.
    const hex = (length: number) => 'a1'.repeat(length / 2);
    const withBash = (description: string) => {
      const turn = control();
      turn.tools = turn.tools.map((tool) =>
        tool.name === 'Bash' ? { ...tool, description } : tool,
      );
      return turn;
    };
    const diff = diffAgainstControl(withBash(hex(190_000)), withBash(hex(32)));
    expect(diff.changedTools).toEqual([
      expect.objectContaining({ name: 'Bash', growthBytes: 189_968 }),
    ]);
    expect(diff.addedToolDefinitionBytes).toBe(189_968);
  });

  test('a line differing only by an id or a hex run is Station text', () => {
    const station = control();
    const ours = `Station run ${crypto.randomUUID()} ${'f'.repeat(40)}`;
    const theirs = `Station run ${crypto.randomUUID()} ${'0'.repeat(40)}`;
    station.messages[0].content.push({ type: 'text' as const, text: ours });
    const reference = control();
    reference.messages[0].content.push({ type: 'text' as const, text: theirs });
    const diff = diffAgainstControl(station, reference);
    expect(diff.addedText.bytes).toBe(Buffer.byteLength(ours) + 1);
    expect(diff.removedText.bytes).toBe(Buffer.byteLength(theirs) + 1);
  });

  test('only the billing header version suffix is normalized', () => {
    const station = engineTurn({
      sessionId: 's',
      versionSuffix: 'f9e',
      userText: 'hi',
    });
    expect(diffAgainstControl(station, control()).addedText.lineCount).toBe(0);
    // The same stamp anywhere but the billing header is ordinary text: lines
    // both requests carry, differing only by that suffix, are different
    // lines. A normalizer applied to every line would make them equal.
    const reference = control();
    for (const [turn, suffix] of [
      [station, 'f9e'],
      [reference, 'a25'],
    ] as const)
      turn.messages[0].content.push({
        type: 'text' as const,
        text: `cc_version=2.1.318.${suffix}`,
      });
    const diff = diffAgainstControl(station, reference);
    expect(diff.addedText.bytes).toBe('cc_version=2.1.318.f9e'.length + 1);
    expect(diff.removedText.bytes).toBe('cc_version=2.1.318.a25'.length + 1);
  });

  test('an unchanged tool set adds no definition bytes', () => {
    const diff = diffAgainstControl(control(), control());
    expect(diff.changedTools).toEqual([]);
    expect(diff.addedToolDefinitionBytes).toBe(0);
  });

  test('blank lines are text bytes the engine receives', () => {
    const station = control();
    station.messages[0].content.push({
      type: 'text' as const,
      text: '\n'.repeat(100_000),
    });
    const diff = diffAgainstControl(station, control());
    // 100,000 newlines split into 100,001 empty lines, one byte each.
    expect(diff.addedText.bytes).toBe(100_001);
    expect(diff.addedText.blankLineCount).toBe(100_001);
    expect(diff.addedText.excerpts).toEqual([]);
  });

  test('added text is sized from the text sent, not the normalized key', () => {
    const station = control();
    const line = `Station session ${crypto.randomUUID()}`;
    station.messages[0].content.push({ type: 'text' as const, text: line });
    expect(diffAgainstControl(station, control()).addedText.bytes).toBe(
      Buffer.byteLength(line) + 1,
    );
  });
});

const HOST = { label: 'testos-arm64', fingerprint: '0123456789abcdef' };
const OTHER_HOST = { label: 'testos-arm64', fingerprint: 'fedcba9876543210' };

/** A baseline fixture: one host, the request values, zero leftover. */
const FIXTURE_BASELINE = {
  schemaVersion: 2,
  request: {
    sourceRevision: 'r',
    recordedAt: 't',
    claudeCodeVersion: '2.1.318',
    values: {
      'request.stationAddedTextBytes': 1000,
      'request.stationAddedToolCount': 20,
      'request.stationAddedToolDefinitionBytes': 4500,
      'request.sideCallCount': 0,
    },
  },
  hosts: {
    [HOST.fingerprint]: {
      platform: HOST.label,
      sourceRevision: 'r',
      recordedAt: 't',
      values: {
        restMemoryBytes: 1_000_000_000,
        idleSessionsMemoryBytes: 1_500_000_000,
        idleCpuPercent: 0.2,
        leftoverAfterStopMemoryBytes: 0,
      },
    },
  },
};

type Metric = { status: string; value?: number; unit: string; reason?: string };

/** A completed result shaped as runStationWeight writes it, at the fixture values. */
function resultAtBaseline(host = HOST) {
  const metrics: Record<string, Metric> = { serverReadyMs: measuredAt(5000) };
  for (const [id, value] of Object.entries({
    ...FIXTURE_BASELINE.request.values,
    ...FIXTURE_BASELINE.hosts[HOST.fingerprint].values,
  }))
    metrics[id] = measuredAt(value);
  return {
    outcome: 'completed',
    dirty: false,
    sourceRevision: 'abc',
    startedAt: '2026-01-01T00:00:00.000Z',
    host: { ...host },
    metrics,
    request: { station: { claudeCodeVersion: '2.1.318' } },
    repoRules: { claudeMd: true, agentsMd: true } as Record<string, unknown>,
  };
}

function measuredAt(value: number): Metric {
  return { status: 'measured', value, unit: 'x' };
}

const verdictOf = (
  verdicts: Array<{ id: string; verdict: string }>,
  id: string,
) => verdicts.find((entry) => entry.id === id)?.verdict;

describe('matched delegated benchmark evidence', () => {
  test('saved pairs cannot replace the baseline or qualify an incomplete pair', () => {
    const baselinePath = join(
      makeTempDir('station-weight-pair-'),
      'baseline.json',
    );
    const before = JSON.stringify(FIXTURE_BASELINE);
    writeFileSync(baselinePath, before);
    const result = {
      ...resultAtBaseline(),
      settings: { delegatedPair: 1 },
      delegatedPair: {
        status: 'measured',
        followUpOrder: 'warm-first',
        model: 'fixture-model',
        claudeCodeVersion: '2.1.322',
        memoryBasis: 'phys_footprint',
        releasedEngineMemoryBytes: 147_000_000,
        releasedAfterMs: 15_100,
        warmFollowUpMs: 175,
        parkedFollowUpMs: 320,
      },
    };

    expect(
      evaluateRun({ ...result }, { baselinePath, record: true }).gate,
    ).toMatchObject({
      passed: false,
      reasons: [expect.stringContaining('cannot record a baseline')],
    });
    expect(readFileSync(baselinePath, 'utf8')).toBe(before);
    expect(evaluateRun({ ...result }, { baselinePath }).gate.passed).toBe(
      false,
    );
    expect(
      evaluateRun({ ...result }, { baselinePath, reportOnly: true }).gate,
    ).toMatchObject({ passed: true, comparedCount: 0 });
    expect(
      evaluateRun(
        { ...result, delegatedPair: { status: 'measured' } },
        { baselinePath, reportOnly: true },
      ).gate,
    ).toMatchObject({
      passed: false,
      reasons: [
        expect.stringContaining('missing or invalid paired observations'),
      ],
    });
    expect(
      evaluateRun(
        {
          ...result,
          delegatedPair: {
            status: 'not_measured',
            reason: 'engine did not exit',
          },
        },
        { baselinePath, reportOnly: true },
      ).gate,
    ).toMatchObject({
      passed: false,
      reasons: ['delegated pair NOT_MEASURED: engine did not exit'],
    });
  });
});

describe('station-weight control engine signals (rule C)', () => {
  /** A child as Node's spawn returns it, recording each signal it is sent. */
  const fakeSpawn = () => {
    const sent: string[] = [];
    const calls: unknown[][] = [];
    const child = {
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal: string) {
        sent.push(signal);
        return true;
      },
    };
    const spawnChild = (...args: unknown[]) => {
      calls.push(args);
      return child;
    };
    return { child, sent, calls, spawnChild };
  };
  const options = {
    command: '/bin/claude',
    args: ['--print'],
    cwd: '/repo',
    env: { HOME: '/home' },
    signal: new AbortController().signal,
  };

  test('the SDK and the run signal a control child only until Node records its exit', () => {
    for (const exit of [
      { exitCode: 0, signalCode: null },
      { exitCode: null, signalCode: 'SIGTERM' },
    ]) {
      const fake = fakeSpawn();
      const child = spawnControlChild(options, fake.spawnChild as never);
      expect(fake.calls).toEqual([
        [
          '/bin/claude',
          ['--print'],
          {
            cwd: '/repo',
            env: { HOME: '/home' },
            signal: options.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          },
        ],
      ]);
      // Unreaped: the handle's own kill runs.
      expect(child.kill('SIGTERM')).toBe(true);
      expect(fake.sent).toEqual(['SIGTERM']);
      // Reaped: whatever calls kill (the SDK's escalation timer, its
      // kill-all on exit, the abort signal), nothing is sent.
      Object.assign(fake.child, exit);
      expect(child.kill('SIGKILL')).toBe(false);
      expect(fake.sent).toEqual(['SIGTERM']);
    }
  });
});

describe('station-weight budgets', () => {
  test('a run at its baseline compares every comparable budget and passes', () => {
    const verdicts = evaluateBudgets(resultAtBaseline(), FIXTURE_BASELINE);
    for (const budget of STATION_WEIGHT_BUDGETS)
      expect(verdictOf(verdicts, budget.id), budget.id).toBe(
        budget.scope === 'report' ? 'REPORTED' : 'PASS',
      );
    expect(gateOutcome(resultAtBaseline(), verdicts)).toMatchObject({
      passed: true,
      comparedCount: 8,
    });
  });

  test('injected text growing past its headroom fails; within headroom and shrinking pass', () => {
    const base =
      FIXTURE_BASELINE.request.values['request.stationAddedTextBytes'];
    const at = (value: number) => {
      const result = resultAtBaseline();
      result.metrics['request.stationAddedTextBytes'].value = value;
      return verdictOf(
        evaluateBudgets(result, FIXTURE_BASELINE),
        'request.stationAddedTextBytes',
      );
    };
    expect(at(Math.floor(base * 1.1))).toBe('PASS');
    expect(at(Math.ceil(base * 1.1) + 1)).toBe('FAIL');
    expect(at(0)).toBe('PASS');
  });

  test('a new side call fails even though counts otherwise carry headroom', () => {
    const result = resultAtBaseline();
    result.metrics['request.sideCallCount'].value = 1;
    expect(
      verdictOf(
        evaluateBudgets(result, FIXTURE_BASELINE),
        'request.sideCallCount',
      ),
    ).toBe('FAIL');
  });

  test('a process left alive after stop fails a zero leftover baseline', () => {
    const result = resultAtBaseline();
    const id = 'leftoverAfterStopMemoryBytes';
    expect(FIXTURE_BASELINE.hosts[HOST.fingerprint].values[id]).toBe(0);
    result.metrics[id].value = 4096;
    expect(verdictOf(evaluateBudgets(result, FIXTURE_BASELINE), id)).toBe(
      'FAIL',
    );
    result.metrics[id].value = 0;
    expect(verdictOf(evaluateBudgets(result, FIXTURE_BASELINE), id)).toBe(
      'PASS',
    );
  });

  test('idle CPU near zero has an additive floor of one percentage point', () => {
    const result = resultAtBaseline();
    const base = FIXTURE_BASELINE.hosts[HOST.fingerprint].values.idleCpuPercent;
    result.metrics.idleCpuPercent.value = base * 2 + 0.99;
    expect(
      verdictOf(evaluateBudgets(result, FIXTURE_BASELINE), 'idleCpuPercent'),
    ).toBe('PASS');
    result.metrics.idleCpuPercent.value = base * 2 + 1.01;
    expect(
      verdictOf(evaluateBudgets(result, FIXTURE_BASELINE), 'idleCpuPercent'),
    ).toBe('FAIL');
  });

  test('ready time is reported, never compared, however large', () => {
    const result = resultAtBaseline();
    result.metrics.serverReadyMs.value = 10 ** 9;
    const verdicts = evaluateBudgets(result, FIXTURE_BASELINE);
    expect(verdictOf(verdicts, 'serverReadyMs')).toBe('REPORTED');
    expect(gateOutcome(result, verdicts).passed).toBe(true);
  });

  test('ready time missing, unmeasured or non-finite never reaches the gate', () => {
    const variants: Array<[string, (metrics: Record<string, Metric>) => void]> =
      [
        ['absent', (metrics) => delete metrics.serverReadyMs],
        [
          'not measured',
          (metrics) => {
            metrics.serverReadyMs = {
              status: 'not_measured',
              unit: 'ms',
              reason: 'never ready',
            };
          },
        ],
        [
          'not finite',
          (metrics) => {
            metrics.serverReadyMs.value = Number.NaN;
          },
        ],
      ];
    for (const [label, change] of variants) {
      const result = resultAtBaseline();
      change(result.metrics);
      const verdicts = evaluateBudgets(result, FIXTURE_BASELINE);
      expect(verdictOf(verdicts, 'serverReadyMs'), label).toBe('REPORTED');
      expect(gateOutcome(result, verdicts), label).toMatchObject({
        passed: true,
        reasons: [],
        comparedCount: 8,
      });
      expect(formatVerdicts(verdicts).join('\n'), label).toContain(
        'REPORTED serverReadyMs',
      );
    }
  });

  test('a non-finite value prints as null in memory, as it does once saved', () => {
    expect(formatValue(Number.NaN)).toBe('null');
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('null');
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe('null');
    expect(formatValue(null)).toBe('null');
    expect(formatValue(1.234)).toBe(1.23);
    const result = resultAtBaseline();
    result.metrics.serverReadyMs.value = Number.NaN;
    expect(
      formatVerdicts(evaluateBudgets(result, FIXTURE_BASELINE)).join('\n'),
    ).toContain(
      'REPORTED serverReadyMs measured without a finite value (null)',
    );
  });

  test('host budgets compare only against the same host fingerprint; request budgets compare everywhere', () => {
    const result = resultAtBaseline(OTHER_HOST);
    const verdicts = evaluateBudgets(result, FIXTURE_BASELINE);
    for (const budget of STATION_WEIGHT_BUDGETS)
      expect(verdictOf(verdicts, budget.id), budget.id).toBe(
        { host: 'NOT_MEASURED', request: 'PASS', report: 'REPORTED' }[
          budget.scope
        ],
      );
    expect(
      verdicts.find((entry) => entry.id === 'restMemoryBytes'),
    ).toMatchObject({
      reason: expect.stringContaining(OTHER_HOST.fingerprint),
    });
  });
});

describe('station-weight gate', () => {
  test('a budget that should have been compared and was not fails the gate', () => {
    const result = resultAtBaseline();
    result.metrics['request.stationAddedTextBytes'] = {
      status: 'not_measured',
      unit: 'bytes',
      reason: 'Claude engine not ready: timed out',
    };
    const gate = gateOutcome(result, evaluateBudgets(result, FIXTURE_BASELINE));
    expect(gate.passed).toBe(false);
    expect(gate.reasons.join()).toContain('request.stationAddedTextBytes');
  });

  test('with no baseline every budget is NOT_MEASURED and the gate fails', () => {
    const result = resultAtBaseline();
    const verdicts = evaluateBudgets(result, undefined);
    expect(
      verdicts.filter((entry) => entry.verdict === 'NOT_MEASURED'),
    ).toHaveLength(8);
    expect(gateOutcome(result, verdicts)).toMatchObject({
      passed: false,
      comparedCount: 0,
    });
  });

  test('a repository instruction file missing from the first request fails the gate and refuses a baseline', () => {
    const cases: Array<[string, Record<string, unknown> | undefined, string]> =
      [
        [
          'AGENTS.md not reached',
          { claudeMd: true, agentsMd: false },
          'did not reach the first request: agentsMd',
        ],
        [
          'AGENTS.md absent from the result',
          { claudeMd: true },
          'did not reach the first request: agentsMd',
        ],
        [
          'neither reached',
          { claudeMd: false, agentsMd: false },
          'did not reach the first request: claudeMd, agentsMd',
        ],
        [
          'not measured',
          { status: 'not_measured', reason: 'Claude engine not ready' },
          'repoRules not measured: Claude engine not ready',
        ],
        ['no repoRules at all', undefined, 'claudeMd, agentsMd'],
      ];
    for (const [label, repoRules, reason] of cases) {
      const result = { ...resultAtBaseline(), repoRules };
      const verdicts = evaluateBudgets(result, FIXTURE_BASELINE);
      // Every budget passes: only the instruction files fail the run.
      expect(
        verdicts.map((entry) => entry.verdict),
        label,
      ).not.toContain('FAIL');
      const gate = gateOutcome(result, verdicts);
      expect(gate.passed, label).toBe(false);
      expect(gate.reasons.join('\n'), label).toContain(reason);
      // Report-only skips the baseline, not the measurement.
      expect(
        gateOutcome(
          result,
          evaluateBudgets(result, undefined, { reportOnly: true }),
          { reportOnly: true },
        ).passed,
        label,
      ).toBe(false);
      expect(() => recordBaseline(result, FIXTURE_BASELINE), label).toThrow(
        reason,
      );
    }
    // Control: both reached, the same run passes.
    const passing = resultAtBaseline();
    expect(
      gateOutcome(passing, evaluateBudgets(passing, FIXTURE_BASELINE)).passed,
    ).toBe(true);
  });

  test('a run that did not complete fails even with nothing over budget', () => {
    const result = { ...resultAtBaseline(), outcome: 'failed', error: 'boom' };
    expect(
      gateOutcome(result, evaluateBudgets(result, FIXTURE_BASELINE)),
    ).toMatchObject({ passed: false, reasons: ['run failed: boom'] });
  });

  test('report-only compares nothing, says so, and still fails a gap', () => {
    const result = resultAtBaseline(OTHER_HOST);
    const verdicts = evaluateBudgets(result, undefined, { reportOnly: true });
    expect(verdicts.map((entry) => entry.verdict)).not.toContain('PASS');
    const gate = gateOutcome(result, verdicts, { reportOnly: true });
    expect(gate).toMatchObject({ passed: true, comparedCount: 0 });
    expect(gate.summary).toMatch(/^REPORT_ONLY compared nothing/);
    result.metrics.restMemoryBytes = {
      status: 'not_measured',
      unit: 'bytes',
      reason: 'tree memory did not settle',
    };
    expect(
      gateOutcome(
        result,
        evaluateBudgets(result, undefined, { reportOnly: true }),
        { reportOnly: true },
      ).passed,
    ).toBe(false);
  });
});

describe('station-weight measured-nothing guards', () => {
  test('an empty process tree is NOT_MEASURED, never zero memory', () => {
    const metric = restMetric({
      rows: [],
      stable: true,
      settledAfterMs: 1,
      samples: [0, 0],
    });
    expect(metric).toMatchObject({ status: 'not_measured' });
    expect(metric).not.toHaveProperty('value');
  });

  test('an empty process tree is NOT_MEASURED, never zero CPU', () => {
    const metric = idleCpuMetric(
      {
        cpuSeconds: 0,
        windowSeconds: 30,
        samples: 120,
        firstRows: [],
        endRows: [],
        exitedDuringWindow: 0,
        maxReadSpanMs: 260,
      },
      250,
    );
    expect(metric).toMatchObject({ status: 'not_measured' });
    expect(metric.gap).toBe(
      IDLE_CPU_GAP({ intervalMs: 250, maxReadSpanMs: 260 }),
    );
  });
});

describe('station-weight idle CPU gap', () => {
  test('a slow read widens the stated gap to the span actually observed', async () => {
    // Each read blocks for 150 ms against a 100 ms interval, as a loaded
    // host's `ps` or /proc walk does: reads are 250 ms or more apart.
    const row = {
      pid: 1,
      ppid: 0,
      rssBytes: 0,
      cpuSeconds: 0,
      started: 'a',
      command: 'node',
    };
    const slowSnapshot = () => {
      const until = performance.now() + 150;
      while (performance.now() < until);
      return [row];
    };
    const sampled = await sampleTreeCpu(slowSnapshot, {
      windowMs: 800,
      intervalMs: 100,
    });
    expect(sampled.maxReadSpanMs).toBeGreaterThanOrEqual(250);
    const metric = idleCpuMetric(sampled, 100);
    expect(metric.maxReadSpanMs).toBe(sampled.maxReadSpanMs);
    expect(metric.gap).toContain(
      `up to ${Math.ceil(sampled.maxReadSpanMs)} ms per process`,
    );
    expect(metric.gap).not.toMatch(/up to 100 ms/);
    expect(metric.gap).toContain('detaching before any read saw them');
  });
});

describe('station-weight baseline recording', () => {
  test('refuses an incomplete recording instead of deleting a reference', () => {
    const result = resultAtBaseline();
    result.metrics.restMemoryBytes = {
      status: 'not_measured',
      unit: 'bytes',
      reason: 'x',
    };
    expect(() => recordBaseline(result, FIXTURE_BASELINE)).toThrow(
      /incomplete baseline; not measured: restMemoryBytes/,
    );
  });

  test('refuses a run that did not complete or measured a dirty tree', () => {
    expect(() =>
      recordBaseline({ ...resultAtBaseline(), outcome: 'failed' }, undefined),
    ).toThrow(/failed run/);
    expect(() =>
      recordBaseline({ ...resultAtBaseline(), dirty: true }, undefined),
    ).toThrow(/dirty tree/);
  });

  test('keys host values by fingerprint, keeps other hosts, and stores no hardware detail', () => {
    const result = resultAtBaseline(OTHER_HOST);
    (result.host as Record<string, unknown>).fingerprintInputs = {
      hardwareModel: 'Secret1,1',
      cpuModel: 'Secret CPU',
      memoryGiB: 48,
    };
    const next = recordBaseline(result, FIXTURE_BASELINE);
    expect(next.hosts[HOST.fingerprint]).toEqual(
      FIXTURE_BASELINE.hosts[HOST.fingerprint],
    );
    expect(Object.keys(next.hosts[OTHER_HOST.fingerprint]).sort()).toEqual([
      'platform',
      'recordedAt',
      'sourceRevision',
      'values',
    ]);
    expect(next.hosts[OTHER_HOST.fingerprint].platform).toBe(OTHER_HOST.label);
    expect(JSON.stringify(next)).not.toMatch(/Secret|memoryGiB/);
  });
});

describe('station-weight host fingerprint', () => {
  const inputs = {
    platform: 'darwin',
    arch: 'arm64',
    model: 'Model1,1',
    cpuList: [{ model: 'CPU A' }, { model: 'CPU A' }],
    memoryBytes: 48 * 2 ** 30,
    osRelease: '25.6.0',
  };

  test('separates hosts that share a platform label', () => {
    const base = hostFingerprint(hostFingerprintInputs(inputs as never));
    for (const change of [
      { model: 'Model2,1' },
      { cpuList: [{ model: 'CPU B' }, { model: 'CPU B' }] },
      { cpuList: [{ model: 'CPU A' }] },
      { memoryBytes: 64 * 2 ** 30 },
      { osRelease: '26.0.0' },
    ])
      expect(
        hostFingerprint(
          hostFingerprintInputs({ ...inputs, ...change } as never),
        ),
        JSON.stringify(change),
      ).not.toBe(base);
    // A point release is the same host class.
    expect(
      hostFingerprint(
        hostFingerprintInputs({ ...inputs, osRelease: '25.7.1' } as never),
      ),
    ).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the committed baseline publishes only fingerprints and platform labels', () => {
    const committed = JSON.parse(
      readFileSync(
        join(__dirname, '../bench/station-weight-baseline.json'),
        'utf8',
      ),
    );
    expect(committed.schemaVersion).toBe(2);
    for (const [key, entry] of Object.entries(
      committed.hosts as Record<string, Record<string, unknown>>,
    )) {
      expect(key).toMatch(/^[0-9a-f]{16}$/);
      expect(Object.keys(entry).sort()).toEqual([
        'platform',
        'recordedAt',
        'sourceRevision',
        'values',
      ]);
      expect(entry.platform).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    }
    // The comparison a run makes must be possible from what is committed.
    expect(
      evaluateBudgets(
        resultAtBaseline({
          label: Object.values(
            committed.hosts as Record<string, { platform: string }>,
          )[0].platform,
          fingerprint: Object.keys(committed.hosts)[0],
        }),
        committed,
      ).filter((entry) => entry.verdict === 'NOT_MEASURED'),
    ).toEqual([]);
  });
});

describe('station-weight process identity', () => {
  const row = (pid: number, ppid: number, started: string) => ({
    pid,
    ppid,
    rssBytes: 0,
    cpuSeconds: 0,
    started,
    command: 'node',
  });

  test('a root whose pid now belongs to another process owns nothing', () => {
    const table = [row(100, 1, 'born-later'), row(101, 100, 'child')];
    expect(ownedTree(table, [{ pid: 100, started: 'recorded' }])).toEqual([]);
    expect(
      ownedTree(table, [{ pid: 100, started: 'born-later' }]).map(
        (entry) => entry.pid,
      ),
    ).toEqual([100, 101]);
  });

  test('roots come from the recorded fingerprints, not bare pids', () => {
    expect(
      recordedRoots({
        serverPid: 1,
        serverFingerprint: { pid: 1, startToken: 'a' },
        uiPid: 2,
        uiFingerprint: { pid: 2, startToken: 'b' },
      }),
    ).toEqual([
      { pid: 1, started: 'a' },
      { pid: 2, started: 'b' },
    ]);
    expect(() => recordedRoots({ serverPid: 1, uiPid: 2 })).toThrow(
      /no process fingerprints/,
    );
  });

  test('a Linux signal is sent only to a kill-eligible row whose exact birth still holds', () => {
    const killed: number[] = [];
    const outcome = signalIfSame(
      [
        { pid: 7, exactStart: 'linux:boot:500', killEligible: true },
        { pid: 8, exactStart: 'linux:boot:600', killEligible: true },
        { pid: 9, exactStart: 'linux:boot:700', killEligible: false },
        { pid: 10, killEligible: true },
        // An omitted flag is not eligible, even with a birth that holds.
        { pid: 11, exactStart: 'linux:boot:800' },
      ],
      'SIGKILL',
      {
        platform: 'linux',
        bootId: 'boot',
        readFile: linux(
          {
            // pid 7 now has another birth: reused.
            '/proc/7/stat': statLine(7, { start: 501 }),
            '/proc/8/stat': statLine(8, { start: 600 }),
            '/proc/9/stat': statLine(9, { start: 700 }),
            '/proc/10/stat': statLine(10),
            '/proc/11/stat': statLine(11, { start: 800 }),
          },
          [],
        ).readFile,
        kill: (pid: number) => {
          killed.push(pid);
          return true;
        },
      },
    );
    expect(killed).toEqual([8]);
    expect(outcome).toEqual({ signalled: [8], skipped: [9, 10, 11, 7] });
  });

  test('a macOS signal goes through the helper with the microsecond birth', () => {
    const calls: string[][] = [];
    const outcome = signalIfSame(
      [
        { pid: 8, exactStart: 'darwin:1700000005250000', killEligible: true },
        // A whole-second table token is not an exact birth.
        { pid: 9, exactStart: 'Tue Nov 14 22:13:25 2023', killEligible: true },
      ],
      'SIGKILL',
      {
        platform: 'darwin',
        run: (_command: string, args: string[]) => {
          calls.push(args.slice(3));
          return JSON.stringify({ signalled: [8], skipped: [] });
        },
      },
    );
    expect(calls).toEqual([['--signal=9', '8:1700000005250000']]);
    expect(outcome).toEqual({ signalled: [8], skipped: [9] });
  });

  test('only the nonce entry is kill-eligible; a recorded root without it is report-only', () => {
    const table = [
      row(1, 0, 'root'),
      row(2, 1, 'child'),
      row(3, 0, 'nonce'),
      row(4, 0, 'path'),
    ];
    const tagged = [
      { ...row(3, 0, 'nonce'), tag: 'nonce' as const, exactStart: 'x3' },
      { ...row(4, 0, 'path'), tag: 'path' as const, exactStart: 'x4' },
    ];
    const roots = [{ pid: 1, started: 'root' }];
    expect(
      killEligibility(ownedTree(table, [...roots, ...tagged]), tagged).map(
        (entry) => [entry.pid, entry.killEligible, entry.exactStart],
      ),
    ).toEqual([
      [1, false, undefined],
      [2, false, undefined],
      [3, true, 'x3'],
      [4, false, undefined],
    ]);
  });

  test('a recorded root is counted and followed but is not kill-eligible without the nonce', () => {
    const LSTART = 'Tue Nov 14 22:13:25 2023';
    const table = [row(50, 1, LSTART), row(51, 1, LSTART)];
    const ownership = runOwnership(
      runTagging({
        nonce: '12'.repeat(16),
        scratch: '/tmp/station-weight-v',
        startedAtMs: 0,
        uid: 501,
      }),
      {
        intervalMs: 60_000,
        read: () => table,
        tagOptions: { platform: 'darwin', readArguments: () => new Map() },
      },
    );
    try {
      const roots = [
        { pid: 50, started: LSTART },
        { pid: 51, started: LSTART },
      ];
      expect(ownership.setRoots(roots)).toBe(2);
      expect(ownership.setRoots(roots)).toBe(0);
      expect(
        ownership
          .leftover(table)
          .map((entry) => [entry.pid, entry.killEligible]),
      ).toEqual([
        [50, false],
        [51, false],
      ]);
      // The follower's own first read found both roots.
      expect(ownership.follow().rootsFollowed).toEqual(roots);
      expect(ownership.follow().roots).toEqual(
        roots.map((root) => ({ ...root, learnedAt: expect.any(String) })),
      );
    } finally {
      ownership.stop();
    }
  });

  test('the follower reports the longest interval between reads, a stalled event loop included', async () => {
    const ownership = runOwnership(
      runTagging({
        nonce: '34'.repeat(16),
        scratch: '/tmp/station-weight-u',
        startedAtMs: 0,
        uid: 501,
      }),
      {
        intervalMs: 20,
        read: () => [row(60, 1, 'x')],
      },
    );
    try {
      ownership.setRoots([{ pid: 60, started: 'x' }]);
      await wait(100);
      // Synchronous work holds the follower's timer, as a footprint or
      // environment read does in a run.
      const until = performance.now() + 400;
      while (performance.now() < until);
      await wait(100);
      const follow = ownership.follow();
      expect(follow.reads).toBeGreaterThan(3);
      expect(follow.maxIntervalMs).toBeGreaterThanOrEqual(400);
      expect(LEFTOVER_GAP(follow)).toContain(
        `the longest interval observed between the starts of two reads was ${Math.ceil(follow.maxIntervalMs)} ms`,
      );
    } finally {
      ownership.stop();
    }
  });

  /** proc(5) stat line: ppid, utime, stime, start ticks and RSS pages. */
  const statLine = (
    pid: number,
    { ppid = 1, utime = 0, stime = 0, start = 1000, rss = 0 } = {},
  ) =>
    `${pid} (node worker) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0 ${utime} ${stime} 0 0 20 0 11 0 ${start} 1000 ${rss}`;
  const linux = (files: Record<string, string | string[]>, pids: number[]) => {
    const reads = new Map<string, number>();
    return {
      readFile: (path: string) => {
        const entry = files[path];
        if (entry === undefined) throw new Error(`ENOENT ${path}`);
        const index = reads.get(path) ?? 0;
        reads.set(path, index + 1);
        return Array.isArray(entry)
          ? entry[Math.min(index, entry.length - 1)]
          : entry;
      },
      listPids: () => pids,
      bootId: 'boot',
      hz: 100,
      pageSize: 4096,
      bootTimeSeconds: 1_700_000_000,
    };
  };
  const STATUS =
    'Name:\tnode\nUid:\t1000\t501\t501\t501\nvoluntary_ctxt_switches:\t7\nnonvoluntary_ctxt_switches:\t3\n';

  test('Linux rows take parent, CPU, birth and RSS from one /proc stat read', () => {
    expect(parseProcStat(statLine(4242, { utime: 37, stime: 14 }))).toEqual({
      command: 'node worker',
      ppid: 1,
      ticks: 51,
      startTicks: '1000',
      rssPages: 0,
    });
    const table = processTable(
      () => {
        throw new Error('ps is not consulted on Linux');
      },
      {
        platform: 'linux',
        linux: linux(
          {
            '/proc/4242/stat': statLine(4242, {
              ppid: 77,
              utime: 37,
              stime: 14,
              start: 123456,
              rss: 3,
            }),
            '/proc/4242/status': STATUS,
          },
          [4242, 4243],
        ),
      },
    );
    expect(table).toEqual([
      {
        pid: 4242,
        ppid: 77,
        uid: 501,
        rssBytes: 3 * 4096,
        cpuSeconds: 0.51,
        started: 'linux:boot:123456',
        startedAtMs: (1_700_000_000 + 1234.56) * 1000,
        contextSwitches: 10,
        command: 'node worker',
      },
    ]);
  });

  test('a Linux pid reused between its stat and status reads is dropped', () => {
    const table = linuxProcessTable(
      linux(
        {
          // The first read saw one process; by the recheck the pid was reused.
          '/proc/10/stat': [
            statLine(10, { ppid: 99, start: 500 }),
            statLine(10, { ppid: 1, start: 900 }),
          ],
          '/proc/10/status': STATUS,
          '/proc/11/stat': statLine(11, { start: 600 }),
          '/proc/11/status': STATUS,
        },
        [10, 11],
      ),
    );
    expect(table.map((entry) => entry.pid)).toEqual([11]);
  });

  test('a Linux environment counts only while the pid keeps the row birth', () => {
    const nonce = 'ab'.repeat(16);
    const tagging = runTagging({
      nonce,
      scratch: '/tmp/station-weight-x',
      startedAtMs: 1_700_000_000_000,
      uid: 501,
    });
    const tableRow = {
      ...row(10, 1, 'linux:boot:500'),
      uid: 501,
      startedAtMs: 1_700_000_005_000,
    };
    const tagged = (stat: string) =>
      taggedRows([tableRow], tagging, {
        platform: 'linux',
        readFile: linux(
          {
            '/proc/10/environ': `PATH=/bin\0STATION_WEIGHT_RUN=${nonce}\0`,
            '/proc/10/cmdline': 'node\0-e\0x\0',
            '/proc/10/stat': stat,
          },
          [10],
        ).readFile,
      }).map((entry) => entry.pid);
    expect(tagged(statLine(10, { start: 500 }))).toEqual([10]);
    // The environment read belonged to whatever reused pid 10.
    expect(tagged(statLine(10, { start: 900 }))).toEqual([]);
  });

  test('a malformed Linux environment is unreadable, never kill-eligible', () => {
    const nonce = '9a'.repeat(16);
    const tagging = runTagging({
      nonce,
      scratch: '/tmp/station-weight-v',
      startedAtMs: 1_700_000_000_000,
      uid: 501,
    });
    const tableRow = {
      ...row(12, 1, 'linux:boot:500'),
      uid: 501,
      startedAtMs: 1_700_000_005_000,
    };
    const ownership = (environ: string) => {
      const readFailures: Array<{
        pid: number;
        started: string;
        command: string;
        reason: string;
      }> = [];
      const rows = killEligibility(
        [tableRow],
        taggedRows([tableRow], tagging, {
          platform: 'linux',
          readFailures,
          readFile: linux(
            {
              '/proc/12/environ': environ,
              '/proc/12/cmdline': 'node\0-e\0x\0',
              '/proc/12/stat': statLine(12, { start: 500 }),
            },
            [12],
          ).readFile,
        }),
      );
      return {
        eligible: rows.filter((entry) => entry.killEligible).map((e) => e.pid),
        failures: readFailures.map(({ pid, reason }) => ({ pid, reason })),
      };
    };
    // Positive control: the same entry, terminated.
    expect(ownership(`PATH=/bin\0STATION_WEIGHT_RUN=${nonce}\0`)).toEqual({
      eligible: [12],
      failures: [],
    });
    expect(ownership('')).toEqual({ eligible: [], failures: [] });
    // The reviewer's probe: the tag as an unterminated last entry.
    expect(ownership(`PATH=/bin\0STATION_WEIGHT_RUN=${nonce}`)).toEqual({
      eligible: [],
      failures: [{ pid: 12, reason: 'unterminated environment entry 1' }],
    });
    expect(ownership(`STATION_WEIGHT_RUN=${nonce}`)).toEqual({
      eligible: [],
      failures: [{ pid: 12, reason: 'unterminated environment entry 0' }],
    });
    // Past the size an execve can hand a process (6 MiB).
    const oversized = `STATION_WEIGHT_RUN=${nonce}\0${'X=y\0'.repeat(1_600_000)}`;
    expect(ownership(oversized)).toEqual({
      eligible: [],
      failures: [
        {
          pid: 12,
          reason: `size ${Buffer.byteLength(oversized)} outside 0..6291456`,
        },
      ],
    });
  });

  test('only a whole environment entry carries the run tag', () => {
    const nonce = 'cd'.repeat(16);
    const scratch = '/tmp/station-weight-y';
    const tagging = runTagging({
      nonce,
      scratch,
      startedAtMs: 0,
      controlConfigDir: `${scratch}/claude-control`,
      uid: 501,
    });
    const kind = (...entries: string[]) => runTagKind(entries, tagging);
    expect(kind(`STATION_WEIGHT_RUN=${nonce}`)).toBe('nonce');
    expect(kind(`HOME=${scratch}/user`, `STATION_WEIGHT_RUN=${nonce}`)).toBe(
      'nonce',
    );
    expect(kind(`HOME=${scratch}/user`)).toBe('path');
    expect(kind(`TMPDIR=${scratch}/tmp/`)).toBe('path');
    expect(kind(`HOME=${scratch}`)).toBe('path');
    // The reviewer's cases: tag text inside another variable's value.
    expect(kind(`INNOCENT=before HOME=${scratch}/user after`)).toBe(null);
    expect(kind(`INNOCENT=before STATION_WEIGHT_RUN=${nonce} after`)).toBe(
      null,
    );
    // A sibling path that only shares the prefix, a relative path, another
    // variable, a longer nonce.
    expect(kind(`HOME=${scratch}2/user`)).toBe(null);
    expect(kind('HOME=user')).toBe(null);
    expect(kind(`XDG_HOME=${scratch}/user`)).toBe(null);
    expect(kind(`STATION_WEIGHT_RUN=${nonce}0`)).toBe(null);
    // The control engine's own entry excludes it.
    expect(
      kind(
        `STATION_WEIGHT_RUN=${nonce}`,
        `CLAUDE_CONFIG_DIR=${scratch}/claude-control`,
      ),
    ).toBe(null);
  });

  test('a scratch path counts only inside the resolved scratch root', () => {
    const base = realpathSync(makeTempDir('station-weight-'));
    const scratch = join(base, 'scratch');
    const outside = join(base, 'outside');
    mkdirSync(join(scratch, 'user'), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(scratch, 'link'));
    // A link from outside to the scratch root is still the root.
    symlinkSync(scratch, join(base, 'alias'));
    const kind = (value: string) =>
      runTagKind(
        [`HOME=${value}`],
        runTagging({
          nonce: '56'.repeat(16),
          scratch,
          startedAtMs: 0,
          uid: 501,
        }),
      );
    // The reviewer's probes: both spell a path under the scratch root and
    // resolve outside it.
    expect(kind(`${scratch}/../outside`)).toBe(null);
    expect(kind(`${scratch}/link`)).toBe(null);
    expect(kind(`${scratch}/link/not-yet`)).toBe(null);
    expect(kind(`${scratch}/user/../../outside`)).toBe(null);
    // Positive controls: inside, existing or not, however spelled.
    expect(kind(`${scratch}/user`)).toBe('path');
    expect(kind(`${scratch}/./user/not-yet`)).toBe('path');
    expect(kind(`${base}/alias/user`)).toBe('path');
  });

  test('a macOS environment counts only from a read of the row process', () => {
    const nonce = 'ef'.repeat(16);
    const tagging = runTagging({
      nonce,
      scratch: '/tmp/station-weight-z',
      startedAtMs: 1_700_000_000_000,
      uid: 501,
    });
    const tableRow = {
      ...row(20, 1, 'Tue Nov 14 22:13:25 2023'),
      uid: 501,
      startedAtMs: 1_700_000_005_000,
    };
    const tagged = (read: Map<number, unknown>) =>
      taggedRows([tableRow], tagging, {
        platform: 'darwin',
        readArguments: () => read as never,
      }).map((entry) => entry.pid);
    const entry = (startedUs: number) => ({
      startedUs,
      argv: ['node'],
      env: [`STATION_WEIGHT_RUN=${nonce}`],
    });
    expect(tagged(new Map([[20, entry(1_700_000_005_250_000)]]))).toEqual([20]);
    // The read belonged to a process born in another second: a reused pid.
    expect(tagged(new Map([[20, entry(1_700_000_009_000_000)]]))).toEqual([]);
    // Unreadable (exited, another user's): never the run's.
    expect(tagged(new Map())).toEqual([]);
  });

  test('a failed macOS environment read is an error, never an owned process', () => {
    const tagging = runTagging({
      nonce: '01'.repeat(16),
      scratch: '/tmp/station-weight-w',
      startedAtMs: 0,
      uid: 501,
    });
    const tableRow = { ...row(30, 1, 'x'), uid: 501, startedAtMs: 5_000 };
    expect(() =>
      taggedRows([tableRow], tagging, {
        platform: 'darwin',
        run: () => {
          throw new Error('spawnSync python3 ENOENT');
        },
      }),
    ).toThrow('cannot read process environments exactly');
  });

  test('macOS wakeups count matched births and disclose endpoint-only processes', () => {
    const start = new Map([
      [1, { birth: 10n, interrupt: 100n, packageIdle: 7n }],
      [2, { birth: 20n, interrupt: 200n, packageIdle: 30n }],
    ]);
    const end = new Map([
      [1, { birth: 10n, interrupt: 123n, packageIdle: 9n }],
      [3, { birth: 30n, interrupt: 900n, packageIdle: 400n }],
    ]);
    expect(darwinWakeupMetric(start, end)).toMatchObject({
      status: 'measured',
      value: 23,
      packageIdleWakeups: 2,
      comparedProcesses: 1,
      endpointOnlyProcesses: 2,
    });
  });

  test('macOS wakeups report a gap rather than zero for untrusted endpoints', () => {
    const counter = { birth: 10n, interrupt: 100n, packageIdle: 7n };
    const start = new Map([[1, counter]]);
    for (const [end, reason] of [
      [new Map([[2, counter]]), 'no process matched'],
      [new Map([[1, null]]), 'unreadable'],
      [new Map([[1, { ...counter, birth: 11n }]]), 'identity changed'],
      [new Map([[1, { ...counter, interrupt: 99n }]]), 'decreased'],
    ] as const) {
      expect(darwinWakeupMetric(start, end)).toMatchObject({
        status: 'not_measured',
        reason: expect.stringContaining(reason),
      });
    }
    expect(darwinWakeupMetric(start, new Map([[1, counter]]))).toMatchObject({
      status: 'measured',
      value: 0,
    });
  });

  test('context switches count only processes read at both ends of the window', () => {
    expect(
      contextSwitchDelta(
        new Map([
          ['1:a', 10],
          ['2:b', 5],
        ]),
        new Map([
          ['1:a', 25],
          ['3:c', 99],
        ]),
      ),
    ).toBe(15);
  });

  test('macOS birth tokens keep lstart day padding, matching the instance record', () => {
    const table = processTable(
      () =>
        '  100     1   501  2048  0:01.50 Mon Nov  2 08:05:09 2026 /usr/bin/node\n',
      { platform: 'darwin' },
    );
    expect(table).toEqual([
      expect.objectContaining({
        pid: 100,
        uid: 501,
        started: 'Mon Nov  2 08:05:09 2026',
        startedAtMs: Date.UTC(2026, 10, 2, 8, 5, 9),
        cpuSeconds: 1.5,
      }),
    ]);
  });
});

// Output shape of macOS `footprint -f bytes --noCategories <pid> <pid>`.
const FOOTPRINT_OUTPUT = `======================================================================
node [7432]: 64-bit    Footprint: 968088040 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 968120808 B
    phys_footprint_peak: 969022024 B

======================================================================
claude [96243]: 64-bit    Footprint: 91501560 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 91534328 B
    phys_footprint_peak: 242522176 B

======================================================================
Summary Footprint: 1059556832 B
======================================================================
`;

describe('station-weight memory attribution', () => {
  const row = (pid: number, memoryBytes: number, command = 'node') => ({
    pid,
    ppid: 1,
    rssBytes: memoryBytes,
    cpuSeconds: 0,
    started: 'x',
    command,
    memoryBytes,
  });

  test('names the fixed entries, then the script, then the executable', () => {
    expect(
      processRole(
        '/usr/bin/node /b/dist-server-x/station-supervisor.js --entry /b/dist-server-x/command-station.js',
      ),
    ).toBe('supervisor');
    expect(
      processRole('/usr/bin/node /b/dist-server-x/command-station.js'),
    ).toBe('server');
    expect(
      processRole('node /b/dist-server/attached-session-path-child.js'),
    ).toBe('attached-session-path-child.js');
    expect(processRole('/opt/claude --print')).toBe('claude');
  });

  test('names a known identity by its pid and birth, not its command line', () => {
    const ui = { ...row(5, 18), started: 'Sun Nov 15 18:06:17 2026' };
    const known = [
      { pid: 5, started: 'Sun Nov 15 18:06:17 2026', role: 'ui-listener' },
    ];
    expect(memoryByRole([ui], [{ pid: 5, command: 'node -' }], known)).toEqual([
      { role: 'ui-listener', processCount: 1, memoryBytes: 18 },
    ]);
    // A reused pid with another birth is not the known process.
    expect(
      memoryByRole(
        [{ ...ui, started: 'Sun Nov 15 18:09:00 2026' }],
        [{ pid: 5, command: 'node -' }],
        known,
      ),
    ).toEqual([{ role: 'node', processCount: 1, memoryBytes: 18 }]);
  });

  test('sums memory per role from the described command lines, largest first', () => {
    const rows = [row(1, 10), row(2, 500), row(3, 30), row(4, 20, 'claude')];
    expect(
      memoryByRole(rows, [
        { pid: 1, command: 'node /b/station-supervisor.js' },
        { pid: 2, command: 'node /b/command-station.js' },
        { pid: 3, command: 'node /b/command-station.js' },
      ]),
    ).toEqual([
      { role: 'server', processCount: 2, memoryBytes: 530 },
      { role: 'claude', processCount: 1, memoryBytes: 20 },
      { role: 'supervisor', processCount: 1, memoryBytes: 10 },
    ]);
  });

  test("reads the server's heap beside the memory measured for its pid", async () => {
    const rows = [row(7, 400_000_000), row(8, 20_000_000)];
    const posture = (process: object) => async () => ({
      status: 200,
      json: { success: true, data: { resources: { process } } },
      text: '',
    });
    await expect(
      serverHeapReport(
        posture({
          pid: 7,
          heapUsedBytes: 150_000_000,
          heapTotalBytes: 300_000_000,
        }),
        rows,
      ),
    ).resolves.toMatchObject({
      status: 'measured',
      value: 400_000_000,
      pid: 7,
      heapUsedBytes: 150_000_000,
      heapTotalBytes: 300_000_000,
      outsideHeapBytes: 100_000_000,
    });
    // A pid outside the measured tree, a refused read and a throw are gaps.
    await expect(
      serverHeapReport(
        posture({ pid: 9, heapUsedBytes: 1, heapTotalBytes: 1 }),
        rows,
      ),
    ).resolves.toMatchObject({
      status: 'not_measured',
      reason: expect.stringContaining('9'),
    });
    await expect(
      serverHeapReport(
        async () => ({ status: 503, json: null, text: 'unavailable' }),
        rows,
      ),
    ).resolves.toMatchObject({
      status: 'not_measured',
      reason: expect.stringContaining('503'),
    });
    await expect(
      serverHeapReport(async () => {
        throw new Error('refused');
      }, rows),
    ).resolves.toMatchObject({
      status: 'not_measured',
      reason: expect.stringContaining('refused'),
    });
  });

  test('prints the attribution as REPORT lines', () => {
    expect(
      formatAttribution({
        metrics: {
          restMemoryBytes: {
            byRole: [{ role: 'server', processCount: 1, memoryBytes: 400 }],
          },
        },
        attribution: {
          serverHeapAtRest: {
            status: 'measured',
            value: 400,
            basis: 'rss',
            pid: 7,
            heapUsedBytes: 150,
            heapTotalBytes: 300,
            outsideHeapBytes: 100,
          },
          serverHeapWithSessions: { status: 'not_measured', reason: 'gone' },
        },
      }),
    ).toEqual([
      'REPORT restMemoryBytes role=server processes=1 bytes=400',
      'REPORT serverHeapAtRest pid=7 rss=400 heapTotal=300 heapUsed=150 outsideHeap=100 bytes',
      'REPORT serverHeapWithSessions not measured: gone',
    ]);
  });
});

describe('station-weight memory reading', () => {
  test('reads phys_footprint per pid, not the peak or the summary', () => {
    expect([...parseFootprint(FOOTPRINT_OUTPUT)]).toEqual([
      [7432, 968120808],
      [96243, 91534328],
    ]);
  });

  test.skipIf(process.platform !== 'darwin')(
    'a live process the reader omitted is an error, never zero',
    () => {
      const row = {
        pid: process.pid,
        ppid: 1,
        rssBytes: 1,
        cpuSeconds: 0,
        started: 'x',
        command: 'node',
      };
      expect(() => withMemory([row], () => FOOTPRINT_OUTPUT)).toThrow(
        `footprint did not report live pid ${process.pid}`,
      );
    },
  );
});
