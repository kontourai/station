import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findingsForRepoGovernanceResult,
  proofFamilyExitCode,
} from '../proof-family-lane.mjs';

const rootDir = resolve(import.meta.dirname, '../..');
const resultKeys = [
  'classification',
  'enforcement',
  'enforcementLevel',
  'findings',
  'implemented',
  'message',
  'owner',
  'passed',
  'rollback_switch',
  'rule_id',
  'status',
  'summary',
];
// Veritas 1.6.0 added `diagnostic` and `remediation` to governance-block
// findings; required-artifacts findings kept the two-key shape.
const findingKeysByRule: Record<string, string[]> = {
  'required-station-governance-artifacts': ['artifact', 'kind'],
  'ai-instruction-files-synced': [
    'artifact',
    'diagnostic',
    'kind',
    'remediation',
  ],
};
const INVALID_RESULT_MESSAGE =
  'Veritas returned an invalid governance policy result.';
const POLICY_FAILURE_MESSAGE =
  'Veritas reported a blocking governance policy failure.';
const temporaryDirs = new Set<string>();

function temporaryRoot(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirs.clear();
});

async function evaluatedResult(ruleId: string, evaluationRoot = rootDir) {
  const veritasModule = '@kontourai/veritas';
  const { evaluateRepoStandards, loadRepoStandards } = await import(
    veritasModule
  );
  const standards = loadRepoStandards(
    resolve(rootDir, '.veritas/repo-standards/default.repo-standards.json'),
  );
  const [result] = evaluateRepoStandards(
    standards,
    { rootDir: evaluationRoot },
    { ruleIds: [ruleId] },
  );
  return result;
}

async function unimplementedResult(ruleId: string) {
  const veritasModule = '@kontourai/veritas';
  const { evaluateRepoStandards, loadRepoStandards } = await import(
    veritasModule
  );
  const standards = loadRepoStandards(
    resolve(rootDir, '.veritas/repo-standards/default.repo-standards.json'),
  );
  const rule = standards.rules.find(
    (candidate: { id: string }) => candidate.id === ruleId,
  );
  if (!rule) throw new Error('Configured governance rule was not found.');
  rule.kind = 'unknown-kind';
  const [result] = evaluateRepoStandards(
    standards,
    { rootDir },
    { ruleIds: [ruleId] },
  );
  return result;
}

function expectSingleGenericBlock(
  ruleId: string,
  result: unknown,
  message?: string,
) {
  const findings = findingsForRepoGovernanceResult(ruleId, result);
  expect(findings).toEqual([
    expect.objectContaining({
      id: ruleId,
      severity: 'block',
      ...(message === undefined ? {} : { message }),
    }),
  ]);
  expect(
    proofFamilyExitCode([
      {
        status: findings.some((finding) => finding.severity === 'block')
          ? 'fail'
          : 'pass',
      },
    ]),
  ).toBe(1);
  return findings;
}

describe('repo-governance Veritas result boundary', () => {
  it('accepts the exact current Require and Guide pass-result contract', async () => {
    for (const ruleId of [
      'required-station-governance-artifacts',
      'ai-instruction-files-synced',
      'brownfield-gap-log-present',
    ]) {
      const result = await evaluatedResult(ruleId);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(Object.keys(result).sort()).toEqual(resultKeys);
      expect(result).not.toHaveProperty('stage');
      expect(result).toMatchObject({
        rule_id: ruleId,
        implemented: true,
        passed: true,
        findings: [],
        status: 'info',
      });
      expect(findingsForRepoGovernanceResult(ruleId, result)).toEqual([]);
    }
  });

  it('keeps valid Require and Guide failures blocking without copying their raw data', async () => {
    const failedRoot = temporaryRoot('station-veritas-result-');
    for (const ruleId of [
      'required-station-governance-artifacts',
      'ai-instruction-files-synced',
    ]) {
      const result = await evaluatedResult(ruleId, failedRoot);
      expect(result).toMatchObject({
        rule_id: ruleId,
        implemented: true,
        passed: false,
        status: 'info',
      });
      expect(result.findings).not.toEqual([]);
      for (const finding of result.findings) {
        expect(Object.keys(finding).sort()).toEqual(findingKeysByRule[ruleId]);
        expect(typeof finding.kind).toBe('string');
        expect(typeof finding.artifact).toBe('string');
        if (ruleId === 'ai-instruction-files-synced') {
          expect(typeof finding.diagnostic).toBe('string');
          expect(typeof finding.remediation).toBe('string');
          expect(finding.remediation).not.toBe('');
        }
      }

      const findings = expectSingleGenericBlock(ruleId, result);
      expect(findings).toEqual([
        {
          id: ruleId,
          message: POLICY_FAILURE_MESSAGE,
          severity: 'block',
        },
      ]);
    }

    // Instruction files that exist but are not canonical reach the boundary
    // through the other two governance-block kinds and their diagnostics.
    const staleRoot = temporaryRoot('station-veritas-stale-');
    writeFileSync(join(staleRoot, 'AGENTS.md'), '# No governance markers\n');
    writeFileSync(
      join(staleRoot, 'CLAUDE.md'),
      [
        '<!-- veritas:governance-block:start -->',
        'Not the canonical block.',
        '<!-- veritas:governance-block:end -->',
        '',
      ].join('\n'),
    );
    const stale = await evaluatedResult(
      'ai-instruction-files-synced',
      staleRoot,
    );
    expect(stale).toMatchObject({ implemented: true, passed: false });
    expect(
      stale.findings.map(
        (finding: { artifact: string; kind: string; diagnostic: string }) => ({
          artifact: finding.artifact,
          kind: finding.kind,
          diagnostic: finding.diagnostic,
        }),
      ),
    ).toEqual([
      {
        artifact: 'AGENTS.md',
        kind: 'missing-governance-block',
        diagnostic: 'missing-governance-markers',
      },
      {
        artifact: 'CLAUDE.md',
        kind: 'stale-governance-block',
        diagnostic: 'stale-governance-content',
      },
    ]);
    for (const finding of stale.findings) {
      expect(Object.keys(finding).sort()).toEqual(
        findingKeysByRule['ai-instruction-files-synced'],
      );
    }
    expect(
      expectSingleGenericBlock(
        'ai-instruction-files-synced',
        stale,
        POLICY_FAILURE_MESSAGE,
      ),
    ).toEqual([
      {
        id: 'ai-instruction-files-synced',
        message: POLICY_FAILURE_MESSAGE,
        severity: 'block',
      },
    ]);
  });

  it('does not let an invented stage downgrade a reported failure', async () => {
    const failedRoot = temporaryRoot('station-veritas-stage-');
    const result = await evaluatedResult(
      'ai-instruction-files-synced',
      failedRoot,
    );
    expectSingleGenericBlock('ai-instruction-files-synced', {
      ...result,
      stage: 'warn',
    });
  });

  it('fails closed for contradictions and empty failure evidence', async () => {
    const pass = await evaluatedResult('required-station-governance-artifacts');
    const failedRoot = temporaryRoot('station-veritas-empty-');
    const failure = await evaluatedResult(
      'required-station-governance-artifacts',
      failedRoot,
    );

    expectSingleGenericBlock(
      'required-station-governance-artifacts',
      { ...failure, findings: [] },
      INVALID_RESULT_MESSAGE,
    );
    expectSingleGenericBlock(
      'required-station-governance-artifacts',
      {
        ...pass,
        findings: [{ kind: 'missing-artifact', artifact: 'AGENTS.md' }],
      },
      INVALID_RESULT_MESSAGE,
    );
  });

  it('accepts the exact installed unimplemented-result variant but keeps required governance red', async () => {
    const ruleId = 'required-station-governance-artifacts';
    const result = await unimplementedResult(ruleId);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.keys(result).sort()).toEqual(
      [...resultKeys, 'reason'].sort(),
    );
    expect(result).toMatchObject({
      rule_id: ruleId,
      implemented: false,
      passed: null,
      status: 'error',
      reason: 'unknown rule kind',
      findings: [
        {
          kind: 'unknown-rule-kind',
          artifact: ruleId,
          rule_kind: 'unknown-kind',
        },
      ],
    });
    const findings = expectSingleGenericBlock(ruleId, result);
    expect(findings).toEqual([
      {
        id: ruleId,
        message:
          'Veritas did not complete a configured governance policy evaluation.',
        severity: 'block',
      },
    ]);
  });

  it('fails closed and redacts malformed or hostile unimplemented results', async () => {
    const ruleId = 'required-station-governance-artifacts';
    const result = await unimplementedResult(ruleId);
    const secret = 'https://token:do-not-leak@example.test/unimplemented';
    const reasonAccessor = { ...result };
    Object.defineProperty(reasonAccessor, 'reason', {
      enumerable: true,
      get() {
        throw new Error('must not be read');
      },
    });

    for (const malformed of [
      { ...result, reason: 'different reason' },
      { ...result, status: 'info' },
      { ...result, passed: false },
      { ...result, unexpected: 'unknown field' },
      reasonAccessor,
      {
        ...result,
        findings: [
          {
            kind: 'unknown-rule-kind',
            artifact: ruleId,
          },
        ],
      },
      {
        ...result,
        findings: [
          {
            kind: 'unknown-rule-kind',
            artifact: secret,
            rule_kind: secret,
          },
        ],
      },
    ]) {
      const findings = expectSingleGenericBlock(ruleId, malformed);
      expect(JSON.stringify(findings)).not.toContain(secret);
    }
  });

  it('fails closed for unknown fields, non-plain values, accessors, and malformed findings', async () => {
    const pass = await evaluatedResult('ai-instruction-files-synced');
    const failedRoot = temporaryRoot('station-veritas-hostile-');
    const failure = await evaluatedResult(
      'ai-instruction-files-synced',
      failedRoot,
    );
    // Every hostile finding below is one mutation away from the installed
    // Veritas shape, so each is rejected for the reason its case names rather
    // than for an unrelated key-count mismatch.
    const [realFinding] = failure.findings;
    const accessor = { ...pass };
    Object.defineProperty(accessor, 'summary', {
      enumerable: true,
      get() {
        throw new Error('must not be read');
      },
    });
    const findingAccessor = { ...realFinding };
    Object.defineProperty(findingAccessor, 'artifact', {
      enumerable: true,
      get() {
        throw new Error('must not be read');
      },
    });
    const hostileToString = {
      toString() {
        throw new Error('must not be called');
      },
    };
    const subclassedFindings = new (class extends Array {})();
    subclassedFindings.push({ ...realFinding });

    // Positive control: the unmutated installed shape is a policy failure.
    expectSingleGenericBlock(
      'ai-instruction-files-synced',
      { ...failure, findings: [{ ...realFinding }] },
      POLICY_FAILURE_MESSAGE,
    );

    for (const result of [
      undefined,
      [],
      Object.assign(Object.create(null), pass),
      { ...pass, unexpected: 'unknown field' },
      accessor,
      { ...failure, findings: [{ ...realFinding, kind: 'unexpected-kind' }] },
      { ...failure, findings: [{ ...realFinding, artifact: 7 }] },
      { ...failure, findings: [{ ...realFinding, artifact: '' }] },
      {
        ...failure,
        findings: [{ ...realFinding, artifact: hostileToString }],
      },
      {
        ...failure,
        findings: [{ ...realFinding, diagnostic: 'unexpected-diagnostic' }],
      },
      { ...failure, findings: [{ ...realFinding, remediation: '' }] },
      { ...failure, findings: [{ ...realFinding, remediation: 7 }] },
      // The pre-1.6.0 two-key shape is no longer the installed contract.
      {
        ...failure,
        findings: [{ kind: realFinding.kind, artifact: realFinding.artifact }],
      },
      { ...failure, findings: subclassedFindings },
      { ...failure, findings: [findingAccessor] },
      {
        ...failure,
        findings: [{ ...realFinding, message: 'unexpected field' }],
      },
    ]) {
      expectSingleGenericBlock(
        'ai-instruction-files-synced',
        result,
        INVALID_RESULT_MESSAGE,
      );
    }
  });

  it('keeps hostile values out of returned findings and serialized evidence or output text', async () => {
    const secret = 'https://token:do-not-leak@example.test/private';
    const failedRoot = temporaryRoot('station-veritas-redact-');
    const failure = await evaluatedResult(
      'required-station-governance-artifacts',
      failedRoot,
    );
    const findings = expectSingleGenericBlock(
      'required-station-governance-artifacts',
      {
        ...failure,
        findings: [{ kind: 'missing-artifact', artifact: secret }],
      },
    );
    const serializedSidecar = JSON.stringify({ findings });
    const renderedError = findings
      .map((finding) => `- ${finding.id}: ${finding.message}`)
      .join('\n');

    expect(serializedSidecar).not.toContain(secret);
    expect(renderedError).not.toContain(secret);
    expect(findings[0]).not.toHaveProperty('artifact');
    expect(findings[0]).not.toHaveProperty('kind');

    // A valid governance-block finding's 1.6.0 remediation text is raw
    // Veritas data too: it must not reach the lane's findings either.
    const governanceFailure = await evaluatedResult(
      'ai-instruction-files-synced',
      failedRoot,
    );
    const [governanceFinding] = governanceFailure.findings;
    const governanceFindings = expectSingleGenericBlock(
      'ai-instruction-files-synced',
      {
        ...governanceFailure,
        findings: [
          {
            ...governanceFinding,
            artifact: secret,
            remediation: `${governanceFinding.remediation} ${secret}`,
          },
        ],
      },
      POLICY_FAILURE_MESSAGE,
    );
    expect(JSON.stringify(governanceFindings)).not.toContain(secret);
    expect(governanceFindings[0]).not.toHaveProperty('remediation');
    expect(governanceFindings[0]).not.toHaveProperty('diagnostic');

    const unknownRuleFindings = findingsForRepoGovernanceResult(
      secret,
      failure,
    );
    expect(unknownRuleFindings).toEqual([
      {
        id: 'repo-governance-invalid-veritas-result',
        message: 'Veritas returned an invalid governance policy result.',
        severity: 'block',
      },
    ]);
    expect(JSON.stringify(unknownRuleFindings)).not.toContain(secret);
  });

  it('preserves outer pass and NOT_VERIFIED exits when their families have no blocking findings', () => {
    expect(proofFamilyExitCode([{ status: 'pass' }])).toBe(0);
    expect(proofFamilyExitCode([{ status: 'NOT_VERIFIED' }])).toBe(2);
  });
});
