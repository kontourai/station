import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, test } from 'vitest';
import {
  hostFingerprint,
  hostFingerprintInputs,
  IDLE_CPU_GAP,
  idleCpuMetric,
  ownedTree,
  parseFootprint,
  processTable,
  recordedRoots,
  restMetric,
  signalIfSame,
  withMemory,
} from '../bench/station-weight.mjs';
import {
  evaluateBudgets,
  gateOutcome,
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
        serverReadyMs: 5000,
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
  const metrics: Record<string, Metric> = {};
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
  };
}

function measuredAt(value: number): Metric {
  return { status: 'measured', value, unit: 'x' };
}

const verdictOf = (
  verdicts: Array<{ id: string; verdict: string }>,
  id: string,
) => verdicts.find((entry) => entry.id === id)?.verdict;

describe('station-weight budgets', () => {
  test('a run at its baseline compares every comparable budget and passes', () => {
    const verdicts = evaluateBudgets(resultAtBaseline(), FIXTURE_BASELINE);
    for (const budget of STATION_WEIGHT_BUDGETS)
      expect(verdictOf(verdicts, budget.id), budget.id).toBe('PASS');
    expect(gateOutcome(resultAtBaseline(), verdicts)).toMatchObject({
      passed: true,
      comparedCount: 9,
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

  test('ready time (a median of launches) fails only past +100% of its baseline', () => {
    const result = resultAtBaseline();
    const base = FIXTURE_BASELINE.hosts[HOST.fingerprint].values.serverReadyMs;
    result.metrics.serverReadyMs.value = base * 2;
    expect(
      verdictOf(evaluateBudgets(result, FIXTURE_BASELINE), 'serverReadyMs'),
    ).toBe('PASS');
    result.metrics.serverReadyMs.value = base * 2 + 1;
    expect(
      verdictOf(evaluateBudgets(result, FIXTURE_BASELINE), 'serverReadyMs'),
    ).toBe('FAIL');
  });

  test('host budgets compare only against the same host fingerprint; request budgets compare everywhere', () => {
    const result = resultAtBaseline(OTHER_HOST);
    const verdicts = evaluateBudgets(result, FIXTURE_BASELINE);
    for (const budget of STATION_WEIGHT_BUDGETS)
      expect(verdictOf(verdicts, budget.id), budget.id).toBe(
        budget.scope === 'host' ? 'NOT_MEASURED' : 'PASS',
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
    ).toHaveLength(9);
    expect(gateOutcome(result, verdicts)).toMatchObject({
      passed: false,
      comparedCount: 0,
    });
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
      },
      250,
    );
    expect(metric).toMatchObject({ status: 'not_measured' });
    expect(metric.gap).toBe(IDLE_CPU_GAP(250));
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

  test('a signal is sent only while the pid still has the recorded birth', () => {
    const killed: number[] = [];
    const outcome = signalIfSame(
      [row(7, 1, 'then'), row(8, 1, 'same')],
      'SIGKILL',
      {
        birth: (pid: number) => (pid === 7 ? 'now' : 'same'),
        kill: (pid: number) => {
          killed.push(pid);
          return true;
        },
      },
    );
    expect(killed).toEqual([8]);
    expect(outcome).toEqual({ signalled: [8], skipped: [7] });
  });

  test('macOS birth tokens keep lstart day padding, matching the instance record', () => {
    const table = processTable(
      () =>
        '  100     1  2048  0:01.50 Mon Nov  2 08:05:09 2026 /usr/bin/node\n',
      { platform: 'darwin' },
    );
    expect(table).toEqual([
      expect.objectContaining({
        pid: 100,
        started: 'Mon Nov  2 08:05:09 2026',
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
