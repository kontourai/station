import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { npmInvocation } from '../lib/npm-cli.mjs';
import { persistVerificationOutput } from '../lib/verification-reporter.mjs';
import { FAST_STATIC_COMMANDS } from '../run-ci-fast.mjs';
import {
  classifyReadinessEvidence,
  resolveEvidenceCheckFailure,
} from '../veritas-readiness-evidence.mjs';

const wrapper = resolve('scripts/veritas-readiness-evidence.mjs');

/** The wrapper runs as a real child against a throwaway readiness fixture
 *  rather than Station's own Repo Map. Against the real repo every call
 *  re-executed the required evidence checks (governance, lint, the docs
 *  truth gate), so each test cost 80-120s and grew with the repository
 *  while proving nothing about Station's config: what these tests name is
 *  how the wrapper classifies the engine's result. ci:fast runs the Veritas
 *  engine directly (`veritas:readiness`) with Station's real Repo Map and
 *  evidence commands, not this wrapper; the wrapper itself meets the real
 *  config only in ci.yml's manual-completion-diagnostics "Veritas readiness
 *  evidence" step, which runs on workflow_dispatch. Each fixture run takes well under a second idle; the budget only
 *  absorbs a loaded host. */
const WRAPPER_TIMEOUT_MS = 30_000;

/** A child inherits GIT_DIR/GIT_INDEX_FILE from a hook; drop them so the
 *  fixture's own repository is the one git reads. */
function fixtureEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function nodeExit(code: number): string {
  return `${JSON.stringify(process.execPath)} -e "process.exit(${code})"`;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const REQUIRED_FAILURE_STANDARDS =
  '.veritas/repo-standards/required-failure.json';

/** The smallest repository `runMergeReadiness` accepts: a schema-valid Repo
 *  Map whose only evidence check is a required stub that exits 0 (so, as in
 *  Station's map, the engine runs a passing required check before the
 *  explicit `--evidence-check-command`), an empty claim store, authority
 *  settings, a rule-free default standards file, and a second standards
 *  file whose one `Require` rule names an artifact that does not exist. */
function buildReadinessFixture(root: string) {
  writeJson(join(root, '.veritas/repo-map.json'), {
    name: 'readiness-fixture',
    kind: 'repo-map',
    graph: {
      version: 1,
      defaultResolution: {
        phase: 'fixture',
        workstream: 'fixture',
        matchedArtifacts: [],
      },
      resolverPrecedence: ['fixture'],
      nodes: [
        {
          id: 'fixture.src',
          kind: 'product-area',
          label: 'src',
          patterns: ['src/'],
        },
      ],
    },
    evidence: {
      artifactDir: '.kontourai/veritas/evidence',
      reportTransport: 'github-step-summary',
      evidenceChecks: [
        {
          id: 'required-stub',
          // Distinct from nodeExit(0): the engine dedupes an explicit
          // command identical to a configured one.
          command: `${JSON.stringify(process.execPath)} -e "process.exitCode = 0"`,
          method: 'validation',
          summary: 'Required stub that always passes.',
        },
      ],
      requiredEvidenceCheckIds: ['required-stub'],
      defaultEvidenceCheckIds: ['required-stub'],
    },
  });
  writeJson(join(root, '.veritas/repo-standards/default.repo-standards.json'), {
    version: 1,
    name: 'readiness-fixture',
    rules: [],
  });
  writeJson(join(root, REQUIRED_FAILURE_STANDARDS), {
    version: 1,
    name: 'readiness-fixture-required-failure',
    rules: [
      {
        id: 'test-required-missing-artifact',
        kind: 'required-artifacts',
        enforcementLevel: 'Require',
        match: { artifacts: ['this-fixture-must-not-exist'] },
      },
    ],
  });
  writeJson(join(root, '.veritas/authority/default.authority-settings.json'), {
    version: 1,
    id: 'fixture',
    name: 'Fixture',
    defaults: { mode: 'observe', new_rule_stage: 'recommend' },
  });
  writeJson(join(root, 'veritas.claims.json'), {
    schemaVersion: 1,
    producer: 'veritas',
    claims: [],
    policies: [],
  });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/index.txt'), 'fixture\n');
  writeFileSync(join(root, '.gitignore'), '.kontourai/\n');
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, env: fixtureEnv(), stdio: 'pipe' });
  git(['init', '--quiet']);
  git(['config', 'user.email', 'station@example.test']);
  git(['config', 'user.name', 'Station']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'fixture']);
}

const makeTempDir = trackTempDirs({ lifetime: 'file' });
let fixtureRoot = '';
let runCount = 0;

function run(command: string, extraArgs: string[] = []) {
  runCount += 1;
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        wrapper,
        '--check',
        'evidence',
        '--working-tree',
        '--root',
        fixtureRoot,
        '--evidence-check-command',
        command,
        '--run-id',
        `test-${runCount}`,
        ...extraArgs,
      ],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: fixtureEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { exitCode: 0, payload: JSON.parse(stdout) };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string | Buffer };
    return {
      exitCode: failure.status,
      payload: JSON.parse(String(failure.stdout)),
    };
  }
}

describe('Station Veritas readiness evidence boundary', () => {
  beforeAll(() => {
    fixtureRoot = makeTempDir('station-readiness-fixture-');
    buildReadinessFixture(fixtureRoot);
  });

  test(
    'ci:fast retains nested readiness failures in its redacted output artifact',
    () => {
      const root = makeTempDir('station-readiness-diagnostic-');
      buildReadinessFixture(root);
      writeFileSync(
        join(root, 'nested-check.mjs'),
        "console.log('nested stdout cause'); console.error('nested stderr cause'); console.error('Authorization: Bearer fixture-readiness-secret'); process.exitCode = 1;\n",
      );
      const mapPath = join(root, '.veritas/repo-map.json');
      const map = JSON.parse(readFileSync(mapPath, 'utf8'));
      map.evidence.evidenceChecks[0].command = `${JSON.stringify(process.execPath)} nested-check.mjs`;
      writeJson(mapPath, map);
      const cli = resolve('node_modules/@kontourai/veritas/bin/veritas.mjs');
      writeJson(join(root, 'package.json'), {
        scripts: {
          'veritas:readiness': `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} readiness --working-tree`,
        },
      });
      const readiness = FAST_STATIC_COMMANDS.find(
        ([, args]) => args[1] === 'veritas:readiness',
      );
      expect(readiness).toBeDefined();
      const invocation = npmInvocation(readiness![1]);
      const result = spawnSyncBounded(invocation.command, invocation.args, {
        cwd: root,
        env: fixtureEnv(),
        encoding: 'utf8',
        timeout: WRAPPER_TIMEOUT_MS,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const persisted = persistVerificationOutput({
        root,
        requestKey: 'a'.repeat(64),
        stdout: result.stdout,
        stderr: result.stderr,
      });
      const retained = persisted.artifacts
        .map((artifact) => readFileSync(join(root, artifact.path), 'utf8'))
        .join('\n');
      expect(retained).toContain('nested stdout cause');
      expect(retained).toContain('nested stderr cause');
      expect(retained).toContain('nested-check.mjs');
      expect(retained).toMatch(/"exitCode":\s*1/);
      expect(retained).not.toContain('fixture-readiness-secret');
    },
    WRAPPER_TIMEOUT_MS,
  );

  test('keeps a required report failure red ahead of NOT_VERIFIED evidence', () => {
    expect(
      classifyReadinessEvidence({
        evidenceCheckFailure: { exitCode: 2 },
        record: {
          policy_results: [
            { passed: false, enforcementLevel: 'Require', status: 'fail' },
          ],
        },
      }),
    ).toEqual({ status: 'FAIL', exitCode: 1, reason: 'readiness-failed' });
  });

  test('derives the failure of a non-required check the engine only warns about', () => {
    // Veritas 1.6.0 records an explicit command's nonzero exit in the
    // per-check results without promoting it to evidenceCheckFailure.
    const explicit = {
      id: 'explicit-command-node-e-process-exit-2',
      runner: 'bash',
      label: 'node -e "process.exit(2)"',
      passed: false,
      exitCode: 2,
      signal: null,
    };
    const required = {
      id: 'repo-governance',
      runner: 'bash',
      label: 'npm run proof:repo-governance',
      passed: true,
      exitCode: 0,
      signal: null,
    };
    expect(
      resolveEvidenceCheckFailure({
        evidenceCheckFailure: null,
        evidenceCheckResults: [required, explicit],
      }),
    ).toEqual({
      phase: 'evidence-check',
      reason: 'failed',
      id: explicit.id,
      runner: 'bash',
      label: explicit.label,
      message: 'Evidence Check command exited with 2',
      exitCode: 2,
    });
    expect(
      resolveEvidenceCheckFailure({
        evidenceCheckFailure: null,
        evidenceCheckResults: [required],
      }),
    ).toBeNull();
    expect(
      resolveEvidenceCheckFailure({
        evidenceCheckFailure: null,
        evidenceCheckResults: [],
      }),
    ).toBeNull();
    expect(
      resolveEvidenceCheckFailure({
        evidenceCheckFailure: null,
        evidenceCheckResults: [
          { ...explicit, exitCode: null, signal: 'SIGKILL' },
        ],
      }),
    ).toEqual({
      phase: 'evidence-check',
      reason: 'failed',
      id: explicit.id,
      runner: 'bash',
      label: explicit.label,
      message: 'Evidence Check command exited with SIGKILL',
    });
  });

  test('keeps the engine-reported required failure ahead of a later explicit one', () => {
    const engineFailure = {
      phase: 'evidence-check',
      reason: 'failed',
      id: 'repo-governance',
      runner: 'bash',
      label: 'npm run proof:repo-governance',
      message: 'Evidence Check command exited with 1',
      exitCode: 1,
    };
    expect(
      resolveEvidenceCheckFailure({
        evidenceCheckFailure: engineFailure,
        evidenceCheckResults: [
          { id: 'repo-governance', passed: false, exitCode: 1 },
          { id: 'explicit', passed: false, exitCode: 2 },
        ],
      }),
    ).toBe(engineFailure);
  });

  test(
    'keeps a nested NOT_VERIFIED evidence check as JSON exit 2',
    () => {
      const result = run(nodeExit(2));
      expect(result.exitCode).toBe(2);
      expect(result.payload).toMatchObject({
        schemaVersion: 1,
        status: 'NOT_VERIFIED',
        exitCode: 2,
        reason: 'evidence-check-not-verified',
        // The nested command, not the passing required stub, is the failure.
        evidenceCheckFailure: {
          id: expect.stringMatching(/^explicit-command-/),
          exitCode: 2,
        },
      });
    },
    WRAPPER_TIMEOUT_MS,
  );

  test(
    'keeps a failed evidence check red',
    () => {
      const result = run(nodeExit(1));
      expect(result.exitCode).toBe(1);
      expect(result.payload).toMatchObject({
        status: 'FAIL',
        exitCode: 1,
        evidenceCheckFailure: { exitCode: 1 },
      });
    },
    WRAPPER_TIMEOUT_MS,
  );

  test(
    'reports a passing evidence check as JSON exit 0',
    () => {
      const result = run(nodeExit(0));
      expect(result.exitCode).toBe(0);
      expect(result.payload).toMatchObject({
        status: 'PASS',
        exitCode: 0,
        evidenceCheckFailure: null,
      });
      // Fixture fidelity: the engine selected the required check alongside
      // the explicit command, as it does for Station's own Repo Map.
      const report = JSON.parse(
        readFileSync(
          join(fixtureRoot, result.payload.reportArtifactPath),
          'utf8',
        ),
      );
      expect(report.selected_evidence_check_ids).toEqual(
        expect.arrayContaining(['required-stub']),
      );
      expect(report.selected_evidence_check_ids).toHaveLength(2);
    },
    WRAPPER_TIMEOUT_MS,
  );

  test(
    'keeps a real required report failure red ahead of nested exit 2',
    () => {
      const result = run(nodeExit(2), [
        '--repo-standards',
        REQUIRED_FAILURE_STANDARDS,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.payload).toMatchObject({
        status: 'FAIL',
        exitCode: 1,
        reason: 'readiness-failed',
        evidenceCheckFailure: { exitCode: 2 },
      });
    },
    WRAPPER_TIMEOUT_MS,
  );
});
