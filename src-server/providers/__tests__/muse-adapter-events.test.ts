import { describe, expect, test } from 'vitest';
import {
  buildMuseExecArgs,
  mapMuseFinishReason,
  parseMuseLine,
  splitMuseLines,
  translateMuseRecord,
} from '../adapters/muse-adapter-events.js';
import {
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
  // publishes the session/turn rows they restate, and `task_lifecycle` names
  // no tool, arguments, or output — synthesizing `tool.*` from it would be a
  // label with nothing deriving it.
  test.each([
    ['command_accepted', MUSE_ECHO_COMMAND_ACCEPTED],
    ['session_run_linked', MUSE_ECHO_SESSION_RUN_LINKED],
    ['run_started', MUSE_ECHO_RUN_STARTED],
    ['task_lifecycle', MUSE_ECHO_TASK_LIFECYCLE],
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

  it('ignores a tool_result with no id or no tool name instead of inventing one', () => {
    // A synthesized id would never pair with anything downstream.
    const noId = MUSE_TOOL_RESULT.replace(
      '"call_id":"call_019feab717fd75639b5a008d7b2c3e09",',
      '',
    );
    expect(translateMuseRecord(parseMuseLine(noId)!)).toEqual({
      kind: 'ignored',
    });
    const noName = MUSE_TOOL_RESULT.replace('"tool_name":"read_file",', '');
    expect(translateMuseRecord(parseMuseLine(noName)!)).toEqual({
      kind: 'ignored',
    });
  });

  it('still ignores task_lifecycle, which names no tool and carries no output', () => {
    const record = parseMuseLine(MUSE_ECHO_TASK_LIFECYCLE);
    expect(translateMuseRecord(record!)).toEqual({ kind: 'ignored' });
  });
});
