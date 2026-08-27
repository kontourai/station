/**
 * Invariants that only a source scan can hold — station#1779 AC4, and the
 * single-fold claim station#1778 makes about `foldedSessionLifecycleState`.
 *
 * Both are absence claims about code that does not exist yet, so no runtime
 * test can reach them: nothing calls a deleted barrier, and a re-introduced
 * `?? 'running'` in a file nobody has written yet is exactly the thing that
 * would pass every behavioural suite.
 *
 * WHAT MAKES THIS A GATE RATHER THAN A GESTURE (points 3 and 4 were learned
 * from the delta review, which broke the first version of it):
 *
 *  1. A plain `grep` cannot be it. The deletions are described at length in
 *     the doc comments that explain WHY they are gone, so a raw match reds on
 *     its own rationale and gets deleted the first time it fires. The scan
 *     strips comments, so what it finds is a real reference.
 *  2. The identifiers are ASSEMBLED rather than written literally, so this
 *     file is inside its own scope. A gate that has to exempt itself leaves
 *     the one file where a reviewer is least likely to look.
 *  3. The corpus is pinned by NAMED FILES PER ROOT, not by a count. The first
 *     version asserted `files.length > 300` against an actual 960 — the
 *     verifier dropped `/routes/` from the walk, planted a live
 *     `providerRegistrationSettled` there, and the gate reported clean,
 *     because a floor tolerating ~69% corpus loss detects nothing. A count
 *     cannot see a missing subtree; a named file in each scanned root can.
 *  4. The scan covers every root a consumer could live in — `src-server/`,
 *     `packages/`, `src-ui/`, `src-shared/`, `scripts/` — not just the server
 *     tree the deletions happened to sit in.
 *
 * KNOWN, DISCLOSED LIMIT: `stripComments` is a regex, so a block-comment
 * opener inside a string literal swallows source up to the next closer. That
 * direction is PERMISSIVE — it can only hide a violation, never invent one —
 * and closing it properly needs a real parser. Disclosed rather than papered
 * over; the named-file pins are what bound the exposure.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/** Repository root, from this file's location. */
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;

/**
 * Every root a consumer of these identifiers could live in, each with files
 * that MUST be found inside it. The pins are the detection mechanism: if a
 * walk silently stops covering a root, its named files go missing and the
 * coverage test reds — where a count would simply get smaller.
 */
const SCANNED_ROOTS: Array<{ dir: string; mustContain: string[] }> = [
  {
    dir: 'src-server',
    mustContain: [
      'src-server/services/orchestration/orchestration-service.ts',
      'src-server/services/orchestration/orchestration-session-state.ts',
      'src-server/services/projects/attention-projection.ts',
      'src-server/routes/orchestration/orchestration.ts',
      'src-server/runtime/bootstrap/runtime-initialize.ts',
      'src-server/telemetry/metrics.ts',
    ],
  },
  {
    dir: 'packages',
    mustContain: [
      'packages/contracts/src/orchestration.ts',
      'packages/contracts/src/session-lifecycle.ts',
      'packages/sdk/src/query-domains/chatRuntimeTypes.ts',
    ],
  },
  { dir: 'src-ui', mustContain: ['src-ui/src/utils/sessionDisplay.ts'] },
  // `src-shared` holds a single `.ts` file, so `length > 0` alone would be a
  // near-vacuous coverage assertion (delta review, L-B) — the named file is
  // what actually proves the root was walked.
  { dir: 'src-shared', mustContain: ['src-shared/monitoring-keys.ts'] },
  { dir: 'scripts', mustContain: [] },
  // Clean today, and in scope because both already build orchestration
  // payloads: `tests/orchestration-recovery.spec.ts` constructs
  // `orchestration:snapshot` frames.
  { dir: 'tests', mustContain: ['tests/orchestration-recovery.spec.ts'] },
  { dir: 'examples', mustContain: [] },
];

/** Directories that are never first-party source. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.kontourai',
  '__snapshots__',
]);

/** Assembled so this file does not trip its own scan. */
const RETIRED = [
  // The startup barrier and its option.
  ['providerRegistration', 'Settled'],
  // The boot pass that wrote a synthetic `request.resolved{cancelled}`.
  ['reconcileOrphaned', 'Requests'],
  // Its completion receipt.
  ['session.orphan-reconciliation', '.completed'],
  // Its metric, and the rename that would have replaced it with a second
  // instrument nothing on a real Station can read (station#1686's class).
  ['orphanRequests', 'Reconciled'],
  ['orphan_requests', '_reconciled'],
  ['orphanRequests', 'Projected'],
  ['orphan_requests', '_projected'],
].map((parts) => parts.join(''));

/**
 * The `?? 'running'` resolution, assembled for the same reason.
 *
 * station#1778 claims there is ONE such decision in the codebase, named and
 * documented in `session-lifecycle.ts`, so that changing which direction an
 * unknown lifecycle state folds toward is one edit rather than a sweep. The
 * delta review found the claim FALSE — two independent copies survived, one
 * of them in a file this change edits — which is the divergent-copy disease
 * with a comment asserting it is cured. This is what makes the claim true and
 * keeps it true.
 */
const FOLD_COPY = ['lifecycleState ?? ', "'running'"].join('');
const FOLD_OWNER = 'packages/contracts/src/session-lifecycle.ts';
/**
 * What the owner's own body looks like. Deliberately NOT a generic
 * `?? 'running'` scan: `orchestration-session-state.ts` resolves a DIFFERENT
 * decision that way (`agentRunStatusFromSessionState(...) ?? 'running'`, an
 * agent-run status, not a lifecycle state), and a gate that flagged it would
 * be teaching the next reader to add an exemption list.
 */
const FOLD_OWNER_BODY = ['state ?? ', "'running'"].join('');

/**
 * The decorated wire shapes, and the cast that exempts a site from the
 * required member (delta review, finding 3 — and F9 in the fix round's own
 * injection table, which was UNCAUGHT until this gate existed).
 *
 * The required-member design is STRUCTURAL: it enforces at construction, and
 * a `as OrchestrationSessionSummary` cast makes the compiler stop looking. Two
 * such casts already existed in `src-ui` and compiled undecorated, which is
 * how a fixture can silently drift from the wire. Fixing those two instances
 * without a gate leaves nothing to stop the third.
 *
 * `satisfies X as X` is deliberately ALLOWED and is the prescribed form: the
 * `satisfies` clause type-checks the literal in full (an omitted member is
 * TS1360), while the trailing assertion keeps whatever widening the fixture's
 * `...overrides` spread needs. Only a BARE assertion is a hole.
 */
const DECORATED_SHAPES = [
  ['Orchestration', 'SessionSummary'],
  // station#3269: Summary was covered and Detail was not, while a fixture
  // cast to Detail sat one directory away. The shapes travel together — a
  // Detail carries a Summary — so covering one and not the other only means
  // the next invalid fixture picks the other door.
  ['Orchestration', 'SessionDetail'],
  ['AgentRun', 'Summary'],
  ['SessionBoard', 'Item'],
  ['ConversationList', 'Item'],
].map((parts) => parts.join(''));

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function collectSources(dir: string): string[] {
  const absolute = join(REPO_ROOT, dir);
  if (!existsSync(absolute)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
  };
  walk(absolute);
  return files;
}

function allScannedSources(): string[] {
  return SCANNED_ROOTS.flatMap((root) => collectSources(root.dir));
}

describe('orchestration source invariants — scan integrity', () => {
  test('the scanner sees live code and not prose (directional control)', () => {
    const identifier = RETIRED[0];
    expect(stripComments(`const ${identifier} = 1;`)).toContain(identifier);
    expect(stripComments(`// ${identifier}\n`)).not.toContain(identifier);
    expect(stripComments(`/**\n * ${identifier}\n */\n`)).not.toContain(
      identifier,
    );
    expect(stripComments(`const x = a.${FOLD_COPY};`)).toContain(FOLD_COPY);
  });

  test('every scanned root is reached, proven by named files rather than a count', () => {
    for (const root of SCANNED_ROOTS) {
      const found = collectSources(root.dir).map((file) =>
        relative(REPO_ROOT, file),
      );
      expect(found.length).toBeGreaterThan(0);
      for (const required of root.mustContain) {
        expect(found).toContain(required);
      }
    }
  });
});

describe('station#1779 AC4 — retired orphan-reconciliation machinery', () => {
  test('no live reference to any retired identifier survives in any scanned root', () => {
    const offenders: string[] = [];
    for (const file of allScannedSources()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const identifier of RETIRED) {
        if (source.includes(identifier)) {
          offenders.push(`${relative(REPO_ROOT, file)}: ${identifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * SCOPE, STATED SO THE NAME DOES NOT OVER-CLAIM (delta review, MEDIUM).
 *
 * This holds ONE SPELLING — the literal `lifecycleState ?? 'running'` — and
 * that is the spelling the two server-side copies used. It is NOT a claim that
 * every resolution of an absent lifecycle state in the repo goes through
 * `foldedSessionLifecycleState`: six `?? ''`-style resolutions that DECIDE
 * survive in `src-ui` (`sessionDisplay.ts`, `home-view-model.ts`,
 * `useMutableSessionDetailState.ts`, `DelegatedTaskCoordinator.tsx`), and they
 * are slice station#1781's surface, recorded in the PR's divergence table
 * rather than silently absorbed here.
 *
 * Three further spellings are invisible to a literal scan and are disclosed
 * rather than implied: a hoisted local (`const state = s.lifecycleState; …
 * state ?? 'running'`), a formatter line-wrap between `??` and the literal, and
 * `|| 'running'`. All are permissive directions — they hide a violation, never
 * invent one.
 */
describe('station#1778 — the server-side `lifecycleState ?? running` spelling', () => {
  test('no file outside the owner writes that spelling', () => {
    const offenders: string[] = [];
    for (const file of allScannedSources()) {
      const path = relative(REPO_ROOT, file);
      if (path === FOLD_OWNER) continue;
      if (stripComments(readFileSync(file, 'utf8')).includes(FOLD_COPY)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the owner really does contain the one resolution (directional control)', () => {
    // Without this, deleting the helper would make the test above pass by
    // there being nothing anywhere — "clean" and "gone" must not look alike.
    const owner = stripComments(
      readFileSync(join(REPO_ROOT, FOLD_OWNER), 'utf8'),
    );
    expect(owner).toContain('foldedSessionLifecycleState');
    expect(owner).toContain(FOLD_OWNER_BODY);
  });
});

/**
 * Every `as` TYPE POSITION in a source file, as raw text.
 *
 * The first version of this gate matched the single token sequence
 * `as <Shape>` and reported clean while FOUR live bypasses of the same hazard
 * sat in the published SDK, written as
 * `as { success: boolean; data?: <Shape>[]; error?: string }` — the object-type
 * form the codebase actually prefers. Matching one spelling of a hazard teaches
 * the next author which spelling to use.
 *
 * So the type expression is consumed structurally: from the `as` keyword until
 * the expression ends, tracking bracket depth so an inline object type spanning
 * several lines is one position rather than a truncated prefix.
 */
function asTypePositions(
  source: string,
): Array<{ index: number; text: string }> {
  const positions: Array<{ index: number; text: string }> = [];
  const keyword = /\bas\b/g;
  let match = keyword.exec(source);
  while (match !== null) {
    let cursor = match.index + 2;
    let depth = 0;
    let text = '';
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === '{' || char === '[' || char === '(') depth += 1;
      else if (char === '}' || char === ']' || char === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (
        depth === 0 &&
        (char === ';' || char === ',' || char === '=')
      ) {
        break;
      } else if (depth === 0 && char === '\n' && text.trim().length > 0) {
        break;
      }
      text += char;
      cursor += 1;
    }
    positions.push({ index: match.index, text });
    match = keyword.exec(source);
  }
  return positions;
}

/**
 * Whether the function containing the `as` at `index` runs the value through
 * the shared wire normalizer.
 *
 * THE ONLY LEGITIMATE REASON to name a decorated shape in an `as` is a wire
 * boundary: `response.json()` returns `unknown`, something has to describe the
 * envelope, and no amount of typing makes the peer send the field. What makes
 * that honest is not the cast — it is normalizing the member the cast claims.
 * So the allowance is CONDITIONAL on the fix being present, and the sibling
 * `SDK wire boundaries normalize what they assert` describe below makes the
 * condition load-bearing in the other direction: a boundary that names a shape
 * MUST normalize. Neither gate alone would close it; together, "cast without
 * normalizing" and "boundary without normalizing" are both red.
 *
 * Scoped to the enclosing function by reading forward to the next top-level
 * declaration, so normalizing in one exported function does not license a bare
 * cast in the next one.
 */
function normalizesWithinEnclosingFunction(
  source: string,
  index: number,
): boolean {
  const rest = source.slice(index);
  const nextTopLevel = rest.search(/\n(export |function |const |class )/);
  const body = nextTopLevel === -1 ? rest : rest.slice(0, nextTopLevel);
  return body.includes('withNormalizedAnswerability');
}

/**
 * Whether an `as` at `index` is the tail of the allowed `satisfies X as X`
 * form. Matched by PATTERN, not by a byte-exact `replaceAll`: the previous
 * version compared literal text, so a formatter line-wrap or a double space
 * inside the allowed form would have flagged it (fail-safe, but noisy enough
 * that the fix would be to weaken the gate).
 */
function isSatisfiesTail(
  source: string,
  index: number,
  shape: string,
): boolean {
  const before = source.slice(Math.max(0, index - 200), index);
  return new RegExp(`satisfies\\s+${shape}\\s*$`).test(before);
}

describe('station#1778 — the required member is not exempted by a cast', () => {
  test('no `as` type position names a decorated wire shape', () => {
    const offenders: string[] = [];
    for (const file of allScannedSources()) {
      const path = relative(REPO_ROOT, file);
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const position of asTypePositions(source)) {
        for (const shape of DECORATED_SHAPES) {
          if (!new RegExp(`\\b${shape}\\b`).test(position.text)) continue;
          if (isSatisfiesTail(source, position.index, shape)) continue;
          if (normalizesWithinEnclosingFunction(source, position.index)) {
            continue;
          }
          offenders.push(`${path}: as … ${shape}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the object-type form is caught, and the allowed form is not (directional control)', () => {
    const shape = DECORATED_SHAPES[0];
    const bareIdentifier = `const x = y as ${shape};`;
    // The dominant spelling in this codebase, and the one the first version of
    // this gate was blind to.
    const objectType = [
      'const result = (await response.json()) as {',
      '  success: boolean;',
      `  data?: ${shape}[];`,
      '  error?: string;',
      '};',
    ].join('\n');
    const allowed = `const x = { a: 1 } satisfies ${shape} as ${shape};`;

    const flagged = (source: string): boolean =>
      asTypePositions(source).some(
        (position) =>
          new RegExp(`\\b${shape}\\b`).test(position.text) &&
          !isSatisfiesTail(source, position.index, shape) &&
          !normalizesWithinEnclosingFunction(source, position.index),
      );

    expect(flagged(bareIdentifier)).toBe(true);
    expect(flagged(objectType)).toBe(true);
    expect(flagged(allowed)).toBe(false);
    // The wire-boundary allowance is conditional on the fix, not on the file.
    expect(
      flagged(`${objectType}\n  return data.map(withNormalizedAnswerability);`),
    ).toBe(false);
    // …and it does not carry into the next declaration.
    expect(
      flagged(
        `${objectType}\n  return data.map(withNormalizedAnswerability);\n` +
          `\nexport function other() {\n  return y as ${shape};\n}`,
      ),
    ).toBe(true);
    // Whitespace tolerance: the allowance is a pattern, not byte-exact text.
    expect(
      flagged(`const x = { a: 1 } satisfies  ${shape}  as ${shape};`),
    ).toBe(false);
  });
});

/**
 * The wire boundary the type CANNOT close, gated where it lives.
 *
 * `(await response.json()) as { data?: <Shape>[] }` is an assertion, so a peer
 * older than ADR 0012 yields a required member that is `undefined` at runtime.
 * The published SDK is the real version-skew surface, so any query-domain
 * module that both parses a response and names a decorated shape must run it
 * through the one shared normalizer.
 */
describe('station#1778 — SDK wire boundaries normalize what they assert', () => {
  const SDK_QUERY_DOMAINS = 'packages/sdk/src/query-domains';

  function sdkModulesNamingADecoratedShape(): string[] {
    return collectSources(SDK_QUERY_DOMAINS)
      .filter((file) => {
        const source = stripComments(readFileSync(file, 'utf8'));
        return (
          source.includes('.json()') &&
          DECORATED_SHAPES.some((shape) =>
            new RegExp(`\\b${shape}\\b`).test(source),
          )
        );
      })
      .map((file) => relative(REPO_ROOT, file));
  }

  test('the scan finds the modules it is meant to govern (directional control)', () => {
    // Without this, a rename of the query-domains directory would make the
    // assertion below pass by governing nothing.
    expect(sdkModulesNamingADecoratedShape().length).toBeGreaterThan(0);
  });

  test('every such module calls the shared normalizer', () => {
    const offenders = sdkModulesNamingADecoratedShape().filter(
      (path) =>
        !stripComments(readFileSync(join(REPO_ROOT, path), 'utf8')).includes(
          'withNormalizedAnswerability',
        ),
    );
    expect(offenders).toEqual([]);
  });
});
