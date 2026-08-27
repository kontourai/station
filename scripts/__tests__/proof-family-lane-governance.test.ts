import { mkdtempSync, rmSync } from 'node:fs';
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

function expectSingleGenericBlock(ruleId: string, result: unknown) {
  const findings = findingsForRepoGovernanceResult(ruleId, result);
  expect(findings).toEqual([
    expect.objectContaining({
      id: ruleId,
      severity: 'block',
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
        expect(Object.keys(finding).sort()).toEqual(['artifact', 'kind']);
        expect(typeof finding.kind).toBe('string');
        expect(typeof finding.artifact).toBe('string');
      }

      const findings = expectSingleGenericBlock(ruleId, result);
      expect(findings).toEqual([
        {
          id: ruleId,
          message: 'Veritas reported a blocking governance policy failure.',
          severity: 'block',
        },
      ]);
    }
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

    expectSingleGenericBlock('required-station-governance-artifacts', {
      ...failure,
      findings: [],
    });
    expectSingleGenericBlock('required-station-governance-artifacts', {
      ...pass,
      findings: [{ kind: 'missing-artifact', artifact: 'AGENTS.md' }],
    });
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
    const accessor = { ...pass };
    Object.defineProperty(accessor, 'summary', {
      enumerable: true,
      get() {
        throw new Error('must not be read');
      },
    });
    const findingAccessor = {
      kind: 'missing-governance-file',
      artifact: 'AGENTS.md',
    };
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
    subclassedFindings.push({
      kind: 'missing-governance-file',
      artifact: 'AGENTS.md',
    });

    for (const result of [
      undefined,
      [],
      Object.assign(Object.create(null), pass),
      { ...pass, unexpected: 'unknown field' },
      accessor,
      {
        ...failure,
        findings: [{ kind: 'unexpected-kind', artifact: 'AGENTS.md' }],
      },
      {
        ...failure,
        findings: [{ kind: 'missing-governance-file', artifact: 7 }],
      },
      {
        ...failure,
        findings: [{ kind: 'missing-governance-file', artifact: '' }],
      },
      {
        ...failure,
        findings: [
          { kind: 'missing-governance-file', artifact: hostileToString },
        ],
      },
      { ...failure, findings: subclassedFindings },
      { ...failure, findings: [findingAccessor] },
      {
        ...failure,
        findings: [
          {
            kind: 'missing-governance-file',
            artifact: 'AGENTS.md',
            message: 'unexpected field',
          },
        ],
      },
    ]) {
      expectSingleGenericBlock('ai-instruction-files-synced', result);
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
