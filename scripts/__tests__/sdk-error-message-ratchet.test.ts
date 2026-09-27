import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  countEnvelopeReads,
  countHandRolledRefusals,
  ENVELOPE_BASELINE_PATH,
  ENVELOPE_EXEMPT_FILES,
  ENVELOPE_SCOPE_SENTINELS,
  EXEMPT_FILES,
  evaluate,
  evaluateEnvelopeReads,
  findEnvelopeReads,
  listEnvelopeScannedFiles,
  listScannedFiles,
  lowerEnvelopeBaseline,
  SCOPE_SENTINELS,
} from '../sdk-error-message-ratchet.mjs';

const count = (source: string) =>
  countHandRolledRefusals(['sample.ts'], () => source).reduce(
    (total, occurrence) => total + occurrence.count,
    0,
  );

describe('sdk-error-message ratchet source matching', () => {
  test.each([
    "throw new Error(result.error || 'Create failed');",
    "throw new Error(result.error ?? 'Create failed');",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately embeds a template placeholder
    'throw new Error(payload.error || `HTTP ${response.status}`);',
    "throw new Error(result?.error ?? 'Nope');",
    "throw new Error(j.error || 'Nope');",
  ])('catches the hand-rolled refusal: %s', (source) => {
    expect(count(source)).toBe(1);
  });

  test('catches a nested receiver — the same defect spelled differently', () => {
    expect(count('throw new Error(state.result.error || fallback);')).toBe(1);
    expect(count('throw new Error(read().error || fallback);')).toBe(1);
  });

  test('does not flag the helper call it exists to require', () => {
    expect(
      count("throw new Error(apiErrorMessage(result, 'Create failed'));"),
    ).toBe(0);
  });

  test('does not flag an unrelated `.error` read', () => {
    expect(count('if (result.error) report(result.error);')).toBe(0);
    expect(count('const message = mutation.error?.message;')).toBe(0);
  });
});

describe('sdk-error-message ratchet scope honesty', () => {
  test('every sentinel is inside the scanned set', () => {
    const files = listScannedFiles();
    for (const sentinel of SCOPE_SENTINELS) {
      expect(files).toContain(sentinel);
    }
  });

  test('a lost sentinel fails rather than reporting green', () => {
    expect(evaluate([], ['packages/sdk/src/api.ts'])).toMatchObject({
      ok: false,
    });
  });

  test('the scanned set is the tracked SDK sources minus tests and the helper', () => {
    // An independent re-derivation: a bug in the gate's own lister must not be
    // able to agree with itself (station#1559 class).
    const tracked = execFileSync(
      'git',
      ['ls-files', '--', 'packages/sdk/src'],
      { encoding: 'utf8', windowsHide: true },
    )
      .split('\n')
      .filter((line) => /\.tsx?$/.test(line))
      .filter((line) => !line.includes('__tests__'))
      .filter((line) => !EXEMPT_FILES.includes(line));

    expect([...listScannedFiles()].sort()).toEqual(tracked.sort());
  });

  test('the package is at zero, which is the whole point of #3749', () => {
    const files = listScannedFiles();
    expect(evaluate(countHandRolledRefusals(files), files)).toMatchObject({
      total: 0,
      ok: true,
    });
  });
});

const sites = (source: string) =>
  findEnvelopeReads(source).map((site: { kind: string }) => site.kind);

/**
 * #2708: the counted rule over `packages/sdk/src/client/**`. Each known-bad
 * case is a shape that was in the tree when the rule was written; each
 * control is a shape the rule must not claim.
 */
describe('sdk envelope-read rule: what counts', () => {
  test.each([
    // agents.ts / skills.ts: the string shape assumed.
    ['throw new Error(result.error);', 'new Error(.error)'],
    // skills.ts: the envelope's own message as a fallback.
    [
      "throw new Error(result.message || 'Install failed');",
      'new Error(.message)',
    ],
    [
      "throw new Error(apiErrorMessage(result, 'Save failed'));",
      'new Error(apiErrorMessage())',
    ],
    [
      "throw new Error(envelopeErrorMessage(body, 'Nope'));",
      'new Error(envelopeErrorMessage())',
    ],
    [
      "throw new Error(envelopeFailureMessage(body.error) ?? 'x');",
      'new Error(envelopeFailureMessage())',
    ],
    // The status read makes a subclass count too.
    [
      "throw new StationHttpError(response.status, 'Failed');",
      'new StationHttpError(response.status)',
    ],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately embeds a template placeholder
      'throw new Error(`Orchestration API error: ${response.status}`);',
      'new Error(response.status)',
    ],
    [
      "throw new PluginCollectionHttpError(body.code, 'x');",
      'new PluginCollectionHttpError(.code)',
    ],
    ["throw new Error(result?.error?.message ?? 'x');", 'new Error(.message)'],
    // #2708 review M2 (C): a Response under a short name.
    [
      "throw new StationHttpError(r.status, 'Failed');",
      'new StationHttpError(r.status)',
    ],
    // …or under any name, typed as one.
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately embeds a template placeholder
      'function f(reply: Response) { throw new Error(`HTTP ${reply.status}`); }',
      'new Error(reply.status)',
    ],
    // #2708 review L6: an `error` pulled out of a body is an envelope read.
    [
      'const { error } = body;\nthrow new Error(error);',
      'new Error(destructured error)',
    ],
    [
      'const { error } = body;\nthrow new Error(error.message);',
      'new Error(.message)',
    ],
  ])('counts %s', (source, kind) => {
    expect(sites(source)).toEqual([kind]);
  });

  test('counts the typeof ternaries that read an envelope outside a constructor', () => {
    // orchestration.ts / scheduler.ts / plugins.ts: message computed first.
    expect(
      sites(
        "const message = typeof result.error === 'string' ? result.error : fallback;",
      ),
    ).toEqual(["typeof x.error === 'string' ?"]);
    // pull-request-review.ts: with a guard before the `?`.
    expect(
      sites(
        "const m = !response.ok && typeof value?.error === 'string' && value.error.trim()\n  ? value.error\n  : undefined;",
      ),
    ).toEqual(["typeof x.error === 'string' ?"]);
  });

  // #2708 delta review L-b: only a catch binding is exempt. An ordinary
  // parameter, or a callback parameter that is not a rejection handler, holds
  // whatever the caller passed — usually a body.
  test('counts a read on an ordinary function parameter', () => {
    expect(
      sites('function unwrap(result) { throw new Error(result.error); }'),
    ).toEqual(['new Error(.error)']);
  });

  test('counts a read on a non-catch callback parameter', () => {
    expect(
      sites('items.forEach((error) => { throw new Error(error.message); });'),
    ).toEqual(['new Error(.message)']);
    expect(
      sites('p.then((error) => { throw new Error(error.message); });'),
    ).toEqual(['new Error(.message)']);
  });

  // #2708 delta review L-d: a destructured field counts only when it comes
  // out of a body read.
  test('counts a field destructured from an awaited response body', () => {
    expect(
      sites(
        'async function f(response) { const { error } = await response.json(); throw new Error(error); }',
      ),
    ).toEqual(['new Error(destructured error)']);
  });

  test('counts a message computed into a variable, then thrown (#2708 review M2 B)', () => {
    // orchestration.ts: the read happens before the constructor.
    expect(
      sites(
        "const message = apiErrorMessage(payload, 'x');\nthrow new Error(message);",
      ),
    ).toEqual(['apiErrorMessage() call']);
  });

  test('counts the Object.assign(new Error(reason), …) shape (#2708 review M2 D)', () => {
    expect(
      sites(
        "const reason = envelopeErrorMessage(body, 'x');\nthrow Object.assign(new Error(reason), { code: 'x' });",
      ),
    ).toEqual(['envelopeErrorMessage() call']);
    expect(
      sites(
        "throw Object.assign(new Error(apiErrorMessage(body, 'x')), { status: 400 });",
      ),
    ).toEqual(['new Error(apiErrorMessage())']);
  });

  test('never counts an import or export of a message-rule function', () => {
    expect(
      sites(
        "import { apiErrorMessage } from './api-error-message';\nexport { envelopeErrorMessage } from './http';",
      ),
    ).toEqual([]);
  });

  test('counts a .message fallback outside a constructor', () => {
    expect(sites("const text = result.message ?? 'Install failed';")).toEqual([
      '.message fallback',
    ]);
  });

  test('a ternary inside a counted constructor is one site, not two', () => {
    // attachment-staging.ts
    expect(
      sites(
        "throw new ChatHttpError(response.status, typeof body.error === 'string' ? body.error : fallback);",
      ),
    ).toEqual(['new ChatHttpError(response.status)']);
  });

  test.each([
    // projects.ts: client-side validation, no envelope at all.
    "throw new Error('Invalid Project catalogue.');",
    // Re-wrapping a caught failure is not an envelope read — decided by the
    // binding: a catch-clause variable, or a `.catch` callback parameter.
    'try { run(); } catch (error) { throw new Error(error.message); }',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately embeds a template placeholder
    'p.catch((err) => { throw new Error(`Import failed: ${err.message}`); });',
    "try { run(); } catch (error) { const text = error.message ?? 'x'; }",
    // The helper is the answer, not a violation.
    "throw envelopeError(response, body, 'Save failed');",
    // A status that is not a response's.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately embeds a template placeholder
    'throw new Error(`Unexpected ${state.status}`);',
    // An unrelated constructor reading `.error`.
    'const map = new Map(result.error);',
    // Prose names the banned shape; comments never count.
    "// throw new Error(result.error || result.message || 'x');\n/* typeof x.error === 'string' ? */",
    // #2708 delta review L-a: type wrappers do not hide a catch binding.
    'try { run(); } catch (error) { throw new Error((error as Error).message); }',
    'try { run(); } catch (caught) { const err = caught as Error; throw new Error(err.message); }',
    // …nor does a `.then(ok, onRejected)` rejection handler.
    'p.then(ok, (err) => { throw new Error(err.message); });',
    // #2708 delta review L-d: destructuring a non-body object is not an
    // envelope read, and neither is destructuring a caught failure.
    'function f(options) { const { message } = options; throw new Error(message); }',
    'try { run(); } catch (error) { const { message } = error; throw new Error(message); }',
    // A typeof check that is a guard, not a message ternary.
    "if (typeof result.error === 'string') report(result.error);",
  ])('does not count %s', (source) => {
    expect(sites(source)).toEqual([]);
  });
});

describe('sdk envelope-read rule: baseline', () => {
  const files = [...ENVELOPE_SCOPE_SENTINELS, 'packages/sdk/src/client/x.ts'];

  test('a new file with a site fails; a baselined row at its ceiling passes', () => {
    const baseline = { files: { 'packages/sdk/src/client/x.ts': 2 } };
    expect(
      evaluateEnvelopeReads(
        { 'packages/sdk/src/client/x.ts': 2 },
        files,
        baseline,
      ),
    ).toMatchObject({ ok: true, over: [] });
    expect(
      evaluateEnvelopeReads(
        {
          'packages/sdk/src/client/x.ts': 2,
          [ENVELOPE_SCOPE_SENTINELS[0]]: 1,
        },
        files,
        baseline,
      ),
    ).toMatchObject({
      ok: false,
      over: [{ file: ENVELOPE_SCOPE_SENTINELS[0], count: 1, ceiling: 0 }],
    });
  });

  test('a row below its ceiling fails: the ratchet is two-sided', () => {
    // A rule that silently stops counting reads 0 everywhere; a one-sided
    // ratchet would pass that forever.
    expect(
      evaluateEnvelopeReads({}, files, {
        files: { 'packages/sdk/src/client/x.ts': 2 },
      }),
    ).toMatchObject({
      ok: false,
      under: [{ file: 'packages/sdk/src/client/x.ts', count: 0, ceiling: 2 }],
    });
  });

  test('a lost sentinel fails rather than reporting green', () => {
    expect(
      evaluateEnvelopeReads({}, ['packages/sdk/src/client/x.ts'], {
        files: {},
      }),
    ).toMatchObject({ ok: false });
  });

  test('--update only lowers: it refuses a rise and a new file', () => {
    const baseline = { issue: '#2708', files: { 'a.ts': 3, 'b.ts': 1 } };
    expect(lowerEnvelopeBaseline({ 'a.ts': 2 }, baseline)).toEqual({
      ok: true,
      baseline: { issue: '#2708', files: { 'a.ts': 2 } },
    });
    expect(lowerEnvelopeBaseline({ 'a.ts': 4 }, baseline)).toMatchObject({
      ok: false,
      refused: [{ file: 'a.ts', count: 4, ceiling: 3 }],
    });
    expect(lowerEnvelopeBaseline({ 'c.ts': 1 }, baseline)).toMatchObject({
      ok: false,
      refused: [{ file: 'c.ts', count: 1, ceiling: 0 }],
    });
  });
});

describe('sdk envelope-read rule: the real tree', () => {
  test('every sentinel is inside the scanned client set', () => {
    const scanned = listEnvelopeScannedFiles();
    for (const sentinel of ENVELOPE_SCOPE_SENTINELS) {
      expect(scanned).toContain(sentinel);
    }
  });

  test('the scanned set is the client sources minus tests and the helper', () => {
    const tracked = execFileSync(
      'git',
      ['ls-files', '--', 'packages/sdk/src/client'],
      { encoding: 'utf8', windowsHide: true },
    )
      .split('\n')
      .filter((line) => /\.tsx?$/.test(line))
      .filter((line) => !line.includes('__tests__'))
      .filter((line) => !ENVELOPE_EXEMPT_FILES.includes(line));
    // Tracked files are a subset: the lister also sees new, uncommitted ones.
    expect(listEnvelopeScannedFiles()).toEqual(expect.arrayContaining(tracked));
  });

  test('the tree is at or below the checked-in baseline', () => {
    const scanned = listEnvelopeScannedFiles();
    const baseline = JSON.parse(readFileSync(ENVELOPE_BASELINE_PATH, 'utf8'));
    expect(
      evaluateEnvelopeReads(countEnvelopeReads(scanned), scanned, baseline),
    ).toMatchObject({
      ok: true,
      over: [],
      under: [],
      missingSentinels: [],
    });
  });
});

/**
 * The gate's REJECTION path, run as a real child process against a throwaway
 * git repository. A guardrail whose refusal has never executed is unproven:
 * the pure functions above say what it DECIDES, and only these say what it
 * does with that decision — the `FAIL:` sentence and, critically, the exit
 * status. Bounded, single-shot children; classified process-heavy in
 * `scripts/vitest-resource-manifest.mjs` for exactly that reason.
 */
describe('sdk-error-message ratchet at the process boundary', () => {
  const RATCHET = resolve(
    import.meta.dirname,
    '../sdk-error-message-ratchet.mjs',
  );
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function repoWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-error-ratchet-'));
    created.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), contents);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
    return dir;
  }

  /**
   * Every sentinel of both rules present and clean, plus an empty envelope
   * baseline, so only the injected file can decide.
   */
  const cleanSentinels: Record<string, string> = {
    ...Object.fromEntries(
      [...SCOPE_SENTINELS, ...ENVELOPE_SCOPE_SENTINELS].map((path) => [
        path,
        'export const ok = envelopeError;\n',
      ]),
    ),
    [ENVELOPE_BASELINE_PATH]: `${JSON.stringify({ issue: '#2708', files: {} })}\n`,
  };

  function runRatchet(dir: string, args: string[] = []) {
    return spawnSync(process.execPath, [RATCHET, ...args], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  const BASELINED = 'packages/sdk/src/client/legacy.ts';
  const legacySource = (sites: number) =>
    'throw new Error(result.error);\n'.repeat(sites);
  const withBaseline = (rows: Record<string, number>) => ({
    [ENVELOPE_BASELINE_PATH]: `${JSON.stringify({ issue: '#2708', files: rows })}\n`,
  });

  test('exits 1 and asks for --update when a row falls below the baseline', () => {
    const run = runRatchet(
      repoWith({
        ...cleanSentinels,
        [BASELINED]: legacySource(1),
        ...withBaseline({ [BASELINED]: 2 }),
      }),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'FAIL: envelope-read errors fell below the baseline',
    );
    expect(run.stderr).toContain(`${BASELINED}: 1 (baseline 2)`);
    expect(run.stderr).toContain('--update');
  });

  test('exits 0 on the baseline: a baselined envelope read at its row passes', () => {
    const run = runRatchet(
      repoWith({
        ...cleanSentinels,
        [BASELINED]: legacySource(2),
        ...withBaseline({ [BASELINED]: 2 }),
      }),
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('OK: 2 envelope-read error sites across');
  });

  test('exits 1 and names the file, line and shape when a client file adds an envelope read', () => {
    const run = runRatchet(
      repoWith({
        ...cleanSentinels,
        'packages/sdk/src/client/regressed.ts':
          "export async function f(response: Response) {\n  throw new StationHttpError(response.status, 'Failed');\n}\n",
      }),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'FAIL: client fetchers build their own error from an envelope above the baseline',
    );
    expect(run.stderr).toContain(
      'packages/sdk/src/client/regressed.ts: 1 (baseline 0)',
    );
    expect(run.stderr).toContain(
      'line 2: new StationHttpError(response.status)',
    );
  });

  test('exits 1 when a baselined row rises', () => {
    const run = runRatchet(
      repoWith({
        ...cleanSentinels,
        [BASELINED]: legacySource(3),
        ...withBaseline({ [BASELINED]: 2 }),
      }),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`${BASELINED}: 3 (baseline 2)`);
  });

  test('--update lowers a row and refuses to raise one', () => {
    const lowered = repoWith({
      ...cleanSentinels,
      [BASELINED]: legacySource(1),
      ...withBaseline({ [BASELINED]: 2 }),
    });
    const update = runRatchet(lowered, ['--update']);
    expect(update.status).toBe(0);
    expect(
      JSON.parse(readFileSync(join(lowered, ENVELOPE_BASELINE_PATH), 'utf8')),
    ).toEqual({ issue: '#2708', files: { [BASELINED]: 1 } });

    const raised = repoWith({
      ...cleanSentinels,
      [BASELINED]: legacySource(3),
      ...withBaseline({ [BASELINED]: 2 }),
    });
    const refused = runRatchet(raised, ['--update']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--update only lowers');
    expect(
      JSON.parse(readFileSync(join(raised, ENVELOPE_BASELINE_PATH), 'utf8')),
    ).toEqual({ issue: '#2708', files: { [BASELINED]: 2 } });
  });

  test('exits 1 when the client pathspec stops matching a sentinel', () => {
    const withoutOne = { ...cleanSentinels };
    delete withoutOne[ENVELOPE_SCOPE_SENTINELS[0]];
    const run = runRatchet(repoWith(withoutOne));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'envelope-read ratchet scope lost these files',
    );
  });

  test('exits 0 and names its scope when nothing hand-rolls a refusal', () => {
    const run = runRatchet(repoWith(cleanSentinels));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('OK: 0 hand-rolled refusal messages');
  });

  test('exits 1 and names the offending file when one regrows', () => {
    const run = runRatchet(
      repoWith({
        ...cleanSentinels,
        'packages/sdk/src/query-domains/regressed.ts':
          "throw new Error(result.error || 'Save failed');\n",
      }),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('FAIL: 1 hand-rolled refusal message(s)');
    expect(run.stderr).toContain(
      'packages/sdk/src/query-domains/regressed.ts: 1',
    );
  });

  test('exits 1 when the pathspec stops matching a sentinel', () => {
    const withoutOne = { ...cleanSentinels };
    delete withoutOne[SCOPE_SENTINELS[0]];
    const run = runRatchet(repoWith(withoutOne));
    // Vacuously green is the failure mode this guards: a smaller tree has to
    // fail loudly rather than report zero occurrences over nothing.
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('scope lost these files');
    expect(run.stderr).toContain(SCOPE_SENTINELS[0]);
  });
});
