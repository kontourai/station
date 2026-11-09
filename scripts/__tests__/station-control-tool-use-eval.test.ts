/**
 * The station-control-tool-use eval's grader and case table. The eval itself
 * calls a paid model and never runs here; this checks the plain logic that
 * scores it, and that every case still names tools this checkout offers.
 */
import { describe, expect, test } from 'vitest';
import {
  buildMessages,
  loadCases,
  validateCases,
} from '../evals/station-control-tool-use/cases.js';
import {
  caseFails,
  compareRuns,
  gradeSample,
  type ResultRow,
  type ToolUseCase,
} from '../evals/station-control-tool-use/grade.js';
import { listStationControlTools } from '../evals/station-control-tool-use/tools.js';

const sc = (name: string, input: Record<string, unknown> = {}) => ({
  name: `mcp__station-control__${name}`,
  input,
});
const bash = (command: string) => ({ name: 'Bash', input: { command } });

describe('gradeSample', () => {
  test('firstCallAnyOf passes the listed first call and fails another or none', () => {
    const expect_ = { firstCallAnyOf: ['wait_session', 'get_task'] };
    expect(gradeSample(expect_, [sc('get_task'), bash('ls')]).pass).toBe(true);
    expect(gradeSample(expect_, [bash('sleep 30'), sc('get_task')])).toEqual({
      pass: false,
      failures: ['first call was Bash; expected one of wait_session, get_task'],
    });
    expect(gradeSample(expect_, []).pass).toBe(false);
  });

  test('calls match args partially: null is absent, ~ is a substring, dotted paths reach nested keys', () => {
    const expect_ = {
      calls: [
        {
          tool: 'declare_pull_request',
          args: {
            number: '482',
            'repository.owner': 'acme',
            label: '~reconnect',
            projectSlug: null,
          },
        },
      ],
    };
    const good = sc('declare_pull_request', {
      number: '482',
      repository: { owner: 'acme', name: 'app' },
      label: 'Fix Reconnect',
    });
    expect(gradeSample(expect_, [good]).pass).toBe(true);
    expect(
      gradeSample(expect_, [
        { ...good, input: { ...good.input, projectSlug: 'x' } },
      ]).failures,
    ).toEqual(['declare_pull_request: projectSlug should be absent']);
    expect(
      gradeSample(expect_, [{ ...good, input: { ...good.input, number: 482 } }])
        .failures,
    ).toEqual(['declare_pull_request: number should be "482"']);
    expect(gradeSample(expect_, [bash('gh pr view')]).failures).toEqual([
      'expected a call to declare_pull_request',
    ]);
  });

  test('a call expectation passes when any one call of that tool matches', () => {
    const expect_ = {
      calls: [{ tool: 'delegate_task', args: { projectSlug: null } }],
    };
    expect(
      gradeSample(expect_, [
        sc('delegate_task', { projectSlug: 'acme-web' }),
        sc('delegate_task', { agent: 'reviewer' }),
      ]).pass,
    ).toBe(true);
  });

  test('callsMustNot, noStationTools and shellMustNot each fail on their own', () => {
    expect(
      gradeSample({ callsMustNot: ['send_message'] }, [sc('send_message')])
        .failures,
    ).toEqual(['called send_message']);
    expect(
      gradeSample({ noStationTools: true }, [bash('ls'), sc('list_agents')])
        .failures,
    ).toEqual(['called a station-control tool: list_agents']);
    expect(gradeSample({ noStationTools: true }, [bash('ls')]).pass).toBe(true);
    expect(
      gradeSample({ shellMustNot: ['\\bcodex\\b'] }, [
        bash('CODEX exec review'),
      ]).pass,
    ).toBe(false);
    // Only the shell's command is read: a station tool's text never matches.
    expect(
      gradeSample({ shellMustNot: ['\\bcodex\\b'] }, [
        sc('delegate_task', { prompt: 'ask codex' }),
      ]).pass,
    ).toBe(true);
  });
});

describe('aggregation', () => {
  const row = (caseId: string, pass: boolean, error?: string): ResultRow => ({
    caseId,
    model: 'm',
    sample: 1,
    pass,
    failures: [],
    ...(error ? { error } : {}),
  });

  test('a case fails when half or more of its samples fail', () => {
    const g = (pass: boolean) => ({ pass, failures: [] });
    expect(caseFails([g(true), g(true), g(false)])).toBe(false);
    expect(caseFails([g(true), g(false)])).toBe(true);
    expect(caseFails([])).toBe(true);
  });

  test('compareRuns flags a regression only when every baseline sample passed', () => {
    const baseline = [
      row('a', true),
      row('a', true),
      row('b', true),
      row('b', false),
    ];
    const now = [
      row('a', false),
      row('a', false),
      row('b', false),
      row('b', false),
    ];
    const byId = Object.fromEntries(
      compareRuns(now, baseline).map((c) => [c.caseId, c]),
    );
    expect(byId.a).toMatchObject({
      regression: true,
      baselinePassed: 2,
      passed: 0,
    });
    expect(byId.b).toMatchObject({ regression: false, fails: true });
  });

  test('errored samples count toward no pass rate', () => {
    const [c] = compareRuns([row('a', true), row('a', false, 'overloaded')]);
    expect(c).toMatchObject({ passed: 1, graded: 1, fails: false });
  });
});

describe('the case table', () => {
  const cases = loadCases();

  test('every case names tools this checkout offers and is well formed', async () => {
    const offered = {
      bound: new Set(
        (await listStationControlTools('bound')).map((t) => t.name),
      ),
      'delegated-custody': new Set(
        (await listStationControlTools('delegated-custody')).map((t) => t.name),
      ),
    };
    expect(validateCases(cases, offered)).toEqual([]);
  });

  test('validateCases reports a tool the session is not offered', () => {
    const broken: ToolUseCase = {
      ...cases[0],
      id: 'broken',
      assurance: 'delegated-custody',
      expect: { firstCallAnyOf: ['no_such_tool'] },
    };
    expect(
      validateCases([...cases, broken], {
        bound: new Set(),
        'delegated-custody': new Set(),
      }),
    ).toContain('broken: no_such_tool is not offered at delegated-custody');
  });

  test('a refusal result is Station’s own refusal body', () => {
    const c = cases.find((x) => x.id === 'out-of-scope-retry-in-own-project');
    if (!c) throw new Error('missing case');
    const messages = buildMessages(c);
    const result = messages.at(-1);
    if (!result || !Array.isArray(result.content)) throw new Error('no result');
    const block = result.content[0];
    expect(block).toMatchObject({ type: 'tool_result', is_error: true });
    const body = JSON.parse(String((block as { content: string }).content));
    expect(body).toMatchObject({
      success: false,
      code: 'station_control_out_of_scope',
      reason: 'other-project',
    });
    expect(body.error).toContain('omit projectSlug and projectPath');
  });

  test('every conversation ends on a user turn', () => {
    for (const c of cases) expect(buildMessages(c).at(-1)?.role).toBe('user');
  });
});
