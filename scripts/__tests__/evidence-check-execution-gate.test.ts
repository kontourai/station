import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    'proof:repo-guardrails': pass,
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
