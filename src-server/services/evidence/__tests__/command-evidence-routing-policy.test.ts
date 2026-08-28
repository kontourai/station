import { describe, expect, test } from 'vitest';
import {
  DefaultCommandEvidenceRoutingPolicy,
  type SpooledCommand,
} from '../command-evidence-routing-policy.js';

const DEFINITION = {
  id: 'test-flow',
  version: '1',
  steps: [{ id: 'build', next: null }],
  gates: {
    'build-gate': {
      step: 'build',
      expects: [
        {
          id: 'tests-passed',
          kind: 'trust.bundle',
          required: true,
          description: 'Tests pass.',
          bundle_claim: {
            claimType: 'quality.tests',
            accepted_statuses: ['assumed'],
          },
        },
      ],
    },
    'lint-gate': {
      step: 'build',
      expects: [
        {
          id: 'lint-clean',
          kind: 'trust.bundle',
          required: true,
          description: 'Lint clean.',
          bundle_claim: {
            claimType: 'quality.lint',
            accepted_statuses: ['assumed'],
          },
        },
      ],
    },
  },
} as unknown as Parameters<
  DefaultCommandEvidenceRoutingPolicy['route']
>[1]['definition'];

const OPEN_GATES = [
  { id: 'build-gate', step: 'build' },
  { id: 'lint-gate', step: 'build' },
];

function cmd(overrides: Partial<SpooledCommand> = {}): SpooledCommand {
  return {
    toolName: 'Bash',
    toolCallId: 'call-1',
    command: 'npm test',
    output: 'ok',
    status: 'success',
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    outputTruncated: false,
    ...overrides,
  };
}

describe('DefaultCommandEvidenceRoutingPolicy', () => {
  const policy = new DefaultCommandEvidenceRoutingPolicy();

  test('routes a test command to a gate that expects quality.tests', () => {
    const route = policy.route(cmd({ command: 'npm test' }), {
      definition: DEFINITION,
      openGates: OPEN_GATES,
    });
    expect(route).toEqual({
      gateId: 'build-gate',
      claimType: 'quality.tests',
      label: 'npm test',
    });
  });

  test('routes a lint command to the lint gate', () => {
    const route = policy.route(cmd({ command: 'npx biome check src/' }), {
      definition: DEFINITION,
      openGates: OPEN_GATES,
    });
    expect(route?.gateId).toBe('lint-gate');
    expect(route?.claimType).toBe('quality.lint');
  });

  test('returns null for non-command tools', () => {
    const route = policy.route(
      cmd({ toolName: 'edit_file', command: 'npm test' }),
      { definition: DEFINITION, openGates: OPEN_GATES },
    );
    expect(route).toBeNull();
  });

  test('returns null when the command matches no claim pattern', () => {
    const route = policy.route(cmd({ command: 'git status' }), {
      definition: DEFINITION,
      openGates: OPEN_GATES,
    });
    expect(route).toBeNull();
  });

  test('returns null when no open gate expects the claim type', () => {
    const route = policy.route(cmd({ command: 'npm run build' }), {
      definition: DEFINITION,
      openGates: OPEN_GATES,
    });
    // build.success is not expected by any gate here.
    expect(route).toBeNull();
  });

  test('returns null when the expecting gate is not open', () => {
    const route = policy.route(cmd({ command: 'npm test' }), {
      definition: DEFINITION,
      openGates: [{ id: 'lint-gate', step: 'build' }],
    });
    expect(route).toBeNull();
  });

  test('honors a custom tool-name allowlist', () => {
    const custom = new DefaultCommandEvidenceRoutingPolicy({
      commandToolNames: ['my_runner'],
    });
    expect(
      custom.route(cmd({ toolName: 'Bash', command: 'npm test' }), {
        definition: DEFINITION,
        openGates: OPEN_GATES,
      }),
    ).toBeNull();
    expect(
      custom.route(cmd({ toolName: 'my_runner', command: 'npm test' }), {
        definition: DEFINITION,
        openGates: OPEN_GATES,
      })?.gateId,
    ).toBe('build-gate');
  });
});

/**
 * The claim types Station's own `station-delivery` definition expects
 * (archive#189). These are held to a stricter standard than the generic
 * patterns: a false positive here does not misfile evidence, it PASSES a
 * delivery gate. Each case below is a command that must NOT be accepted as
 * that gate's evidence.
 */
describe('DefaultCommandEvidenceRoutingPolicy — station-delivery claim types', () => {
  const policy = new DefaultCommandEvidenceRoutingPolicy();

  const STATION_DEFINITION = {
    id: 'station-delivery',
    version: '1',
    steps: [{ id: 'ship', next: null }],
    gates: {
      'ship-gate': {
        step: 'ship',
        expects: [
          'quality.static-checks',
          'quality.verification',
          'governance.merge-readiness',
          'quality.tests',
          'quality.lint',
          'quality.typecheck',
          'build.success',
        ].map((claimType) => ({
          id: claimType,
          kind: 'trust.bundle',
          required: true,
          description: claimType,
          bundle_claim: { claimType, accepted_statuses: ['assumed'] },
        })),
      },
    },
  } as unknown as typeof DEFINITION;

  const SHIP_GATES = [{ id: 'ship-gate', step: 'ship' }];

  function claimTypeFor(command: string): string | undefined {
    return policy.route(cmd({ command }), {
      definition: STATION_DEFINITION,
      openGates: SHIP_GATES,
    })?.claimType;
  }

  test.each([
    ['npx playwright test tests/chat.spec.ts', 'quality.verification'],
    ['npm run test:e2e:extended', 'quality.verification'],
    ['npm run verify:e2e:full', 'quality.verification'],
    // The real implementation behind every `test:e2e:*` script; invoking it
    // directly is still running the browser lane.
    ['node scripts/run-e2e-suite.mjs --bucket product', 'quality.verification'],
    // Redirection and pipes are part of ordinary invocation — the leading
    // command is what decides, and here it is a real run.
    ['npx playwright test 2>&1 | tail -50', 'quality.verification'],
  ])('%s is behavioral verification', (command, claimType) => {
    expect(claimTypeFor(command)).toBe(claimType);
  });

  test.each([
    // Installing the browser binaries verifies nothing.
    'npm run install:playwright',
    // Reading the config verifies nothing.
    'cat playwright.config.ts',
    // A unit test whose FILE is named after playwright is still a unit test —
    // the verify-gate's expectation reads "not just unit tests".
    'npx vitest run src-ui/src/__tests__/playwright-helpers.test.ts',
    // Searching for the command is not running it.
    'rg playwright test',
    'grep -rn "playwright test" docs/',
  ])('%s is not behavioral verification', (command) => {
    expect(claimTypeFor(command)).not.toBe('quality.verification');
  });

  test.each([
    ['npm run verify:static', 'quality.static-checks'],
    ['npm run ci:fast', 'quality.static-checks'],
    // verify:local expands to static checks, so it is static-check evidence
    // and must never be accepted as behavioral verification.
    ['npm run verify:local', 'quality.static-checks'],
  ])('%s is a static check', (command, claimType) => {
    expect(claimTypeFor(command)).toBe(claimType);
  });

  test.each([
    ['npm run veritas:shadow', 'governance.merge-readiness'],
    ['npx veritas readiness --working-tree', 'governance.merge-readiness'],
  ])('%s is merge readiness', (command, claimType) => {
    expect(claimTypeFor(command)).toBe(claimType);
  });

  test.each([
    // A partial readiness run is not readiness for the whole working tree.
    'npx veritas readiness --check coverage --working-tree',
    'npm run veritas:readiness -- --check evidence',
  ])('%s is not merge readiness', (command) => {
    expect(claimTypeFor(command)).not.toBe('governance.merge-readiness');
  });

  test('an excluded command falls through to a lower pattern when the fallthrough is a real execution', () => {
    // Exclusion is per-pattern, not global: the readiness exclude only drops
    // `governance.merge-readiness`, so a real trailing test invocation still
    // routes to `quality.tests` rather than being dropped outright.
    expect(claimTypeFor('npx veritas readiness --check test && npm test')).toBe(
      'quality.tests',
    );
  });

  test('an excluded command with no real execution below it falls through to NO-ROUTE', () => {
    // `--check test` is a mention (a --check category value), not a test
    // execution — archive#1433's exact bug class. Before the fix this fell
    // through to `quality.tests` off the bare word; now `quality.tests`
    // requires an execution verb, so nothing below the readiness exclude
    // matches and the command correctly does not route anywhere.
    expect(claimTypeFor('npx veritas readiness --check test')).toBeUndefined();
  });

  test('reports every claim type it can produce', () => {
    expect(policy.routableClaimTypes()).toEqual([
      'quality.static-checks',
      'governance.merge-readiness',
      'quality.verification',
      'quality.tests',
      'quality.typecheck',
      'quality.lint',
      'build.success',
    ]);
  });
});

/**
 * archive#1433: the generic entries (`quality.tests`, `quality.typecheck`,
 * `quality.lint`, `build.success`) used to be bare word matches, so they
 * matched a MENTION of the word anywhere in the command line, not an actual
 * execution. Redesigned around execution verbs — the same discipline already
 * applied to `quality.verification` in archive#189 — with no bolt-on
 * exclusion list (per the archive#189 round-3 review ruling).
 */
describe('DefaultCommandEvidenceRoutingPolicy — generic patterns require an execution verb', () => {
  const policy = new DefaultCommandEvidenceRoutingPolicy();

  // Every generic claim type is expected by this gate, so `route()` reduces
  // to "did any pattern match" — the routing question this describe block
  // is actually about.
  const GENERIC_DEFINITION = {
    id: 'test-flow',
    version: '1',
    steps: [{ id: 'ship', next: null }],
    gates: {
      'ship-gate': {
        step: 'ship',
        expects: [
          'quality.tests',
          'quality.typecheck',
          'quality.lint',
          'build.success',
        ].map((claimType) => ({
          id: claimType,
          kind: 'trust.bundle',
          required: true,
          description: claimType,
          bundle_claim: { claimType, accepted_statuses: ['assumed'] },
        })),
      },
    },
  } as unknown as typeof DEFINITION;
  const OPEN = [{ id: 'ship-gate', step: 'ship' }];

  function routeFor(command: string) {
    return policy.route(cmd({ command }), {
      definition: GENERIC_DEFINITION,
      openGates: OPEN,
    });
  }

  test('rm -rf test-results && npm run build routes to build.success, not quality.tests', () => {
    // The motivating case: a bare `\btest\b` word match would have matched
    // "test-results" and misrouted this to quality.tests.
    const route = routeFor('rm -rf test-results && npm run build');
    expect(route?.claimType).toBe('build.success');
  });

  test('rg playwright test does not route at all', () => {
    // Not just excluded from quality.verification (archive#189) — the bare
    // word `test` inside a search query must not fall through to
    // quality.tests either.
    expect(routeFor('rg playwright test')).toBeNull();
  });

  test('cat vitest.config.ts does not route at all', () => {
    // Mentioning vitest by reading its config is not running it.
    expect(routeFor('cat vitest.config.ts')).toBeNull();
  });

  test('grep -rn "npm run build" docs/ does not route at all', () => {
    // Searching for the string "npm run build" is not building.
    expect(routeFor('grep -rn "npm run build" docs/')).toBeNull();
  });

  test.each([
    ['npm test', 'quality.tests'],
    ['npm run test', 'quality.tests'],
    ['npm run test:unit', 'quality.tests'],
    ['vitest run', 'quality.tests'],
    ['npx vitest run src/foo.test.ts', 'quality.tests'],
    ['yarn jest', 'quality.tests'],
    ['pytest -k foo', 'quality.tests'],
    ['CI=true npm test', 'quality.tests'],
    ['npx vitest run --coverage 2>&1 | tail -50', 'quality.tests'],
    ['tsc', 'quality.typecheck'],
    ['tsc --noEmit', 'quality.typecheck'],
    ['npm run typecheck', 'quality.typecheck'],
    ['npm run typecheck:strict', 'quality.typecheck'],
    ['NODE_ENV=test npx tsc --noEmit | tail -20', 'quality.typecheck'],
    ['npx biome check src/', 'quality.lint'],
    ['biome lint .', 'quality.lint'],
    ['eslint .', 'quality.lint'],
    ['npm run lint', 'quality.lint'],
    ['npm run lint:fix 2>&1 | tail', 'quality.lint'],
    ['npm run build', 'build.success'],
    ['npm run build:prod', 'build.success'],
    ['vite build', 'build.success'],
    ['tsc -b', 'build.success'],
    ['tsc --build', 'build.success'],
    ['npm run compile', 'build.success'],
    ['CI=true npm run build 2>&1 | tail -20', 'build.success'],
  ])('%s routes to %s (real invocation)', (command, claimType) => {
    expect(routeFor(command)?.claimType).toBe(claimType);
  });

  test.each([
    // "test" is a POSIX shell builtin (a conditional), not a test run, so it
    // must never route on its own — only behind an actual runner.
    'test -f package.json',
    // Mentions, not executions.
    'echo "run npm test before merging"',
    'cat build.log',
    'grep -rn "eslint" docs/README.md',
  ])('%s does not route', (command) => {
    expect(routeFor(command)).toBeNull();
  });
});

/**
 * archive#1433 round-2 review fixes: a ReDoS in the anchor (HIGH-1), a
 * multi-line/indentation gap (MEDIUM-3), missing non-JS ecosystems
 * (MEDIUM-4), no-op invocations routing as passing evidence (MEDIUM-1), a
 * too-strict tsc build exclude (LOW), and the repo's own mandated sentinel
 * idiom not routing (MEDIUM-2 partial).
 */
describe('DefaultCommandEvidenceRoutingPolicy — round-2 review fixes', () => {
  const policy = new DefaultCommandEvidenceRoutingPolicy();

  const GENERIC_DEFINITION = {
    id: 'test-flow',
    version: '1',
    steps: [{ id: 'ship', next: null }],
    gates: {
      'ship-gate': {
        step: 'ship',
        expects: [
          'quality.tests',
          'quality.typecheck',
          'quality.lint',
          'build.success',
        ].map((claimType) => ({
          id: claimType,
          kind: 'trust.bundle',
          required: true,
          description: claimType,
          bundle_claim: { claimType, accepted_statuses: ['assumed'] },
        })),
      },
    },
  } as unknown as typeof DEFINITION;
  const OPEN = [{ id: 'ship-gate', step: 'ship' }];

  function routeFor(command: string) {
    return policy.route(cmd({ command }), {
      definition: GENERIC_DEFINITION,
      openGates: OPEN,
    });
  }

  describe('HIGH-1: ReDoS regression gate', () => {
    // Command strings are agent-authored and uncapped, and the evidence
    // bridge drains up to 100 in one pass, so a single crafted command must
    // never cost more than a small constant. The fixed anchor measures well
    // under 1ms; 250ms is a generous bound that still fails hard on any
    // reintroduced quadratic backtracking (the pre-fix `[&;|]+` form
    // measured 10.9s and 4.2s respectively on these two inputs).
    test('route() on a 6000-repeat operator string completes fast', () => {
      const start = performance.now();
      routeFor('&;|'.repeat(6000));
      expect(performance.now() - start).toBeLessThan(250);
    });

    test('route() on an 8000-repeat && string completes fast', () => {
      const start = performance.now();
      routeFor('&&'.repeat(8000));
      expect(performance.now() - start).toBeLessThan(250);
    });

    // Found while re-verifying the bound after MEDIUM-3's `m`-flag change:
    // an unbounded `\s*` in the anchor CAN cross newlines, and the `m` flag
    // gives the engine one valid line-start anchor per newline, so a string
    // of many blank lines followed by real content re-creates HIGH-1 one
    // level up (probe-confirmed: 27ms at 6000 newlines, 2.9s at 48000,
    // ~4x per doubling). Fixed by scoping the anchor's whitespace to `WS`
    // (`[ \t]`, no `\n`) so a blank-line position has nothing to backtrack.
    test('route() on a string of many blank lines before a real command completes fast', () => {
      const start = performance.now();
      routeFor(`${'\n'.repeat(48000)}npm test`);
      expect(performance.now() - start).toBeLessThan(250);
    });

    // Found in the same pass: `stripConditionalWrapper`'s own regex (used
    // unconditionally on every route() call) had two adjacent unbounded
    // `\s*` quantifiers separated only by an optional single character — a
    // textbook catastrophic-backtracking shape, independent of the anchor
    // fix above (probe-confirmed: 363ms in isolation on a 24000-newline
    // string with no "if", before the two `\s*` were merged into one
    // `[\s(]*` class).
    test('route() on a long whitespace run with no "if" completes fast', () => {
      const start = performance.now();
      routeFor(`${' '.repeat(80000)}echo done`);
      expect(performance.now() - start).toBeLessThan(250);
    });

    test('route() on a combined blank-line/operator/tsc-noise string with no match completes fast', () => {
      const start = performance.now();
      routeFor('\n&;| tsc x '.repeat(16000));
      expect(performance.now() - start).toBeLessThan(250);
    });
  });

  describe('MEDIUM-3: multi-line commands and leading indentation', () => {
    test('a command on the second line of a multi-statement script routes', () => {
      expect(routeFor('echo starting\nnpm test')?.claimType).toBe(
        'quality.tests',
      );
    });

    test('indented npm test routes', () => {
      expect(routeFor('  npm test')?.claimType).toBe('quality.tests');
    });

    test('indented command after a chain operator still routes', () => {
      expect(
        routeFor('rm -rf test-results &&   npm run build')?.claimType,
      ).toBe('build.success');
    });
  });

  describe('MEDIUM-4: non-JS ecosystems route with the same verb discipline', () => {
    test.each([
      ['python -m pytest', 'quality.tests'],
      ['python3 -m pytest', 'quality.tests'],
      ['poetry run pytest', 'quality.tests'],
      ['uv run pytest', 'quality.tests'],
      ['go test ./...', 'quality.tests'],
      ['cargo test', 'quality.tests'],
      ['deno test', 'quality.tests'],
      ['cargo build --release', 'build.success'],
      ['go build ./...', 'build.success'],
    ])('%s routes to %s', (command, claimType) => {
      expect(routeFor(command)?.claimType).toBe(claimType);
    });

    test('grep -rn "go test" ci-docs.md does not route', () => {
      // Mentions inside a non-JS ecosystem must not route either — same
      // discipline as the JS-land negative cases above.
      expect(routeFor('grep -rn "go test" ci-docs.md')).toBeNull();
    });
  });

  describe('MEDIUM-1: no-op invocations do not route as passing evidence', () => {
    test.each([
      'npx vitest --version',
      'npm run test:changed -- --explain',
      'npx tsc --init',
      'npm run build --dry-run',
      'npm test -- --listTests',
      'npm run lint --help',
    ])('%s does not route', (command) => {
      expect(routeFor(command)).toBeNull();
    });

    test('a real run alongside an unrelated --help elsewhere in the chain still does not route to the flagged claim type', () => {
      // The exclude is per-pattern and scans the whole command string, so a
      // trailing --help anywhere disqualifies that claim type outright
      // (conservative by design: no-op flags are rare enough on a real
      // invocation that dropping the whole command is safer than trying to
      // scope the flag to one segment of a chain).
      expect(routeFor('npm test --help')).toBeNull();
    });
  });

  describe('LOW: tsc build exclude matches a flag anywhere in the invocation', () => {
    test('tsc -p tsconfig.json --build falls through to build.success', () => {
      expect(routeFor('tsc -p tsconfig.json --build')?.claimType).toBe(
        'build.success',
      );
    });

    test('tsc --build -p tsconfig.json also falls through to build.success', () => {
      expect(routeFor('tsc --build -p tsconfig.json')?.claimType).toBe(
        'build.success',
      );
    });

    test('a plain tsc invocation with unrelated flags still type-checks', () => {
      expect(routeFor('tsc -p tsconfig.json --pretty')?.claimType).toBe(
        'quality.typecheck',
      );
    });
  });

  describe('MEDIUM-2 partial: the repo-mandated sentinel idiom routes', () => {
    test('if <cmd>; then echo OK; fi routes on the wrapped command', () => {
      expect(routeFor('if npm test; then echo OK; fi')?.claimType).toBe(
        'quality.tests',
      );
    });

    test('if <cmd>; then echo OK; else echo FAIL; fi (the full mandated idiom) routes', () => {
      expect(
        routeFor('if npm run build; then echo OK; else echo FAIL; fi')
          ?.claimType,
      ).toBe('build.success');
    });

    test('the route label still carries the original, unstripped command', () => {
      const route = routeFor('if npm test; then echo OK; fi');
      expect(route?.label).toBe('if npm test; then echo OK; fi');
    });

    test('a subshell-wrapped if still routes', () => {
      expect(routeFor('(if npm test; then echo OK; fi)')?.claimType).toBe(
        'quality.tests',
      );
    });
  });

  /**
   * archive#1433 round-3 review, NEW-1 (HIGH): the `m`-flag anchor
   * (MEDIUM-3) treats every line as a potential leading invocation,
   * including a heredoc BODY line — so a command that only WRITES "npm
   * test" into a file (a shell script, a Makefile, a doc) was routing as if
   * it had RUN npm test. `stripHeredocBodies` truncates the matchable view
   * at the first newline after a heredoc opening marker.
   */
  describe('NEW-1: heredoc/file-authoring bodies do not route', () => {
    test.each([
      ["cat > run.sh <<'EOF'\nnpm test\nEOF", 'single-quoted marker'],
      ['cat > run.sh <<EOF\nnpm test\nEOF', 'unquoted marker'],
      ['cat > run.sh <<-EOF\n\tnpm test\nEOF', 'dash-indented marker'],
      [
        'cat > Makefile <<"DELIM"\ntest:\n\tnpm test\nDELIM',
        'double-quoted marker, Makefile body',
      ],
    ])('%s (%s) does not route', (command) => {
      expect(routeFor(command)).toBeNull();
    });

    test('a here-string (<<<) is not a heredoc and keeps routing normally', () => {
      expect(routeFor('npm test <<< "input"')?.claimType).toBe('quality.tests');
    });

    test('a real multi-line command with no heredoc marker is unaffected', () => {
      expect(routeFor('echo starting\nnpm test')?.claimType).toBe(
        'quality.tests',
      );
    });

    test('an indented command after a chain operator is unaffected', () => {
      expect(
        routeFor('rm -rf test-results &&   npm run build')?.claimType,
      ).toBe('build.success');
    });

    test('a piped real invocation is unaffected', () => {
      expect(
        routeFor('npx vitest run --coverage 2>&1 | tail -50')?.claimType,
      ).toBe('quality.tests');
    });
  });

  describe('NEW-1: stripHeredocBodies ReDoS regression gate', () => {
    // The strip runs unconditionally on every route(), like
    // stripConditionalWrapper before it, so it gets the same bound.
    test('route() on a long marker-free whitespace-padded string completes fast', () => {
      const start = performance.now();
      routeFor(`${' '.repeat(80000)}npm test`);
      expect(performance.now() - start).toBeLessThan(250);
    });

    test('route() on a string with many "<<"-like substrings and no real marker completes fast', () => {
      const start = performance.now();
      routeFor('a << b << c '.repeat(8000));
      expect(performance.now() - start).toBeLessThan(250);
    });

    test('route() on a heredoc marker followed by a huge body with no further newline completes fast', () => {
      const start = performance.now();
      routeFor(`cat > run.sh <<EOF\n${'x'.repeat(200000)}`);
      expect(performance.now() - start).toBeLessThan(250);
    });
  });
});

/**
 * archive#1433 round-3 review, NEW-4: `quality.verification` is a claim
 * type a LIVE station-delivery gate expects, so a no-op invocation that
 * happens to match its verb pattern (`npm run test:e2e --help`) is not a
 * diagnostic curiosity — it is evidence that would falsely pass a real
 * gate. `governance.merge-readiness` and `quality.static-checks` gained the
 * same NO_OP_EXCLUDE treatment in archive#1451 (see the describe block
 * below).
 */
describe('DefaultCommandEvidenceRoutingPolicy — NEW-4: quality.verification rejects no-op invocations', () => {
  const policy = new DefaultCommandEvidenceRoutingPolicy();

  const VERIFICATION_DEFINITION = {
    id: 'test-flow',
    version: '1',
    steps: [{ id: 'ship', next: null }],
    gates: {
      'ship-gate': {
        step: 'ship',
        expects: [
          {
            id: 'quality.verification',
            kind: 'trust.bundle',
            required: true,
            description: 'quality.verification',
            bundle_claim: {
              claimType: 'quality.verification',
              accepted_statuses: ['assumed'],
            },
          },
        ],
      },
    },
  } as unknown as typeof DEFINITION;
  const OPEN = [{ id: 'ship-gate', step: 'ship' }];

  function routeFor(command: string) {
    return policy.route(cmd({ command }), {
      definition: VERIFICATION_DEFINITION,
      openGates: OPEN,
    });
  }

  test('npm run test:e2e --help does not route to quality.verification', () => {
    expect(routeFor('npm run test:e2e --help')).toBeNull();
  });

  test('a real test:e2e invocation still routes', () => {
    expect(routeFor('npm run test:e2e:extended')?.claimType).toBe(
      'quality.verification',
    );
  });
});

/**
 * archive#1433 round-3 review, NEW-4 boundary: `--list(?:Tests)?` must not
 * match as a prefix of an unrelated flag like prettier's `--list-different`.
 */
describe('DefaultCommandEvidenceRoutingPolicy — NEW-4 boundary: --list-different is not a no-op flag', () => {
  const policy = new DefaultCommandEvidenceRoutingPolicy();

  const LINT_DEFINITION = {
    id: 'test-flow',
    version: '1',
    steps: [{ id: 'ship', next: null }],
    gates: {
      'ship-gate': {
        step: 'ship',
        expects: [
          {
            id: 'quality.lint',
            kind: 'trust.bundle',
            required: true,
            description: 'quality.lint',
            bundle_claim: {
              claimType: 'quality.lint',
              accepted_statuses: ['assumed'],
            },
          },
        ],
      },
    },
  } as unknown as typeof DEFINITION;
  const OPEN = [{ id: 'ship-gate', step: 'ship' }];

  test('npx prettier --list-different routes normally, not excluded as a no-op', () => {
    // prettier isn't itself a recognized lint verb, so use the repo's own
    // biome lint form with the same trailing flag to prove the boundary:
    // `--list-different` must not trip NO_OP_EXCLUDE.
    const route = policy.route(
      cmd({ command: 'biome lint --list-different .' }),
      { definition: LINT_DEFINITION, openGates: OPEN },
    );
    expect(route?.claimType).toBe('quality.lint');
  });

  test('npm run lint --listTests is still excluded as a no-op (exact flag, unaffected by the tightened boundary)', () => {
    const route = policy.route(cmd({ command: 'npm run lint --listTests' }), {
      definition: LINT_DEFINITION,
      openGates: OPEN,
    });
    expect(route).toBeNull();
  });
});

/**
 * archive#1451: `quality.static-checks`, `quality.verification`, and
 * `governance.merge-readiness` are the three claim types a LIVE
 * station-delivery gate actually expects (see the "station-delivery claim
 * types" describe block above), yet still matched a MENTION anywhere in
 * the command line rather than an execution — the exact archive#189 M1 class,
 * surviving on the patterns that matter most: a false positive here
 * doesn't misfile evidence, it PASSES a real gate. Found during archive#1433's
 * independent review (2026-08-01). Fixed with the same leading-command
 * verb anchoring already applied to the generic four; the review's probe
 * corpus is the negative-test set below.
 */
describe('DefaultCommandEvidenceRoutingPolicy — station#1451: gate-passing patterns require an execution verb, not a mention', () => {
  const policy = new DefaultCommandEvidenceRoutingPolicy();

  const GATE_DEFINITION = {
    id: 'test-flow',
    version: '1',
    steps: [{ id: 'ship', next: null }],
    gates: {
      'ship-gate': {
        step: 'ship',
        expects: [
          'quality.static-checks',
          'governance.merge-readiness',
          'quality.verification',
        ].map((claimType) => ({
          id: claimType,
          kind: 'trust.bundle',
          required: true,
          description: claimType,
          bundle_claim: { claimType, accepted_statuses: ['assumed'] },
        })),
      },
    },
  } as unknown as typeof DEFINITION;
  const OPEN = [{ id: 'ship-gate', step: 'ship' }];

  function claimTypeFor(command: string): string | undefined {
    return policy.route(cmd({ command }), {
      definition: GATE_DEFINITION,
      openGates: OPEN,
    })?.claimType;
  }

  describe('quality.static-checks', () => {
    test.each([
      // The exact archive#1451 probe corpus: echoing/searching/committing about
      // the command is not running it.
      'echo "run npm run ci:fast first"',
      'grep -rn "verify:static" docs/',
      'git commit -m "chore: speed up ci:fast"',
    ])('%s does not route (mention, not execution)', (command) => {
      expect(claimTypeFor(command)).toBeUndefined();
    });

    test.each([
      ['npm run verify:static', 'quality.static-checks'],
      ['npm run verify:local', 'quality.static-checks'],
      ['npm run ci:fast', 'quality.static-checks'],
      ['yarn run ci:fast', 'quality.static-checks'],
      // npm's documented `--` argument separator (archive#1451 review FN-1).
      ['npm run -- ci:fast', 'quality.static-checks'],
      // The coordinator behind the npm scripts, invoked directly.
      [
        'node scripts/run-verification.mjs request verify-static',
        'quality.static-checks',
      ],
      [
        'node scripts/run-verification.mjs request ci-fast',
        'quality.static-checks',
      ],
      [
        'node scripts/run-verification.mjs request verify-local',
        'quality.static-checks',
      ],
    ])('%s routes to %s (real invocation)', (command, claimType) => {
      expect(claimTypeFor(command)).toBe(claimType);
    });

    test('a private :raw suffix does not satisfy the canonical claim', () => {
      // verify:static:raw BYPASSES scripts/run-verification.mjs's
      // coordinator (host-wide lease, receipt content-addressing) entirely,
      // so it is not evidence of the same coordinated lane the claim
      // represents — an over-claim VERB_END's exact boundary prevents
      // regardless of what AGENTS.md says about invoking it.
      expect(claimTypeFor('npm run verify:static:raw')).toBeUndefined();
    });

    test('npm run ci:fast --dry-run does not route (no-op)', () => {
      expect(claimTypeFor('npm run ci:fast --dry-run')).toBeUndefined();
    });

    test('node scripts/run-verification.mjs status does not route (a lease/capacity query, not a run)', () => {
      expect(
        claimTypeFor('node scripts/run-verification.mjs status'),
      ).toBeUndefined();
    });

    test('node scripts/run-verification.mjs request unknown-lane does not route', () => {
      expect(
        claimTypeFor('node scripts/run-verification.mjs request unknown-lane'),
      ).toBeUndefined();
    });
  });

  describe('governance.merge-readiness', () => {
    test.each([
      // The exact archive#1451 probe corpus: git history/commit-message mentions
      // of "veritas readiness" are not a readiness run.
      'git log --grep "veritas readiness"',
      'git commit -m "docs: mention veritas readiness"',
    ])('%s does not route (mention, not execution)', (command) => {
      expect(claimTypeFor(command)).toBeUndefined();
    });

    test.each([
      ['npm run veritas:shadow', 'governance.merge-readiness'],
      ['npm run veritas:readiness', 'governance.merge-readiness'],
      ['npm run veritas:readiness:diff', 'governance.merge-readiness'],
      ['veritas readiness --working-tree', 'governance.merge-readiness'],
      ['npx veritas readiness --working-tree', 'governance.merge-readiness'],
      [
        'npm exec veritas readiness --working-tree',
        'governance.merge-readiness',
      ],
      // The VERBATIM body of this repo's own veritas:shadow/veritas:readiness
      // npm scripts (package.json) — archive#1451 review FN-1, reviewer-
      // verified: npm's documented `--` separator broke the anchor before
      // this fix, so an agent running the expanded form (instead of the
      // `npm run veritas:shadow` alias) produced NO-ROUTE.
      [
        'npm exec -- veritas readiness --working-tree',
        'governance.merge-readiness',
      ],
    ])('%s routes to %s (real invocation)', (command, claimType) => {
      expect(claimTypeFor(command)).toBe(claimType);
    });

    test('npx veritas readiness --help does not route (no-op)', () => {
      expect(claimTypeFor('npx veritas readiness --help')).toBeUndefined();
    });

    test('npx veritas readiness --check coverage --working-tree still does not route (partial run, pre-existing exclude preserved)', () => {
      expect(
        claimTypeFor('npx veritas readiness --check coverage --working-tree'),
      ).toBeUndefined();
    });
  });

  describe('quality.verification', () => {
    test.each([
      // The exact archive#1451 probe corpus: echoing, searching within a file, and
      // finding a FILE NAMED after run-e2e-suite are none of them running
      // the browser lane. Not previously excluded by the search-tool
      // prefix list (echo/sed/find are not rg/grep/ack/ag/cat/less/head) —
      // this is what leading-command anchoring closes.
      'echo "npm run test:e2e"',
      'sed -n "/test:e2e/p" package.json',
      'find . -name "*run-e2e-suite*"',
    ])('%s does not route (mention, not execution)', (command) => {
      expect(claimTypeFor(command)).toBeUndefined();
    });

    test.each([
      ['npx playwright test tests/chat.spec.ts', 'quality.verification'],
      ['npm run test:e2e:extended', 'quality.verification'],
      ['npm run verify:e2e:full', 'quality.verification'],
      [
        'node scripts/run-e2e-suite.mjs --bucket product',
        'quality.verification',
      ],
      // The coordinator behind verify:e2e:full, invoked directly.
      [
        'node scripts/run-verification.mjs request verify-e2e-full',
        'quality.verification',
      ],
    ])(
      '%s still routes to %s (real invocation, unaffected)',
      (command, claimType) => {
        expect(claimTypeFor(command)).toBe(claimType);
      },
    );

    test('node scripts/run-verification.mjs request verify-static does not route to quality.verification (wrong lane)', () => {
      expect(
        claimTypeFor('node scripts/run-verification.mjs request verify-static'),
      ).not.toBe('quality.verification');
    });
  });
});

/**
 * archive#1451: the same ReDoS discipline HIGH-1/NEW-1 already established
 * for the generic four patterns, re-run against the three gate-passing
 * patterns' final regexes. `route()`'s `.find()` scans the WHOLE
 * `claimPatterns` array in order for every call regardless of which gate is
 * open, so the existing round-2 ReDoS regression tests already exercised
 * `quality.static-checks` and `governance.merge-readiness` as array
 * entries 0 and 1 — these add adversarial shapes specific to what changed
 * here: the literal alternations in the static-checks/governance patterns
 * (replacing the old unbounded `\bveritas\b.*\breadiness\b`), and the new
 * `NODE_SCRIPT_ANCHOR` bounded gap.
 */
describe('DefaultCommandEvidenceRoutingPolicy — station#1451: ReDoS regression gate', () => {
  const policy = new DefaultCommandEvidenceRoutingPolicy();

  const GATE_DEFINITION = {
    id: 'test-flow',
    version: '1',
    steps: [{ id: 'ship', next: null }],
    gates: {
      'ship-gate': {
        step: 'ship',
        expects: [
          'quality.static-checks',
          'governance.merge-readiness',
          'quality.verification',
        ].map((claimType) => ({
          id: claimType,
          kind: 'trust.bundle',
          required: true,
          description: claimType,
          bundle_claim: { claimType, accepted_statuses: ['assumed'] },
        })),
      },
    },
  } as unknown as typeof DEFINITION;
  const OPEN = [{ id: 'ship-gate', step: 'ship' }];

  function routeFor(command: string) {
    return policy.route(cmd({ command }), {
      definition: GATE_DEFINITION,
      openGates: OPEN,
    });
  }

  test('route() on many "veritas"-without-"readiness" occurrences completes fast (the old unbounded .* is gone)', () => {
    // The pre-#1451 governance pattern was `\bveritas\b.*\breadiness\b` —
    // a free-floating `.*` between two literals is a latent quadratic-scan
    // risk on an input with many `veritas` occurrences and no `readiness`
    // anywhere. The replacement has no `.*` at all (two bounded literal
    // alternations), so this input never even reaches a backtracking
    // construct in that pattern.
    const start = performance.now();
    routeFor('veritas '.repeat(20000));
    expect(performance.now() - start).toBeLessThan(250);
  });

  test('route() on many chain-operator-separated near-miss static-check tokens completes fast', () => {
    const start = performance.now();
    routeFor('echo verify:staticx & echo ci:fastx & '.repeat(8000));
    expect(performance.now() - start).toBeLessThan(250);
  });

  test('route() on many newline-separated node-anchored non-matching lines completes fast', () => {
    // Stresses NODE_SCRIPT_ANCHOR's bounded NODE_SCRIPT_PATH_GAP across many
    // independent line-start anchor points (the `m`-flag anchor gives one
    // per newline): each line offers up to 120 characters of gap to
    // backtrack through before failing to find "run-e2e-suite" and moving
    // to the next line.
    const start = performance.now();
    routeFor(`node ${'x'.repeat(150)}\n`.repeat(8000));
    expect(performance.now() - start).toBeLessThan(250);
  });

  test('route() on a combined operator/veritas/node-noise string with no match completes fast', () => {
    const start = performance.now();
    routeFor('\n&;| veritas node x '.repeat(16000));
    expect(performance.now() - start).toBeLessThan(250);
  });

  test('a run-e2e-suite path longer than the bounded gap does not route (accepted narrower scope, not a bug)', () => {
    // 120 characters comfortably covers real paths (`scripts/run-e2e-suite.mjs`);
    // this pins the accepted tradeoff rather than silently drifting.
    expect(routeFor(`node ${'x'.repeat(130)}run-e2e-suite.mjs`)).toBeNull();
  });

  // FN-1 (archive#1451 review): SEP (`(?:--\s+)?`) is folded into the shared
  // ANCHOR_OPTIONAL/ANCHOR_REQUIRED, so it participates in every pattern
  // built from them, not just governance/static-checks. Reviewer-specified
  // adversarial shapes.
  test('route() on many "npm exec -- " repeats with no verb after completes fast', () => {
    const start = performance.now();
    routeFor(`npm exec -- x\n`.repeat(8000));
    expect(performance.now() - start).toBeLessThan(250);
  });

  test('route() on many bare "-- " repeats (no runner token at all) completes fast', () => {
    const start = performance.now();
    routeFor(`-- x\n`.repeat(8000));
    expect(performance.now() - start).toBeLessThan(250);
  });

  // FN-2 (archive#1451 review): the new RUN_VERIFICATION_REQUEST_ANCHOR
  // literal (`run-verification\.mjs` + `request`) composed against the
  // m-flag CHAIN_START anchor, across many independent line-start points —
  // the same shape as the NODE_SCRIPT_ANCHOR probe above, extended past the
  // two new fixed literals.
  test('route() on many newline-separated non-matching run-verification.mjs request lines completes fast', () => {
    const start = performance.now();
    routeFor(
      `node scripts/run-verification.mjs request ${'x'.repeat(150)}\n`.repeat(
        8000,
      ),
    );
    expect(performance.now() - start).toBeLessThan(250);
  });

  test('route() on many newline-separated run-verification.mjs lines with no "request" completes fast', () => {
    const start = performance.now();
    routeFor(
      `node scripts/run-verification.mjs ${'x'.repeat(150)}\n`.repeat(8000),
    );
    expect(performance.now() - start).toBeLessThan(250);
  });
});
