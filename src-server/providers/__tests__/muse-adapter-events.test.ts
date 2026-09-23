import { describe, expect, test } from 'vitest';
import {
  buildMuseExecArgs,
  MUSE_LAUNCH_RESULT_MAX_CHARS,
  mapMuseFinishReason,
  museBackgroundTaskRowId,
  observeMuseToolTask,
  parseMuseLaunchedBackgroundTask,
  parseMuseLine,
  splitMuseLines,
  translateMuseRecord,
} from '../adapters/muse-adapter-events.js';
import type { MuseToolTaskBinding } from '../adapters/muse-adapter-types.js';
import {
  MUSE_13_BACKGROUND_TASK_ID,
  MUSE_13_BACKGROUND_WORKFLOW_TURN_LINES,
  MUSE_13_BASH_CALL_ID,
  MUSE_13_BASH_TOOL_TURN_LINES,
  MUSE_ECHO_COMMAND_ACCEPTED,
  MUSE_ECHO_OUTPUT_DELTA,
  MUSE_ECHO_RUN_STARTED,
  MUSE_ECHO_RUN_TERMINAL,
  MUSE_ECHO_SESSION_RUN_LINKED,
  MUSE_ECHO_TASK_LIFECYCLE,
  MUSE_META_MODEL_CONFIGURED,
  MUSE_META_OUTPUT_DELTA_1,
  MUSE_META_OUTPUT_DELTA_2,
  MUSE_META_RUN_TERMINAL,
  MUSE_TOOL_RESULT,
} from './muse-adapter-fixtures.js';

function translate(line: string) {
  const record = parseMuseLine(line);
  expect(record).not.toBeNull();
  return translateMuseRecord(record!);
}

describe('parseMuseLine', () => {
  test('decodes a captured muse envelope down to record_type + payload', () => {
    const record = parseMuseLine(MUSE_ECHO_OUTPUT_DELTA);
    expect(record).toEqual({
      recordType: 'status',
      payloadKind: 'run_output_delta',
      payload: expect.objectContaining({
        kind: 'run_output_delta',
        text: 'echo: say hello',
      }),
    });
  });

  // A parse that throws inside the stdout handler would tear down a live turn,
  // so every degenerate line has to come back as `null` instead.
  test.each([
    ['blank', '   '],
    ['not json', 'muse: something went wrong'],
    ['truncated json', '{"schema_version":1,"payload":{"kind":"run_out'],
    ['json without a payload', '{"schema_version":1,"record_type":"event"}'],
    ['payload without a kind', '{"payload":{"text":"orphan"}}'],
    ['json array', '[1,2,3]'],
    ['json null', 'null'],
  ])('tolerates %s without throwing', (_label, line) => {
    expect(parseMuseLine(line)).toBeNull();
  });
});

describe('translateMuseRecord', () => {
  test('run_output_delta becomes a text delta carrying the exact text', () => {
    expect(translate(MUSE_ECHO_OUTPUT_DELTA)).toEqual({
      kind: 'text-delta',
      delta: 'echo: say hello',
    });
    expect(translate(MUSE_META_OUTPUT_DELTA_1)).toEqual({
      kind: 'text-delta',
      delta: 'hi — what can I help with',
    });
    expect(translate(MUSE_META_OUTPUT_DELTA_2)).toEqual({
      kind: 'text-delta',
      delta: '?',
    });
  });

  test('run_terminal reports the full text and a completed outcome', () => {
    expect(translate(MUSE_META_RUN_TERMINAL)).toEqual({
      kind: 'terminal',
      terminal: 'completed',
      reason: null,
      text: 'hi — what can I help with?',
      finishReason: 'stop',
      completed: true,
    });
    expect(translate(MUSE_ECHO_RUN_TERMINAL)).toMatchObject({
      kind: 'terminal',
      completed: true,
      text: 'echo: say hello',
    });
  });

  // Every one of these is a deliberate drop, not an oversight: Station already
  // publishes the session/turn rows they restate. (`task_lifecycle` is no
  // longer dropped — #2308, see 'muse 1.3 tool start' below.)
  test.each([
    ['command_accepted', MUSE_ECHO_COMMAND_ACCEPTED],
    ['session_run_linked', MUSE_ECHO_SESSION_RUN_LINKED],
    ['run_started', MUSE_ECHO_RUN_STARTED],
    ['run_model_configured', MUSE_META_MODEL_CONFIGURED],
  ])('drops %s', (_label, line) => {
    expect(translate(line)).toEqual({ kind: 'ignored' });
  });

  test('drops an empty delta rather than publishing an empty text event', () => {
    expect(
      translate(
        '{"record_type":"status","payload":{"kind":"run_output_delta","text":""}}',
      ),
    ).toEqual({ kind: 'ignored' });
  });
});

describe('mapMuseFinishReason', () => {
  test('classifies from terminal first, falling back to reason', () => {
    expect(mapMuseFinishReason('completed', null)).toBe('stop');
    expect(mapMuseFinishReason('cancelled', null)).toBe('cancelled');
    expect(mapMuseFinishReason('interrupted', null)).toBe('cancelled');
    expect(mapMuseFinishReason('failed', null)).toBe('other');
    expect(mapMuseFinishReason(null, 'completed')).toBe('stop');
    expect(mapMuseFinishReason(null, null)).toBe('other');
  });

  test('a non-completed terminal is never reported as a clean stop', () => {
    const effect = translate(
      '{"record_type":"event","payload":{"kind":"run_terminal","terminal":"failed","text":"boom","reason":"provider_error"}}',
    );
    expect(effect).toMatchObject({
      kind: 'terminal',
      completed: false,
      finishReason: 'other',
      reason: 'provider_error',
    });
  });
});

describe('splitMuseLines', () => {
  test('carries a partial trailing object into the next chunk', () => {
    const first = splitMuseLines('', '{"a":1}\n{"b":');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.remainder).toBe('{"b":');
    const second = splitMuseLines(first.remainder, '2}\n');
    expect(second.lines).toEqual(['{"b":2}']);
    expect(second.remainder).toBe('');
  });

  test('a JSON object split across three chunks still decodes once whole', () => {
    const whole = MUSE_ECHO_OUTPUT_DELTA;
    const a = whole.slice(0, 40);
    const b = whole.slice(40, 120);
    const c = `${whole.slice(120)}\n`;
    let buffered = '';
    const emitted: string[] = [];
    for (const chunk of [a, b, c]) {
      const split = splitMuseLines(buffered, chunk);
      buffered = split.remainder;
      emitted.push(...split.lines);
    }
    expect(emitted).toEqual([whole]);
    expect(parseMuseLine(emitted[0])?.payloadKind).toBe('run_output_delta');
  });
});

describe('buildMuseExecArgs', () => {
  test('always streams JSONL against the session id, prompt last', () => {
    expect(
      buildMuseExecArgs({ sessionId: 'session-1', prompt: 'say hello' }),
    ).toEqual([
      'exec',
      '--json',
      '--session-id',
      'session-1',
      '--',
      'say hello',
    ]);
  });

  test('adds --model and --workspace only when present', () => {
    expect(
      buildMuseExecArgs({
        sessionId: 'session-1',
        prompt: 'go',
        modelId: 'muse-spark-1.2-contributor',
        cwd: '/tmp/project',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--session-id',
      'session-1',
      '--model',
      'muse-spark-1.2-contributor',
      '--workspace',
      '/tmp/project',
      '--',
      'go',
    ]);
  });

  // Position is NOT what protects a flag-shaped prompt: muse parses options
  // wherever they appear, so a trailing `--api-key-stdin` is consumed as an
  // option and the turn dies with `missing prompt` (live-verified against
  // muse 0.1.0-R708.1). Only the `--` end-of-options separator makes the
  // prompt reach muse verbatim — and `-w`/`--workspace` is state-mutating,
  // so an unseparated prompt is user-controlled argv injection.
  test.each([
    ['--api-key-stdin'],
    ['--provider echo'],
    ['-w /etc'],
    ['--workspace=/etc'],
  ])('terminates options before a flag-shaped prompt: %s', (prompt) => {
    const args = buildMuseExecArgs({ sessionId: 'session-1', prompt });
    expect(args[args.length - 1]).toBe(prompt);
    // The assertion the old position-only test was missing.
    expect(args[args.length - 2]).toBe('--');
    expect(args.indexOf('--')).toBe(args.length - 2);
  });

  // #550: the provider override. The two tests above already pin the UNSET
  // argv byte-for-byte; these pin what the override adds and where.
  test('emits --provider after the session id, leaving the stable prefix intact', () => {
    expect(
      buildMuseExecArgs({
        sessionId: 'session-1',
        prompt: 'go',
        provider: 'echo',
        cwd: '/tmp/project',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--session-id',
      'session-1',
      '--provider',
      'echo',
      '--workspace',
      '/tmp/project',
      '--',
      'go',
    ]);
  });

  test('passes --model through under meta, which is the mode that accepts it', () => {
    expect(
      buildMuseExecArgs({
        sessionId: 'session-1',
        prompt: 'go',
        provider: 'meta',
        modelId: 'muse-spark-1.2-contributor',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--session-id',
      'session-1',
      '--provider',
      'meta',
      '--model',
      'muse-spark-1.2-contributor',
      '--',
      'go',
    ]);
  });

  // Live-verified against Muse Code 1.0.1-R1848.1: `muse exec --json
  // --provider echo --model <id>` exits 2 with `--model requires --provider
  // meta` and emits no JSONL at all, so forwarding both would produce a turn
  // that could only die.
  test('drops --model under echo, which muse refuses to accept it with', () => {
    const args = buildMuseExecArgs({
      sessionId: 'session-1',
      prompt: 'go',
      provider: 'echo',
      modelId: 'muse-spark-1.2-contributor',
    });
    expect(args).toEqual([
      'exec',
      '--json',
      '--session-id',
      'session-1',
      '--provider',
      'echo',
      '--',
      'go',
    ]);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('muse-spark-1.2-contributor');
  });
});

describe('tool_result translation', () => {
  it('maps a real tool_result into a fully derived tool-completed effect', () => {
    const record = parseMuseLine(MUSE_TOOL_RESULT);
    expect(record).not.toBeNull();
    const effect = translateMuseRecord(record!);

    expect(effect).toEqual({
      kind: 'tool-completed',
      toolCallId: 'call_019feab717fd75639b5a008d7b2c3e09',
      toolName: 'read_file',
      status: 'success',
      output: 'Read text file `probe.txt`.\n1|hello from probe',
    });
  });

  it('reports a non-success outcome as an error rather than assuming success', () => {
    const record = parseMuseLine(
      MUSE_TOOL_RESULT.replace('"outcome":"success"', '"outcome":"failure"'),
    );
    const effect = translateMuseRecord(record!);
    expect(effect).toMatchObject({ kind: 'tool-completed', status: 'error' });
  });

  it('ignores a tool_result with no id, and passes a missing tool name through as null', () => {
    // A synthesized id would never pair with anything downstream.
    const noId = MUSE_TOOL_RESULT.replace(
      '"call_id":"call_019feab717fd75639b5a008d7b2c3e09",',
      '',
    );
    expect(translateMuseRecord(parseMuseLine(noId)!)).toEqual({
      kind: 'ignored',
    });
    // No name is not a guessed name: the adapter pairs it with an open
    // start for this call_id, or drops it (see muse-adapter.test.ts).
    const noName = MUSE_TOOL_RESULT.replace('"tool_name":"read_file",', '');
    expect(translateMuseRecord(parseMuseLine(noName)!)).toMatchObject({
      kind: 'tool-completed',
      toolCallId: 'call_019feab717fd75639b5a008d7b2c3e09',
      toolName: null,
    });
  });

  it("a model task's lifecycle record carries no tool identity and opens nothing", () => {
    const effect = translateMuseRecord(
      parseMuseLine(MUSE_ECHO_TASK_LIFECYCLE)!,
    );
    expect(effect).toEqual({
      kind: 'task-lifecycle',
      taskId: 'fa2007a2-344f-449a-8194-a76a7a83707b',
      phase: 'side_effect_intent',
      toolName: null,
      toolCallId: null,
    });
    const bindings = new Map<string, MuseToolTaskBinding>();
    expect(observeMuseToolTask(bindings, effect as never, 500)).toBeNull();
    // Not even remembered: only tool evidence or a start earns a binding.
    expect(bindings.size).toBe(0);
  });
});

/**
 * #2308: folds a stream through `translateMuseRecord` + `observeMuseToolTask`
 * exactly as the adapter does, returning the tool starts/completions in
 * stream order.
 */
function foldToolEffects(lines: readonly string[]) {
  const bindings = new Map<string, MuseToolTaskBinding>();
  const out: Array<
    | { kind: 'started'; toolName: string; toolCallId: string; line: number }
    | {
        kind: 'completed';
        toolName: string | null;
        toolCallId: string;
        line: number;
      }
  > = [];
  lines.forEach((line, index) => {
    const record = parseMuseLine(line);
    if (!record) return;
    const effect = translateMuseRecord(record);
    if (effect.kind === 'task-lifecycle') {
      const start = observeMuseToolTask(bindings, effect, 500);
      if (start?.kind === 'started') out.push({ ...start, line: index + 1 });
    } else if (effect.kind === 'tool-completed') {
      out.push({
        kind: 'completed',
        toolName: effect.toolName,
        toolCallId: effect.toolCallId,
        line: index + 1,
      });
    }
  });
  return { out, bindings };
}

describe('muse 1.3 tool start (#2308, real capture)', () => {
  test('the capture is the 55-record one-bash-call turn it claims to be', () => {
    expect(MUSE_13_BASH_TOOL_TURN_LINES).toHaveLength(55);
    for (const line of MUSE_13_BASH_TOOL_TURN_LINES) {
      expect(parseMuseLine(line)).not.toBeNull();
    }
  });

  test('opens exactly one start, named and keyed exactly as its tool_result', () => {
    const { out, bindings } = foldToolEffects(MUSE_13_BASH_TOOL_TURN_LINES);
    expect(out).toEqual([
      // Line 26 is the bash task's `task.lifecycle.started`: the start fires
      // there, not at `proposed`/`scheduled`/`side_effect_intent`.
      {
        kind: 'started',
        toolName: 'bash',
        toolCallId: MUSE_13_BASH_CALL_ID,
        line: 26,
      },
      {
        kind: 'completed',
        toolName: 'bash',
        toolCallId: MUSE_13_BASH_CALL_ID,
        line: 29,
      },
    ]);
    // Every task in the capture reached a final phase, so nothing lingers.
    expect(bindings.size).toBe(0);
  });

  test('model and reminder tasks never open a tool, even though they start', () => {
    const toolTaskId = '01a0cab2-5d4f-7600-886e-a77b38b198a3';
    const others = MUSE_13_BASH_TOOL_TURN_LINES.filter(
      (line) => !line.includes(toolTaskId),
    );
    // Sanity: the filtered stream still has started tasks (model/reminder).
    expect(others.some((line) => line.includes('"kind":"started"'))).toBe(true);
    expect(
      foldToolEffects(others).out.filter((e) => e.kind === 'started'),
    ).toEqual([]);
  });

  test('a stream without task_kind / idempotency_key (older muse) opens no start', () => {
    const stripped = MUSE_13_BASH_TOOL_TURN_LINES.map((line) => {
      const decoded = JSON.parse(line);
      const event = decoded.payload?.event;
      if (event && typeof event === 'object') {
        delete event.task_kind;
        delete event.idempotency_key;
      }
      return JSON.stringify(decoded);
    });
    const { out } = foldToolEffects(stripped);
    // The completion still arrives — today's behavior — with no start.
    expect(out.map((e) => e.kind)).toEqual(['completed']);
  });

  test('either identity alone is not enough to open a start', () => {
    for (const field of ['task_kind', 'idempotency_key'] as const) {
      const stripped = MUSE_13_BASH_TOOL_TURN_LINES.map((line) => {
        const decoded = JSON.parse(line);
        const event = decoded.payload?.event;
        if (event && typeof event === 'object') delete event[field];
        return JSON.stringify(decoded);
      });
      expect(
        foldToolEffects(stripped).out.filter((e) => e.kind === 'started'),
      ).toEqual([]);
    }
  });

  test('a start that precedes its binding still fires once, when the binding lands', () => {
    const lines = [...MUSE_13_BASH_TOOL_TURN_LINES];
    // Move the bash task's `started` (line 26) ahead of its `proposed` (22).
    const [started] = lines.splice(25, 1);
    lines.splice(21, 0, started!);
    const starts = foldToolEffects(lines).out.filter(
      (e) => e.kind === 'started',
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ toolCallId: MUSE_13_BASH_CALL_ID });
  });

  test('cancelled closes a started tool; completed and failed only mark it finished', () => {
    const lines = MUSE_13_BASH_TOOL_TURN_LINES;
    const run = (finalPhase: string) => {
      const bindings = new Map<string, MuseToolTaskBinding>();
      const observed = [
        ...lines.slice(21, 26),
        lines[27]!.replace(
          '"event":{"kind":"completed"',
          `"event":{"kind":"${finalPhase}"`,
        ),
      ].map((line) =>
        observeMuseToolTask(
          bindings,
          translateMuseRecord(parseMuseLine(line)!) as never,
          500,
        ),
      );
      return { observed: observed.filter(Boolean), bindings };
    };
    const cancelled = run('cancelled');
    expect(cancelled.observed).toEqual([
      { kind: 'started', toolName: 'bash', toolCallId: MUSE_13_BASH_CALL_ID },
      { kind: 'cancelled', toolName: 'bash', toolCallId: MUSE_13_BASH_CALL_ID },
    ]);
    expect(cancelled.bindings.size).toBe(0);
    // A failed tool still gets its tool_result, batched after the task's
    // final phase, so neither `failed` nor `completed` closes anything here.
    for (const phase of ['failed', 'completed']) {
      const { observed, bindings } = run(phase);
      // `finished`, not `cancelled`: the row stays open for its result.
      expect(observed.map((o) => o?.kind)).toEqual(['started', 'finished']);
      expect(bindings.size).toBe(0);
    }
  });

  test('a cancelled task that never started opens and closes nothing', () => {
    const bindings = new Map<string, MuseToolTaskBinding>();
    const lines = [
      ...MUSE_13_BASH_TOOL_TURN_LINES.slice(21, 25),
      MUSE_13_BASH_TOOL_TURN_LINES[27]!.replace(
        '"event":{"kind":"completed"',
        '"event":{"kind":"cancelled"',
      ),
    ];
    for (const line of lines) {
      expect(
        observeMuseToolTask(
          bindings,
          translateMuseRecord(parseMuseLine(line)!) as never,
          500,
        ),
      ).toBeNull();
    }
  });

  test('a replayed started record does not open a second start', () => {
    const lines = [...MUSE_13_BASH_TOOL_TURN_LINES];
    lines.splice(26, 0, lines[25]!);
    expect(
      foldToolEffects(lines).out.filter((e) => e.kind === 'started'),
    ).toHaveLength(1);
  });
});

describe('parseMuseLaunchedBackgroundTask (#2300)', () => {
  const liveLaunch = translate(MUSE_13_BACKGROUND_WORKFLOW_TURN_LINES[28]!);

  test('reads the task id from the live workflow launch result', () => {
    expect(liveLaunch).toMatchObject({
      kind: 'tool-completed',
      toolName: 'workflow',
    });
    if (liveLaunch.kind !== 'tool-completed') throw new Error('unreachable');
    expect(
      parseMuseLaunchedBackgroundTask(liveLaunch.toolName, liveLaunch.output),
    ).toBe(MUSE_13_BACKGROUND_TASK_ID);
    expect(museBackgroundTaskRowId(MUSE_13_BACKGROUND_TASK_ID)).toBe(
      `muse-task:${MUSE_13_BACKGROUND_TASK_ID}`,
    );
  });

  test('announces nothing for any other tool, status, shape, or size', () => {
    const launched = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({ status: 'launched', taskId: 'task-1', ...extra });
    expect(parseMuseLaunchedBackgroundTask('workflow', launched())).toBe(
      'task-1',
    );
    expect(parseMuseLaunchedBackgroundTask('bash', launched())).toBeNull();
    expect(parseMuseLaunchedBackgroundTask(null, launched())).toBeNull();
    expect(parseMuseLaunchedBackgroundTask('workflow', null)).toBeNull();
    for (const text of [
      '',
      'not json',
      '{"status":"launched","taskId":',
      '[]',
      'null',
      JSON.stringify({ status: 'completed', taskId: 'task-1' }),
      JSON.stringify({ status: 'launched' }),
      JSON.stringify({ status: 'launched', taskId: 42 }),
      JSON.stringify({ status: 'launched', taskId: '' }),
      JSON.stringify({ status: 'launched', taskId: 'a b' }),
      JSON.stringify({ status: 'launched', taskId: 'x'.repeat(129) }),
    ]) {
      expect(
        parseMuseLaunchedBackgroundTask('workflow', text),
        text,
      ).toBeNull();
    }
    // The size bound is on the text, whatever it contains.
    const atBound = launched({
      padding: 'x'.repeat(
        MUSE_LAUNCH_RESULT_MAX_CHARS - launched({ padding: '' }).length,
      ),
    });
    expect(atBound.length).toBe(MUSE_LAUNCH_RESULT_MAX_CHARS);
    expect(parseMuseLaunchedBackgroundTask('workflow', atBound)).toBe('task-1');
    expect(
      parseMuseLaunchedBackgroundTask('workflow', `${atBound} `),
    ).toBeNull();
  });
});
