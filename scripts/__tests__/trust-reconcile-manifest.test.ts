import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
  'trust-reconcile-manifest': Array<{ id: string; command: string }>;
};

function trustBundle(command: string, summary = 'Station fast CI gate passed') {
  const timestamp = '2026-07-18T00:00:00Z';
  return {
    schemaVersion: 5,
    source: 'station-trust-reconcile-manifest-test',
    claims: [
      {
        id: 'station-ci-fast',
        claimType: 'workflow.check.test',
        value: 'pass',
        status: 'verified',
        subjectId: 'station/ci-fast',
        facet: 'flow-agents.workflow',
        subjectType: 'workflow-check',
        fieldOrBehavior: summary,
        createdAt: timestamp,
        updatedAt: timestamp,
        impactLevel: 'high',
        verificationPolicyId: 'policy:workflow.check.test:test_output',
      },
    ],
    evidence: [
      {
        id: 'ev-station-ci-fast',
        claimId: 'station-ci-fast',
        evidenceType: 'test_output',
        method: 'validation',
        sourceRef: 'station/command-log.jsonl',
        excerptOrSummary: summary,
        observedAt: timestamp,
        collectedBy: 'flow-agents/workflow-sidecar',
        passing: true,
        execution: {
          runner: 'bash',
          label: command,
          isError: false,
          exitCode: 0,
        },
      },
    ],
    events: [
      {
        id: 'evt-station-ci-fast',
        claimId: 'station-ci-fast',
        status: 'verified',
        actor: 'flow-agents/workflow-sidecar',
        method: 'validation',
        evidenceIds: ['ev-station-ci-fast'],
        createdAt: timestamp,
        verifiedAt: timestamp,
      },
    ],
    policies: [
      {
        id: 'policy:workflow.check.test:test_output',
        claimType: 'workflow.check.test',
        requiredEvidence: ['test_output'],
        acceptanceCriteria: [
          'A verified verification event must support a workflow.check.test claim.',
        ],
        reviewAuthority: 'system',
        validityRule: { kind: 'manual' },
        stalenessTriggers: [],
        conflictRules: [],
        impactLevel: 'high',
      },
    ],
  };
}

function runPreflight(command: string, summary?: string) {
  const artifactDir = mkdtempSync(
    join(tmpdir(), 'station-trust-reconcile-manifest-'),
  );
  try {
    writeFileSync(
      join(artifactDir, 'trust.bundle'),
      JSON.stringify(trustBundle(command, summary)),
    );
    return spawnSync(
      process.execPath,
      [
        'node_modules/@kontourai/flow-agents/build/src/cli/workflow-sidecar.js',
        'reconcile-preflight',
        artifactDir,
        '--repo-root',
        repoRoot,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

describe('Station trust-reconcile manifest', () => {
  it('keeps the package verify command, manifest, and required CI lane aligned', () => {
    expect(packageJson.scripts['trust-reconcile-verify']).toBe(
      'npm run full:regression',
    );
    expect(packageJson['trust-reconcile-manifest']).toEqual([
      { id: 'full-regression', command: 'npm run full:regression' },
    ]);

    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const completion = readFileSync(
      '.github/workflows/full-regression.yml',
      'utf8',
    );
    expect(ci).toContain('uses: ./.github/workflows/full-regression.yml');
    expect(ci).not.toContain('run: npm run full:regression');
    // #1459 moved the completion step to a block scalar so the gate can be
    // piped through `tee` (under `set -o pipefail`) for the verdict report.
    // The property this pin exists for is unchanged and is what it still
    // asserts: the manifest command is invoked exactly once in the completion
    // workflow, and nowhere in ci.yml.
    expect(completion.match(/npm run full:regression/g)).toHaveLength(1);
    expect(completion).toContain('workflow_call:');
    expect(ci).toContain('id: fast_ci');
  });

  it('accepts the canonical full-regression gate and rejects non-required command evidence', () => {
    const canonical = runPreflight(
      'npm run full:regression',
      'Canonical gate passed; focused diagnostic: npx vitest run scripts/__tests__/example-workspace-install.test.ts.',
    );
    expect(canonical.status, canonical.stderr).toBe(0);
    expect(canonical.stdout).toContain('[reconcile-preflight] OK');

    const advisory = runPreflight('npm run ci:extended');
    expect(advisory.status).toBe(1);
    expect(advisory.stderr).toContain('not in the reconcile manifest');
  });

  it('documents the Builder command-evidence boundary for agents and contributors', () => {
    for (const file of ['AGENTS.md', 'docs/guides/development.md']) {
      const guidance = readFileSync(file, 'utf8');
      expect(guidance).toContain('tests-evidence');
      expect(guidance).toContain('npm run full:regression');
      expect(guidance).toMatch(/focused test|Focused Vitest/i);
    }
  });
});
