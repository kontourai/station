/**
 * The deterministic grader for the `station-control-tool-use` eval: plain
 * logic over the tool calls one model response made. It never calls a model,
 * so `scripts/__tests__/station-control-tool-use-eval.test.ts` runs it in CI.
 */

/** Claude Code's prefix for a station-control tool. */
export const STATION_CONTROL_PREFIX = 'mcp__station-control__';

/** The harness's shell tool. Its `command` is what `shellMustNot` reads. */
export const SHELL_TOOL = 'Bash';

export type CaseKind = 'bad' | 'guard' | 'control';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * A prior tool call and its result. `result` is the tool's JSON answer;
 * `refusal` instead asks the runner for Station's own refusal body for that
 * scope reason, read from source so the case never copies product text.
 */
export interface PriorToolTurn {
  toolCall: ToolCall;
  result?: unknown;
  refusal?: string;
  isError?: boolean;
}

export type PriorTurn =
  | { role: 'user' | 'assistant'; text: string }
  | PriorToolTurn;

export interface CallExpectation {
  /** A station-control tool name without the prefix, or a harness tool. */
  tool: string;
  /**
   * Partial match on the call's input. `null` requires the key to be absent;
   * a string starting with `~` is a case-insensitive substring; anything else
   * must be equal (JSON comparison).
   */
  args?: Record<string, unknown>;
}

export interface Expectation {
  /** The first tool call must be one of these. Requires at least one call. */
  firstCallAnyOf?: string[];
  /** Each must match some call in the response. */
  calls?: CallExpectation[];
  /** None of these tools may be called. */
  callsMustNot?: string[];
  /** Regular expressions no shell command may match (case-insensitive). */
  shellMustNot?: string[];
  /** No station-control tool may be called at all. */
  noStationTools?: boolean;
}

export interface ToolUseCase {
  id: string;
  kind: CaseKind;
  /** Where the bad experience happened: a PR, issue or commit. */
  source: string;
  /** The real experience, in a sentence. */
  experience: string;
  /** The station-control listing the session gets (Claude: bound; Codex, ACP: delegated-custody). */
  assurance: 'bound' | 'delegated-custody';
  /** The user's message. Empty continues after the last prior tool result. */
  prompt: string;
  priorTurns?: PriorTurn[];
  expect: Expectation;
}

export interface SampleGrade {
  pass: boolean;
  failures: string[];
}

/** `mcp__station-control__delegate_task` → `delegate_task`; others unchanged. */
export function shortToolName(name: string): string {
  return name.startsWith(STATION_CONTROL_PREFIX)
    ? name.slice(STATION_CONTROL_PREFIX.length)
    : name;
}

function readPath(input: Record<string, unknown>, path: string): unknown {
  let value: unknown = input;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Why `call` does not satisfy `args`, or undefined when it does. */
export function argsMismatch(
  input: Record<string, unknown>,
  args: Record<string, unknown> | undefined,
): string | undefined {
  for (const [path, want] of Object.entries(args ?? {})) {
    const got = readPath(input, path);
    if (want === null) {
      if (got !== undefined) return `${path} should be absent`;
    } else if (typeof want === 'string' && want.startsWith('~')) {
      if (
        typeof got !== 'string' ||
        !got.toLowerCase().includes(want.slice(1).toLowerCase())
      ) {
        return `${path} should contain "${want.slice(1)}"`;
      }
    } else if (JSON.stringify(got) !== JSON.stringify(want)) {
      return `${path} should be ${JSON.stringify(want)}`;
    }
  }
  return undefined;
}

/** Grade the tool calls of one response against a case. */
export function gradeSample(
  expect: Expectation,
  rawCalls: readonly ToolCall[],
): SampleGrade {
  const calls = rawCalls.map((c) => ({ ...c, name: shortToolName(c.name) }));
  const failures: string[] = [];

  if (expect.firstCallAnyOf) {
    const first = calls[0]?.name;
    if (!first) {
      failures.push(
        `expected a call to one of ${expect.firstCallAnyOf.join(', ')}; made none`,
      );
    } else if (!expect.firstCallAnyOf.includes(first)) {
      failures.push(
        `first call was ${first}; expected one of ${expect.firstCallAnyOf.join(', ')}`,
      );
    }
  }

  for (const want of expect.calls ?? []) {
    const named = calls.filter((c) => c.name === want.tool);
    if (named.length === 0) {
      failures.push(`expected a call to ${want.tool}`);
      continue;
    }
    const mismatches = named.map((c) => argsMismatch(c.input, want.args));
    if (!mismatches.includes(undefined)) {
      failures.push(`${want.tool}: ${mismatches[0]}`);
    }
  }

  for (const name of expect.callsMustNot ?? []) {
    if (calls.some((c) => c.name === name)) failures.push(`called ${name}`);
  }

  if (expect.noStationTools) {
    const station = rawCalls.filter((c) =>
      c.name.startsWith(STATION_CONTROL_PREFIX),
    );
    if (station.length > 0) {
      failures.push(
        `called a station-control tool: ${station.map((c) => shortToolName(c.name)).join(', ')}`,
      );
    }
  }

  const patterns = (expect.shellMustNot ?? []).map((p) => new RegExp(p, 'i'));
  for (const call of calls) {
    if (call.name !== SHELL_TOOL) continue;
    const command = call.input.command;
    if (typeof command !== 'string') continue;
    for (const pattern of patterns) {
      if (pattern.test(command)) {
        failures.push(`shell command matched /${pattern.source}/: ${command}`);
      }
    }
  }

  return { pass: failures.length === 0, failures };
}

/** A case fails when half or more of its samples fail. */
export function caseFails(grades: readonly SampleGrade[]): boolean {
  if (grades.length === 0) return true;
  const failed = grades.filter((g) => !g.pass).length;
  return failed * 2 >= grades.length;
}

export interface ResultRow {
  caseId: string;
  model: string;
  sample: number;
  pass: boolean;
  failures: string[];
  /** The calls the response made, for a person reading the run. */
  calls?: ToolCall[];
  /** Set when the API call itself failed; such rows count toward no rate. */
  error?: string;
}

export interface CaseComparison {
  caseId: string;
  passed: number;
  graded: number;
  baselinePassed?: number;
  baselineGraded?: number;
  fails: boolean;
  /** Passed every baseline sample and fails now. */
  regression: boolean;
}

/** Per-case pass counts, compared with a baseline run on the same model. */
export function compareRuns(
  rows: readonly ResultRow[],
  baseline: readonly ResultRow[] = [],
): CaseComparison[] {
  const byCase = (list: readonly ResultRow[]) => {
    const out = new Map<string, SampleGrade[]>();
    for (const row of list) {
      if (row.error) continue;
      const grades = out.get(row.caseId) ?? [];
      grades.push({ pass: row.pass, failures: row.failures });
      out.set(row.caseId, grades);
    }
    return out;
  };
  const now = byCase(rows);
  const before = byCase(baseline);
  return [...now.entries()].map(([caseId, grades]) => {
    const prior = before.get(caseId);
    const fails = caseFails(grades);
    const priorAllPassed =
      prior !== undefined && prior.length > 0 && prior.every((g) => g.pass);
    return {
      caseId,
      passed: grades.filter((g) => g.pass).length,
      graded: grades.length,
      ...(prior
        ? {
            baselinePassed: prior.filter((g) => g.pass).length,
            baselineGraded: prior.length,
          }
        : {}),
      fails,
      regression: priorAllPassed && fails,
    };
  });
}
