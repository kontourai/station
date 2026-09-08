import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const gatePath = join(repoRoot, 'scripts/evidence-check-execution-gate.mjs');
const realRepoMap = JSON.parse(
  readFileSync(join(repoRoot, '.veritas/repo-map.json'), 'utf8'),
);
const realMapping = JSON.parse(
  readFileSync(join(repoRoot, 'scripts/evidence-check-execution.json'), 'utf8'),
);
const temporaryRoots: string[] = [];

// Mirrors the real corpus shape the gate reads: a Vitest file that names the
// advisory check's script and spawns a child process. The real test spawns a
// COPY of the script's source, so the gate's signal is file-level
// co-occurrence, and this fixture keeps that shape rather than an argv match
// the real corpus never produces.
const CORPUS_TEST_PATH =
  'scripts/__tests__/proof-repo-guardrails-fail-closed.test.ts';
const SPAWNING_CORPUS_TEST = [
  "import { spawnSync } from 'node:child_process';",
  "const scriptPath = join(repoRoot, 'scripts/proof-repo-guardrails.mjs');",
  'const copy = join(root, "proof-repo-guardrails.mjs");',
  'const result = spawnSync(process.execPath, [copy], { cwd: repoRoot });',
].join('\n');
// False-positive control: the same path, named and read, with no spawn form.
const MENTIONING_CORPUS_TEST = [
  '// Documents scripts/proof-repo-guardrails.mjs; this test never runs it.',
  "import { readFileSync } from 'node:fs';",
  "const source = readFileSync('scripts/proof-repo-guardrails.mjs', 'utf8');",
].join('\n');
const DEFAULT_CORPUS: Record<string, string> = {
  [CORPUS_TEST_PATH]: SPAWNING_CORPUS_TEST,
};
// The gate confirms the acknowledged executor is a classified child-process
// test, so the fixture carries the same declaration the real repository does.
const RESOURCE_MANIFEST_PATH = 'scripts/vitest-resource-manifest.mjs';
const CLASSIFYING_RESOURCE_MANIFEST = `export const PROCESS_HEAVY_VITEST_FILES = ['${CORPUS_TEST_PATH}'];\n`;
const EMPTY_RESOURCE_MANIFEST =
  'export const PROCESS_HEAVY_VITEST_FILES = [];\n';

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function baseScripts() {
  const pass = 'node -e "process.exit(0)"';
  const fail = 'node -e "process.exit(1)"';
  return {
    'full:regression:raw':
      'npm run proof:repo-governance && npm run proof:sdk-builds && npm run verify:static:raw && npm run proof:app-builds',
    'verify:static:raw': pass,
    'ci:fast': pass,
    'ci:fast:raw': pass,
    'test:prepush': pass,
    'test:prepush:raw': pass,
    verify: 'npm run verify:static',
    'verify:static': pass,
    'proof:repo-governance': pass,
    'verification:policy:gate': pass,
    'proof:repo-guardrails': 'node scripts/proof-repo-guardrails.mjs',
    'proof:architecture-boundaries': fail,
    'proof:ui-data-access': fail,
    'proof:runtime-contracts': fail,
    'proof:retired-surfaces': fail,
    'proof:migration-tombstones': fail,
    'test:connected-agents': pass,
    'proof:sdk-builds': pass,
    'proof:app-builds': pass,
    'veritas:fallow:advisory': pass,
  };
}

function createFixture(
  mutate: (fixture: {
    repoMap: typeof realRepoMap;
    mapping: typeof realMapping;
    packageJson: { scripts: ReturnType<typeof baseScripts> };
  }) => void,
  corpus: Record<string, string> = DEFAULT_CORPUS,
) {
  const root = mkdtempSync(join(tmpdir(), 'station-evidence-execution-'));
  temporaryRoots.push(root);
  const fixture = {
    repoMap: structuredClone(realRepoMap),
    mapping: structuredClone(realMapping),
    packageJson: { scripts: baseScripts() },
  };
  mutate(fixture);

  mkdirSync(join(root, '.veritas'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(root, '.veritas/repo-map.json'),
    JSON.stringify(fixture.repoMap),
  );
  writeFileSync(
    join(root, 'scripts/evidence-check-execution.json'),
    JSON.stringify(fixture.mapping),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(fixture.packageJson),
  );
  writeFileSync(
    join(root, '.github/workflows/evidence.yml'),
    [
      'name: Evidence',
      'jobs:',
      '  checks:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm run verification:policy:gate',
      '      - run: npm run test:connected-agents',
    ].join('\n'),
  );
  if (!Object.hasOwn(corpus, RESOURCE_MANIFEST_PATH))
    corpus = {
      ...corpus,
      [RESOURCE_MANIFEST_PATH]: CLASSIFYING_RESOURCE_MANIFEST,
    };
  for (const [path, contents] of Object.entries(corpus)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

function runGate(root?: string) {
  const result = spawnSync(
    process.execPath,
    root ? [gatePath, '--repo-root', root] : [gatePath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('evidence-check execution gate', () => {
  test('positive control: the real repository passes', () => {
    const { status, output } = runGate();

    expect(output).toContain('Evidence-check execution gate passed.');
    expect(status).toBe(0);
  });

  test('a repo-map id missing from the execution mapping fails by name', () => {
    const root = createFixture(({ mapping }) => {
      delete mapping['architecture-boundaries'];
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      'execution mapping is missing repo-map evidence-check id "architecture-boundaries"',
    );
    expect(status).toBe(1);
  });

  test('an execution-mapping id missing from the repo-map fails by name', () => {
    const root = createFixture(({ mapping }) => {
      mapping['not-a-real-check'] = 'advisory';
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      'execution mapping has unknown evidence-check id "not-a-real-check"',
    );
    expect(status).toBe(1);
  });

  test('an enforced check unreachable from every lane root fails', () => {
    const root = createFixture(({ mapping }) => {
      mapping['fallow-advisory'] = 'enforced';
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      'evidence check "fallow-advisory" is enforced but "npm run veritas:fallow:advisory" is unreachable',
    );
    expect(status).toBe(1);
  });

  test('a candidate check reachable from a lane root fails', () => {
    const root = createFixture(({ packageJson }) => {
      packageJson.scripts['verify:static:raw'] +=
        ' && npm run proof:architecture-boundaries';
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      'evidence check "architecture-boundaries" is candidate but "npm run proof:architecture-boundaries" is reachable',
    );
    expect(status).toBe(1);
  });

  test('a candidate check whose command exits zero fails', () => {
    const root = createFixture(({ packageJson }) => {
      packageJson.scripts['proof:architecture-boundaries'] =
        'node -e "process.exit(0)"';
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      'evidence check "architecture-boundaries" is candidate but "npm run proof:architecture-boundaries" exited 0',
    );
    expect(status).toBe(1);
  });

  test('an unacknowledged advisory check the corpus runs fails by test file', () => {
    const root = createFixture(({ mapping }) => {
      delete mapping._corpusExecution;
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      'evidence check "repo-guardrails" is advisory but the Vitest corpus reaches it',
    );
    expect(output).toContain(
      `${CORPUS_TEST_PATH} names scripts/proof-repo-guardrails.mjs and spawns a child process`,
    );
    expect(status).toBe(1);
  });

  test('a corpus file that names the script without a spawn form is not counted', () => {
    const root = createFixture(
      ({ mapping }) => {
        delete mapping._corpusExecution;
      },
      { [CORPUS_TEST_PATH]: MENTIONING_CORPUS_TEST },
    );

    const { status, output } = runGate(root);
    expect(output).toContain('Evidence-check execution gate passed.');
    expect(output).not.toContain('repo-guardrails');
    expect(status).toBe(0);
  });

  test('deleting the named executor fails even while other files co-name the script', () => {
    // The decisive case: a second file still names the script and spawns, so
    // the co-occurrence scan alone would stay satisfied.
    const root = createFixture(() => {}, {
      'scripts/__tests__/unrelated-spawner.test.ts': SPAWNING_CORPUS_TEST,
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      `evidence check "repo-guardrails" names ${CORPUS_TEST_PATH} as its corpus executor, but that file does not exist`,
    );
    expect(status).toBe(1);
  });

  test('an acknowledgement pointing at a file that does not spawn fails', () => {
    const root = createFixture(() => {}, {
      [CORPUS_TEST_PATH]: MENTIONING_CORPUS_TEST,
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      `evidence check "repo-guardrails" names ${CORPUS_TEST_PATH} as its corpus executor, but that file does not name a script "npm run proof:repo-guardrails" runs while spawning a child process`,
    );
    expect(status).toBe(1);
  });

  test('an executor the resource manifest does not classify fails', () => {
    const root = createFixture(() => {}, {
      [CORPUS_TEST_PATH]: SPAWNING_CORPUS_TEST,
      [RESOURCE_MANIFEST_PATH]: EMPTY_RESOURCE_MANIFEST,
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      `evidence check "repo-guardrails" names ${CORPUS_TEST_PATH} as its corpus executor, but ${RESOURCE_MANIFEST_PATH} does not classify it as a child-process test`,
    );
    expect(status).toBe(1);
  });

  test('an acknowledgement on a non-advisory classification fails', () => {
    const root = createFixture(({ mapping, packageJson }) => {
      mapping['repo-guardrails'] = 'enforced';
      packageJson.scripts['verify:static:raw'] +=
        ' && npm run proof:repo-guardrails';
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      'evidence check "repo-guardrails" is enforced but _corpusExecution acknowledges it',
    );
    expect(status).toBe(1);
  });

  test('an unknown _corpusExecution id fails by name', () => {
    const root = createFixture(({ mapping }) => {
      mapping._corpusExecution = { 'not-a-check': 'acknowledged' };
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      'execution mapping _corpusExecution has unknown evidence-check id "not-a-check"',
    );
    expect(status).toBe(1);
  });

  test('a _corpusExecution value that is not a test file path fails', () => {
    const root = createFixture(({ mapping }) => {
      mapping._corpusExecution = { 'repo-guardrails': 'acknowledged' };
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      'execution mapping _corpusExecution."repo-guardrails" must name the repository-relative test file that runs the check, not "acknowledged"',
    );
    expect(status).toBe(1);
  });

  test('the _note never states a violation count the baseline does not have', () => {
    // The note is unchecked prose as far as the gate is concerned — it
    // validates only that `_note` is a non-empty string. It said
    // repo-guardrails "currently passes with 104 baselined violations" for as
    // long as it took station#2765 to burn the baseline down to zero and
    // nobody to notice, which is a label nothing derived: the number was
    // right when written and wrong ever after.
    //
    // So the count is reconciled against the list. Both directions matter —
    // a stated count that disagrees with the baseline is stale, and a claim
    // of tolerated violations while the baseline is empty is the exact
    // regression that happened.
    const note = realMapping._note as string;
    const baselined = (
      JSON.parse(
        readFileSync(
          join(repoRoot, 'scripts/proof-repo-guardrails-baseline.json'),
          'utf8',
        ),
      ).knownViolations as string[]
    ).length;

    for (const [, count] of note.matchAll(/(\d+)\s+baselined violation/gi)) {
      expect(
        Number(count),
        `_note states ${count} baselined violation(s); the baseline holds ${baselined}`,
      ).toBe(baselined);
    }
    if (baselined === 0) {
      expect(
        note,
        '_note claims a tolerated violation set while the baseline is empty',
      ).not.toMatch(/passes with \d*[1-9]\d* baselined violation/i);
    }
  });

  test('an advisory check reachable from a lane root fails', () => {
    const root = createFixture(({ packageJson }) => {
      packageJson.scripts['verify:static:raw'] +=
        ' && npm run veritas:fallow:advisory';
    });

    const { status, output } = runGate(root);
    expect(output).toContain(
      'evidence check "fallow-advisory" is advisory but "npm run veritas:fallow:advisory" is reachable',
    );
    expect(status).toBe(1);
  });
});
