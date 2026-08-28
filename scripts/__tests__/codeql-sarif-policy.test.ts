import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CODEQL_TOOL_NAMES,
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
const errorBaseline = () =>
  JSON.parse(readFileSync('scripts/codeql-error-baseline.json', 'utf8'));
const readFiles = (files: Record<string, string>) =>
  ((path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`unexpected read: ${path}`);
    return Buffer.from(content);
  }) as unknown as typeof readFileSync;
const readBytes = (value: string) => readFiles({ 'input.sarif': value });

/** The real capture's error-level result, present in the checked-in baseline. */
const BASELINED_ERROR_SUMMARY_PREFIX =
  'js/request-forgery [error/9.1] src-server/services/discord/discord-gateway-service.ts';

describe('CodeQL SARIF policy', () => {
  test('accepts the real-capture-shaped clean fixture (empty driver rules, extension packs)', () => {
    const document = parseFixture('pinned-codeql-clean.sarif');
    expect(SARIF_SCHEMA_URLS).toContain(document.$schema);
    expect(CODEQL_TOOL_NAMES).toContain(document.runs[0].tool.driver.name);
    expect(document.runs[0].tool.driver.rules).toEqual([]);
    expect(evaluateCodeqlSarif(document)).toEqual({
      findings: [],
      blocked: [],
      baselined: [],
      advisories: [],
    });
    expect(
      runCodeqlSarifPolicy(
        ['--input=input.sarif'],
        readBytes(fixture('pinned-codeql-clean.sarif')),
      ),
    ).toEqual({
      input: 'input.sarif',
      runs: 1,
      baselined: [],
      advisories: [],
    });
  });

  test('resolves extension-pack rules via rule.toolComponent and splits error from advisory', () => {
    const document = parseFixture('pinned-codeql-finding.sarif');
    const verdict = evaluateCodeqlSarif(document);
    expect(verdict.findings).toEqual([]);
    expect(verdict.blocked).toHaveLength(1);
    expect(verdict.blocked[0]).toContain(BASELINED_ERROR_SUMMARY_PREFIX);
    expect(verdict.advisories).toHaveLength(1);
    expect(verdict.advisories[0]).toContain(
      'js/insecure-temporary-file [warning/7.0]',
    );
    expect(() =>
      runCodeqlSarifPolicy(
        ['--input=input.sarif'],
        readBytes(fixture('pinned-codeql-finding.sarif')),
      ),
    ).toThrow('CodeQL SARIF policy blocked 1 error-level result(s)');
  });

  test('the checked-in baseline grandfathers the real error result and only that result', () => {
    const document = parseFixture('pinned-codeql-finding.sarif');
    // The finding fixture carries one error result matching a baseline entry;
    // the remaining checked-in entries would be stale against this document,
    // so pass only the matching entry — mirroring how a shrunken tree behaves.
    const entry = errorBaseline().findings.find(
      (candidate: { rule: string }) => candidate.rule === 'js/request-forgery',
    );
    expect(entry).toBeDefined();
    const verdict = evaluateCodeqlSarif(document, {
      baseline: { findings: [entry] },
    });
    expect(verdict.findings).toEqual([]);
    expect(verdict.blocked).toEqual([]);
    expect(verdict.baselined).toHaveLength(1);
    expect(verdict.baselined[0]).toContain(BASELINED_ERROR_SUMMARY_PREFIX);
    const result = runCodeqlSarifPolicy(
      ['--input=input.sarif', '--baseline=baseline.json'],
      readFiles({
        'input.sarif': fixture('pinned-codeql-finding.sarif'),
        'baseline.json': JSON.stringify({ findings: [entry] }),
      }),
    );
    expect(result.baselined).toHaveLength(1);
    expect(result.advisories).toHaveLength(1);
  });

  test('a baseline entry matching no error-level result is stale and fails the policy', () => {
    const document = parseFixture('pinned-codeql-clean.sarif');
    const verdict = evaluateCodeqlSarif(document, {
      baseline: {
        findings: [
          { rule: 'js/gone', path: 'src/removed.ts', lineHash: 'dead:1' },
        ],
      },
    });
    expect(verdict.findings.join('\n')).toContain(
      'no longer matches any error-level result; remove it',
    );
  });

  test('a baseline entry does not grandfather a moved or edited finding (fingerprint mismatch)', () => {
    const document = parseFixture('pinned-codeql-finding.sarif');
    const entry = errorBaseline().findings.find(
      (candidate: { rule: string }) => candidate.rule === 'js/request-forgery',
    );
    const verdict = evaluateCodeqlSarif(document, {
      baseline: {
        findings: [{ ...entry, lineHash: 'ffffffffffffffff:1' }],
      },
    });
    expect(verdict.blocked).toHaveLength(1);
    expect(verdict.findings.join('\n')).toContain('no longer matches');
  });

  test('rejects a malformed baseline instead of silently enforcing without it', () => {
    const document = parseFixture('pinned-codeql-clean.sarif');
    expect(
      validateCodeqlSarif(document, { baseline: { findings: 'nope' } }).join(
        '\n',
      ),
    ).toContain('baseline.findings: must be an array');
    expect(
      validateCodeqlSarif(document, {
        baseline: { findings: [{ rule: 'js/x' }] },
      }).join('\n'),
    ).toContain('must contain nonblank rule, path, and lineHash');
    expect(() =>
      runCodeqlSarifPolicy(
        ['--input=input.sarif', '--baseline=baseline.json'],
        readFiles({
          'input.sarif': fixture('pinned-codeql-clean.sarif'),
          'baseline.json': 'not json',
        }),
      ),
    ).toThrow('CodeQL error baseline is unreadable');
  });

  test('still resolves the legacy driver-rules shape and long tool name', () => {
    const document = parseFixture('pinned-codeql-legacy-driver-rules.sarif');
    expect(document.runs[0].tool.driver.name).toBe(
      'CodeQL command-line toolchain',
    );
    const verdict = evaluateCodeqlSarif(document);
    expect(verdict.findings).toEqual([]);
    expect(verdict.blocked).toHaveLength(1);
    expect(verdict.blocked[0]).toContain('js/path-injection [error/8.1]');
  });

  test('defaults an omitted SARIF level to warning but rejects explicit none', () => {
    const document = parseFixture('codeql-2.26.3-no-level.sarif');
    const omitted = evaluateCodeqlSarif(document);
    expect(omitted.findings).toEqual([]);
    expect(omitted.blocked).toEqual([]);
    expect(omitted.advisories).toEqual([
      'js/path-injection [warning/8.1] Untrusted input reaches a filesystem path.',
    ]);

    document.runs[0].results[0].level = 'none';
    expect(validateCodeqlSarif(document)).toContain(
      'runs[0].results[0]: must resolve severity level error, warning, or note.',
    );
  });

  test('resolves a uniquely named SARIF tool component and rejects inconsistent references', () => {
    const named = parseFixture('pinned-codeql-finding.sarif');
    named.runs[0].results = [
      {
        ...named.runs[0].results[0],
        rule: {
          ...named.runs[0].results[0].rule,
          toolComponent: { name: 'codeql/javascript-queries' },
        },
      },
    ];
    expect(evaluateCodeqlSarif(named).findings).toEqual([]);

    const mismatch = parseFixture('pinned-codeql-finding.sarif');
    mismatch.runs[0].results = [
      {
        ...mismatch.runs[0].results[0],
        ruleId: 'js/insecure-temporary-file',
      },
    ];
    expect(validateCodeqlSarif(mismatch)).toContain(
      'runs[0].results[0]: rule.id and ruleId disagree.',
    );

    const componentMismatch = parseFixture('pinned-codeql-finding.sarif');
    componentMismatch.runs[0].results = [
      {
        ...componentMismatch.runs[0].results[0],
        rule: {
          ...componentMismatch.runs[0].results[0].rule,
          toolComponent: {
            index: 0,
            name: 'codeql/javascript-all',
          },
        },
      },
    ];
    expect(validateCodeqlSarif(componentMismatch)).toContain(
      'runs[0].results[0]: has an unknown or ambiguous rule.toolComponent reference.',
    );

    const malformedExtensions = parseFixture('pinned-codeql-clean.sarif');
    malformedExtensions.runs[0].tool.extensions = { bad: true };
    expect(validateCodeqlSarif(malformedExtensions)).toContain(
      'runs[0]: tool.extensions must be an array when present.',
    );
  });

  test('bounds the blocked-result log when many findings are present', () => {
    const finding = parseFixture('pinned-codeql-finding.sarif');
    finding.runs[0].results = Array.from(
      { length: 21 },
      () => finding.runs[0].results[0],
    );
    expect(() =>
      runCodeqlSarifPolicy(
        ['--input=input.sarif'],
        readBytes(`${JSON.stringify(finding)}\n`),
      ),
    ).toThrow('… 1 additional result(s) omitted.');
  });

  test('fails the analysis-error fixture on its failed invocation', () => {
    expect(
      validateCodeqlSarif(
        parseFixture('pinned-codeql-analysis-error.sarif'),
      ).join('\n'),
    ).toContain('must declare executionSuccessful: true');
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
      'rule-free synthetic run',
      {
        ...parseFixture('pinned-codeql-clean.sarif'),
        runs: [
          {
            tool: {
              driver: { name: 'CodeQL', rules: [] },
              extensions: [{ name: 'codeql/javascript-queries', rules: [] }],
            },
            results: [],
          },
        ],
      },
      'a rule-free run is synthetic or incomplete evidence',
    ],
    [
      'unknown ruleId with no component reference',
      {
        ...parseFixture('pinned-codeql-finding.sarif'),
        runs: [
          {
            ...parseFixture('pinned-codeql-finding.sarif').runs[0],
            results: [{ ruleId: 'js/not-in-rules', message: { text: 'x' } }],
          },
        ],
      },
      'unknown or ambiguous ruleId reference',
    ],
    [
      'toolComponent index out of range',
      {
        ...parseFixture('pinned-codeql-finding.sarif'),
        runs: [
          {
            ...parseFixture('pinned-codeql-finding.sarif').runs[0],
            results: [
              {
                ruleId: 'js/request-forgery',
                rule: {
                  id: 'js/request-forgery',
                  index: 0,
                  toolComponent: { index: 9 },
                },
                message: { text: 'x' },
              },
            ],
          },
        ],
      },
      'invalid rule.toolComponent reference',
    ],
    [
      'ruleId ambiguous across components without a component reference',
      (() => {
        const document = parseFixture('pinned-codeql-finding.sarif');
        const run = document.runs[0];
        run.tool.driver.rules = [{ ...run.tool.extensions[0].rules[0] }];
        run.results = [
          { ruleId: 'js/request-forgery', message: { text: 'x' } },
        ];
        return document;
      })(),
      'unknown or ambiguous ruleId reference',
    ],
    [
      'rule reference disagreeing with its resolved index',
      {
        ...parseFixture('pinned-codeql-finding.sarif'),
        runs: [
          {
            ...parseFixture('pinned-codeql-finding.sarif').runs[0],
            results: [
              {
                ruleId: 'js/insecure-temporary-file',
                rule: {
                  id: 'js/insecure-temporary-file',
                  index: 0,
                  toolComponent: { index: 0 },
                },
                message: { text: 'x' },
              },
            ],
          },
        ],
      },
      'ruleId and ruleIndex refer to different rules',
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
      runCodeqlSarifPolicy(['--input=input.sarif'], readBytes('{}\n')),
    ).toThrow('CodeQL SARIF policy failed');
  });
});
