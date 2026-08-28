import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CODEQL_TOOL_NAME,
  evaluateCodeqlSarif,
  parseInputPath,
  parseSarifBytes,
  runCodeqlSarifPolicy,
  SARIF_SCHEMA_URLS,
  validateCodeqlSarif,
} from '../codeql-sarif-policy.mjs';

const fixture = (name: string) =>
  readFileSync(`scripts/__tests__/fixtures/codeql-sarif/${name}`, 'utf8');
const parseFixture = (name: string) => JSON.parse(fixture(name));
const readBytes = (value: string) =>
  (() => Buffer.from(value)) as unknown as typeof readFileSync;

describe('CodeQL SARIF policy', () => {
  test('accepts the pinned-action-compatible completed clean fixture', () => {
    const document = parseFixture('pinned-codeql-clean.sarif');
    expect(document.$schema).toBe(SARIF_SCHEMA_URLS[0]);
    expect(document.runs[0].tool.driver.name).toBe(CODEQL_TOOL_NAME);
    expect(evaluateCodeqlSarif(document)).toEqual({
      findings: [],
      summaries: [],
    });
    expect(
      runCodeqlSarifPolicy(
        ['--input=clean.sarif'],
        readBytes(fixture('pinned-codeql-clean.sarif')),
      ),
    ).toEqual({ input: 'clean.sarif', runs: 1 });
  });

  test('blocks a pinned-action-compatible finding using inherited rule severity and metadata', () => {
    const document = parseFixture('pinned-codeql-finding.sarif');
    expect(evaluateCodeqlSarif(document)).toEqual({
      findings: [],
      summaries: [
        'js/path-injection [error/8.1] Untrusted input reaches a filesystem path.',
      ],
    });
    expect(() =>
      runCodeqlSarifPolicy(
        ['--input=finding.sarif'],
        readBytes(fixture('pinned-codeql-finding.sarif')),
      ),
    ).toThrow('CodeQL SARIF policy blocked 1 result(s)');
  });

  test('treats the CodeQL 2.26.3 no-level result as SARIF-warning evidence, not malformed input', () => {
    const document = parseFixture('codeql-2.26.3-no-level.sarif');
    expect(document.runs[0].tool.driver.name).toBe(CODEQL_TOOL_NAME);
    expect(document.runs[0].tool.driver.semanticVersion).toBe('2.26.3');
    expect(document.runs[0].tool.driver.rules).toHaveLength(1);
    expect(document.runs[0].results[0]).not.toHaveProperty('level');
    expect(evaluateCodeqlSarif(document)).toEqual({
      findings: [],
      summaries: [
        'js/path-injection [warning/8.1] Untrusted input reaches a filesystem path.',
      ],
    });
    expect(() =>
      runCodeqlSarifPolicy(
        ['--input=codeql-2.26.3.sarif'],
        readBytes(fixture('codeql-2.26.3-no-level.sarif')),
      ),
    ).toThrow('CodeQL SARIF policy blocked 1 result(s)');
  });

  test('rejects an explicit SARIF none level because it does not clear a default failing result', () => {
    const document = parseFixture('codeql-2.26.3-no-level.sarif');
    document.runs[0].results[0].level = 'none';
    expect(evaluateCodeqlSarif(document)).toEqual({
      findings: [
        'runs[0].results[0]: must resolve severity level error, warning, or note.',
      ],
      summaries: [],
    });
    expect(() =>
      runCodeqlSarifPolicy(
        ['--input=none.sarif'],
        readBytes(`${JSON.stringify(document)}\n`),
      ),
    ).toThrow('CodeQL SARIF policy failed');
  });

  test('bounds the policy log summary when many findings are present', () => {
    const finding = parseFixture('pinned-codeql-finding.sarif');
    finding.runs[0].results = Array.from(
      { length: 21 },
      () => finding.runs[0].results[0],
    );
    expect(() =>
      runCodeqlSarifPolicy(
        ['--input=many.sarif'],
        readBytes(`${JSON.stringify(finding)}\n`),
      ),
    ).toThrow('… 1 additional result(s) omitted.');
  });

  test('fails the pinned-action-compatible analysis-error fixture', () => {
    expect(
      validateCodeqlSarif(
        parseFixture('pinned-codeql-analysis-error.sarif'),
      ).join('\n'),
    ).toContain('reports an analysis error');
  });

  test.each([
    [
      'unreviewed schema',
      {
        ...parseFixture('pinned-codeql-clean.sarif'),
        $schema: 'https://example.test/not-sarif.json',
      },
      'must equal one of',
    ],
    [
      'wrong tool',
      {
        ...parseFixture('pinned-codeql-clean.sarif'),
        runs: [
          {
            ...parseFixture('pinned-codeql-clean.sarif').runs[0],
            tool: { driver: { name: 'Other', rules: [{ id: 'x' }] } },
          },
        ],
      },
      'must identify tool.driver.name',
    ],
    [
      'synthetic empty run',
      {
        ...parseFixture('pinned-codeql-clean.sarif'),
        runs: [
          {
            tool: { driver: { name: CODEQL_TOOL_NAME, rules: [] } },
            results: [],
          },
        ],
      },
      'empty rules are synthetic or incomplete evidence',
    ],
    [
      'mismatched rule references',
      {
        ...parseFixture('pinned-codeql-finding.sarif'),
        runs: [
          {
            ...parseFixture('pinned-codeql-finding.sarif').runs[0],
            results: [
              {
                ruleId: 'js/not-in-rules',
                ruleIndex: 0,
                message: { text: 'mismatch' },
              },
            ],
          },
        ],
      },
      'unknown or ambiguous ruleId reference',
    ],
  ])('fails closed for %s', (_name, document, expected) => {
    expect(validateCodeqlSarif(document).join('\n')).toContain(expected);
  });

  test('rejects empty, malformed, and truncated bytes before semantic validation', () => {
    expect(() => parseSarifBytes(Buffer.alloc(0))).toThrow('empty');
    expect(() => parseSarifBytes(Buffer.from('{\n'))).toThrow(
      'malformed or truncated',
    );
    expect(() => parseSarifBytes(Buffer.from('{}'))).toThrow(
      'terminal newline',
    );
  });

  test('requires an explicit input and propagates a structural policy fault', () => {
    expect(() => parseInputPath([])).toThrow('Usage:');
    expect(() =>
      runCodeqlSarifPolicy(['--input=fixture.sarif'], readBytes('{}\n')),
    ).toThrow('CodeQL SARIF policy failed');
  });
});
