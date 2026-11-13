import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, test } from 'vitest';
import { parseFootprint, withMemory } from '../bench/station-weight.mjs';
import {
  evaluateBudgets,
  recordBaseline,
  STATION_WEIGHT_BUDGETS,
} from '../bench/station-weight-budgets.mjs';
import {
  diffAgainstControl,
  findTurnRequest,
  markersReached,
  summarizeRequest,
} from '../bench/station-weight-request.mjs';
import {
  STUB_MAX_BODY_BYTES,
  STUB_REPLY_TEXT,
  startStubAnthropic,
} from '../bench/station-weight-stub.mjs';

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
    input_schema: { type: 'object' },
  },
  {
    name: 'Read',
    description: 'Read a file.',
    input_schema: { type: 'object' },
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
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: `Session ${sessionId}` },
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
            input_schema: { type: 'object' },
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
    // Session ids and the per-request version suffix cancel out.
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

const BASELINE = JSON.parse(
  readFileSync(
    join(__dirname, '../bench/station-weight-baseline.json'),
    'utf8',
  ),
);

/** A result shaped as runStationWeight writes it, at the baseline values. */
function resultAtBaseline() {
  const [klass, host] = Object.entries(BASELINE.hosts)[0] as [
    string,
    { values: Record<string, number> },
  ];
  const [platform, arch] = klass.split('-');
  const metrics: Record<
    string,
    { status: string; value?: number; unit: string; reason?: string }
  > = {};
  for (const [id, value] of Object.entries({
    ...BASELINE.request.values,
    ...host.values,
  }))
    metrics[id] = { status: 'measured', value: value as number, unit: 'x' };
  return { host: { platform, arch }, metrics };
}

const verdictOf = (
  verdicts: Array<{ id: string; verdict: string }>,
  id: string,
) => verdicts.find((entry) => entry.id === id)?.verdict;

describe('station-weight budgets against the committed baseline', () => {
  test('the committed baseline covers every budget for its host class', () => {
    const verdicts = evaluateBudgets(resultAtBaseline(), BASELINE);
    expect(verdicts.map((entry) => entry.verdict)).toEqual(
      STATION_WEIGHT_BUDGETS.map(() => 'PASS'),
    );
  });

  test('injected text growing past its headroom fails; within headroom and shrinking pass', () => {
    const base = BASELINE.request.values['request.stationAddedTextBytes'];
    expect(base).toBeGreaterThan(0);
    const at = (value: number) => {
      const result = resultAtBaseline();
      result.metrics['request.stationAddedTextBytes'].value = value;
      return verdictOf(
        evaluateBudgets(result, BASELINE),
        'request.stationAddedTextBytes',
      );
    };
    expect(at(Math.floor(base * 1.1))).toBe('PASS');
    expect(at(Math.ceil(base * 1.1) + 1)).toBe('FAIL');
    expect(at(0)).toBe('PASS');
  });

  test('a new side call fails even though counts otherwise carry headroom', () => {
    const result = resultAtBaseline();
    result.metrics['request.sideCallCount'].value =
      BASELINE.request.values['request.sideCallCount'] + 1;
    expect(
      verdictOf(evaluateBudgets(result, BASELINE), 'request.sideCallCount'),
    ).toBe('FAIL');
  });

  test('a process left alive after stop fails a zero leftover baseline', () => {
    const result = resultAtBaseline();
    const id = 'leftoverAfterStopMemoryBytes';
    const klass = `${result.host.platform}-${result.host.arch}`;
    expect(BASELINE.hosts[klass].values[id]).toBe(0);
    result.metrics[id].value = 4096;
    expect(verdictOf(evaluateBudgets(result, BASELINE), id)).toBe('FAIL');
  });

  test('idle CPU near zero has an additive floor of one percentage point', () => {
    const result = resultAtBaseline();
    const klass = `${result.host.platform}-${result.host.arch}`;
    const base = BASELINE.hosts[klass].values.idleCpuPercent;
    result.metrics.idleCpuPercent.value = base * 2 + 0.99;
    expect(verdictOf(evaluateBudgets(result, BASELINE), 'idleCpuPercent')).toBe(
      'PASS',
    );
    result.metrics.idleCpuPercent.value = base * 2 + 1.01;
    expect(verdictOf(evaluateBudgets(result, BASELINE), 'idleCpuPercent')).toBe(
      'FAIL',
    );
  });

  test('a gap is NOT_MEASURED with its reason, never PASS', () => {
    const result = resultAtBaseline();
    result.metrics.restMemoryBytes = {
      status: 'not_measured',
      unit: 'bytes',
      reason: 'probe unavailable',
    };
    delete (result.metrics as Record<string, unknown>).serverReadyMs;
    const verdicts = evaluateBudgets(result, BASELINE);
    expect(
      verdicts.find((entry) => entry.id === 'restMemoryBytes'),
    ).toMatchObject({
      verdict: 'NOT_MEASURED',
      reason: 'probe unavailable',
    });
    expect(verdictOf(verdicts, 'serverReadyMs')).toBe('NOT_MEASURED');
  });

  test('host budgets on another host class are NOT_MEASURED, request budgets still apply', () => {
    const result = {
      ...resultAtBaseline(),
      host: { platform: 'plan9', arch: 'mips' },
    };
    const verdicts = evaluateBudgets(result, BASELINE);
    for (const budget of STATION_WEIGHT_BUDGETS)
      expect(verdictOf(verdicts, budget.id)).toBe(
        budget.scope === 'host' ? 'NOT_MEASURED' : 'PASS',
      );
  });

  test('recording keeps other host classes and only measured values', () => {
    const result = {
      ...resultAtBaseline(),
      host: { platform: 'plan9', arch: 'mips' },
      sourceRevision: 'abc',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    result.metrics.restMemoryBytes = {
      status: 'not_measured',
      unit: 'bytes',
      reason: 'x',
    };
    const next = recordBaseline(result, BASELINE);
    for (const klass of Object.keys(BASELINE.hosts))
      expect(next.hosts[klass]).toEqual(BASELINE.hosts[klass]);
    expect(next.hosts['plan9-mips'].values).not.toHaveProperty(
      'restMemoryBytes',
    );
    expect(next.hosts['plan9-mips'].values).toHaveProperty('serverReadyMs');
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
