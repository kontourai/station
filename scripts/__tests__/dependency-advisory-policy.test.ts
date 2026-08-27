import { execFileSync } from 'node:child_process';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';

import {
  evaluateAuditPolicy,
  formatPolicyReport,
  parseAuditCommandResult,
} from '../dependency-advisory-policy.mjs';

const NOW = new Date('2026-07-10T00:00:00.000Z');

function auditWithHighAdvisory() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      axios: {
        name: 'axios',
        severity: 'high',
        isDirect: false,
        via: [
          {
            source: 1108263,
            name: 'axios',
            dependency: 'axios',
            title: 'Axios denial of service through __proto__ key',
            url: 'https://github.com/advisories/GHSA-43fc-jf86-j433',
            severity: 'high',
            range: '<1.18.0',
          },
        ],
        effects: [],
        range: '<1.18.0',
        nodes: ['node_modules/axios'],
        fixAvailable: true,
      },
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 1,
        critical: 0,
        total: 1,
      },
    },
  };
}

function validException(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'root',
    package: 'axios',
    advisory: 'GHSA-43fc-jf86-j433',
    severity: 'high',
    owner: 'station-maintainers',
    reason: 'Temporary compatibility constraint.',
    trackingIssue: 'https://github.com/kontourai/station/issues/265',
    expires: '2026-08-10',
    ...overrides,
  };
}

function auditWithLowAdvisory(severity = 'low') {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      '@ai-sdk/provider-utils': {
        name: '@ai-sdk/provider-utils',
        severity,
        via: [
          {
            source: 1119676,
            name: '@ai-sdk/provider-utils',
            dependency: '@ai-sdk/provider-utils',
            title: 'Uncontrolled Resource Consumption',
            url: 'https://github.com/advisories/GHSA-866g-f22w-33x8',
            severity,
            range: '<=3.0.97',
          },
        ],
        nodes: ['node_modules/@ai-sdk/provider-utils'],
      },
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: severity === 'low' ? 1 : 0,
        moderate: severity === 'moderate' ? 1 : 0,
        high: 0,
        critical: 0,
        total: 1,
      },
    },
  };
}

function validResidual(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'root',
    package: '@ai-sdk/provider-utils',
    version: '3.0.30',
    advisory: 'GHSA-866g-f22w-33x8',
    severity: 'low',
    reachability: 'production',
    owner: 'station-maintainers',
    disposition: 'Nested framework dependency has no compatible update.',
    controls: 'Authenticated runtime entrypoint and request-size limits.',
    trackingUrl: 'https://github.com/kontourai/station/issues/1683',
    expires: '2026-08-10',
    recheckTrigger: 'Every upstream framework update.',
    ...overrides,
  };
}

function productionLowDocument() {
  return {
    scope: 'root',
    reachability: 'production',
    audit: auditWithLowAdvisory(),
    resolvedVersions: {
      'node_modules/@ai-sdk/provider-utils': '3.0.30',
    },
  };
}

// #1019: the contract-validation case runs the real remediation graph
// (~2.2s quiet) — under parallel workers or a sibling session the 5s default
// budget starves. Cap, not expectation.
describe('dependency advisory policy', { timeout: 20_000 }, () => {
  it('keeps the patched brace-expansion graph behaviorally compatible', () => {
    expect(minimatch('app.ts', '{app,test}.ts')).toBe(true);
  });

  it('keeps the remediated dependency graph contract-valid', () => {
    const npmArgs = [
      'ls',
      'glob',
      'test-exclude',
      'minimatch',
      'brace-expansion',
      '--all',
    ];
    const executable =
      process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
    const args =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npm.cmd', ...npmArgs]
        : npmArgs;
    expect(() =>
      execFileSync(executable, args, { encoding: 'utf8', windowsHide: true }),
    ).not.toThrow();
  });

  it('rejects an unaccepted high advisory and names it in the production report', () => {
    const result = evaluateAuditPolicy(
      [{ scope: 'root', audit: auditWithHighAdvisory() }],
      { version: 2, exceptions: [], residuals: [] },
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    expect(result.blockingFindings).toEqual([
      expect.objectContaining({
        scope: 'root',
        package: 'axios',
        advisory: 'GHSA-43fc-jf86-j433',
        severity: 'high',
      }),
    ]);
    expect(formatPolicyReport(result)).toContain(
      'root: axios GHSA-43fc-jf86-j433 (high)',
    );
  });

  it('passes after the seeded high advisory is removed', () => {
    const audit = auditWithHighAdvisory();
    audit.vulnerabilities = {};
    audit.metadata.vulnerabilities = {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    };

    const result = evaluateAuditPolicy(
      [{ scope: 'root', audit }],
      { version: 2, exceptions: [], residuals: [] },
      { now: NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.scopes['root/full']).toEqual(
      expect.objectContaining({ low: 0, moderate: 0, high: 0, critical: 0 }),
    );
  });

  it.each(['low', 'moderate'])(
    'requires an exact residual for every production %s advisory',
    (severity) => {
      const document = productionLowDocument();
      document.audit = auditWithLowAdvisory(severity);
      const result = evaluateAuditPolicy(
        [document],
        { version: 2, exceptions: [], residuals: [] },
        { now: NOW },
      );

      expect(result.ok).toBe(false);
      expect(result.untrackedResiduals).toEqual([
        expect.objectContaining({
          package: '@ai-sdk/provider-utils',
          version: '3.0.30',
          advisory: 'GHSA-866g-f22w-33x8',
          severity,
        }),
      ]);
    },
  );

  it('requires an exact package version for every production residual', () => {
    const result = evaluateAuditPolicy(
      [productionLowDocument()],
      { version: 2, exceptions: [], residuals: [] },
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    expect(result.untrackedResiduals).toEqual([
      expect.objectContaining({
        package: '@ai-sdk/provider-utils',
        version: '3.0.30',
        advisory: 'GHSA-866g-f22w-33x8',
      }),
    ]);
  });

  it.each(['low', 'moderate'])(
    'fails loud when production metadata reports a missing %s vulnerability record',
    (severity) => {
      const document = productionLowDocument();
      document.audit = auditWithLowAdvisory(severity);
      document.audit.vulnerabilities = {};

      expect(() =>
        evaluateAuditPolicy(
          [document],
          { version: 2, exceptions: [], residuals: [] },
          { now: NOW },
        ),
      ).toThrow(`metadata ${severity} count mismatch`);
    },
  );

  it('fails loud when production metadata total does not match its vulnerability records', () => {
    const document = productionLowDocument();
    document.audit.metadata.vulnerabilities.total = 2;

    expect(() =>
      evaluateAuditPolicy(
        [document],
        { version: 2, exceptions: [], residuals: [] },
        { now: NOW },
      ),
    ).toThrow('metadata total count mismatch');
  });

  it('accepts repeated vulnerable nodes that resolve to one tracked root version', () => {
    const document = productionLowDocument();
    document.audit.vulnerabilities['@ai-sdk/provider-utils'].nodes.push(
      'node_modules/framework-copy/node_modules/@ai-sdk/provider-utils',
    );
    document.resolvedVersions[
      'node_modules/framework-copy/node_modules/@ai-sdk/provider-utils'
    ] = '3.0.30';

    const result = evaluateAuditPolicy(
      [document],
      { version: 2, exceptions: [], residuals: [validResidual()] },
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(result.trackedResiduals).toHaveLength(1);
  });

  it('tracks an exact production residual but leaves development-only low findings visible and unwaived', () => {
    const productionResult = evaluateAuditPolicy(
      [productionLowDocument()],
      { version: 2, exceptions: [], residuals: [validResidual()] },
      { now: NOW },
    );
    expect(productionResult.ok).toBe(true);
    expect(productionResult.trackedResiduals).toHaveLength(1);

    const fullResult = evaluateAuditPolicy(
      [{ scope: 'root', reachability: 'full', audit: auditWithLowAdvisory() }],
      { version: 2, exceptions: [], residuals: [] },
      { now: NOW },
    );
    expect(fullResult.ok).toBe(true);
    expect(fullResult.scopes['root/full']).toMatchObject({ low: 1 });
  });

  it.each([
    [
      'an expired residual',
      validResidual({ expires: '2026-07-09' }),
      'expired',
    ],
    [
      'a mismatched residual version',
      validResidual({ version: '3.0.29' }),
      'unused residual',
    ],
    [
      'a mismatched residual severity',
      validResidual({ severity: 'moderate' }),
      'residual severity mismatch',
    ],
    [
      'an unused residual',
      validResidual({ advisory: 'GHSA-1111-2222-3333' }),
      'unused residual',
    ],
  ])('rejects %s', (_label, residual, expected) => {
    const result = evaluateAuditPolicy(
      [productionLowDocument()],
      { version: 2, exceptions: [], residuals: [residual] },
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    expect(result.exceptionErrors.join('\n')).toContain(expected);
  });

  it.each([
    ['unknown fields', validException({ surprise: true }), 'unknown field'],
    [
      'an invalid tracking issue',
      validException({ trackingIssue: 'station#265' }),
      'trackingIssue',
    ],
    [
      'an expired exception',
      validException({ expires: '2026-07-09' }),
      'expired',
    ],
    [
      'a severity mismatch',
      validException({ severity: 'critical' }),
      'severity mismatch',
    ],
  ])('rejects %s', (_label, exception, expected) => {
    const result = evaluateAuditPolicy(
      [{ scope: 'root', audit: auditWithHighAdvisory() }],
      { version: 2, exceptions: [exception], residuals: [] },
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    expect(result.exceptionErrors.join('\n')).toContain(expected);
  });

  it('rejects duplicate exception identities', () => {
    const exception = validException();
    const result = evaluateAuditPolicy(
      [{ scope: 'root', audit: auditWithHighAdvisory() }],
      { version: 2, exceptions: [exception, { ...exception }], residuals: [] },
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    expect(result.exceptionErrors.join('\n')).toContain('duplicate');
  });

  it('rejects an unused exception', () => {
    const audit = auditWithHighAdvisory();
    audit.vulnerabilities = {};
    audit.metadata.vulnerabilities.high = 0;
    audit.metadata.vulnerabilities.total = 0;
    const result = evaluateAuditPolicy(
      [{ scope: 'root', audit }],
      { version: 2, exceptions: [validException()], residuals: [] },
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    expect(result.exceptionErrors.join('\n')).toContain('unused');
  });

  it('accepts an exact, valid exception and does not suppress another advisory', () => {
    const audit = auditWithHighAdvisory();
    audit.vulnerabilities.axios.via.push({
      source: 1109000,
      name: 'axios',
      dependency: 'axios',
      title: 'A different axios advisory',
      url: 'https://github.com/advisories/GHSA-1111-2222-3333',
      severity: 'high',
      range: '<1.18.1',
    });

    const result = evaluateAuditPolicy(
      [{ scope: 'root', audit }],
      { version: 2, exceptions: [validException()], residuals: [] },
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    expect(result.acceptedFindings).toHaveLength(1);
    expect(result.blockingFindings).toEqual([
      expect.objectContaining({ advisory: 'GHSA-1111-2222-3333' }),
    ]);
  });

  it('fails loud for an unsupported npm audit shape', () => {
    expect(() =>
      evaluateAuditPolicy(
        [{ scope: 'root', audit: { auditReportVersion: 1 } }],
        { version: 2, exceptions: [], residuals: [] },
        { now: NOW },
      ),
    ).toThrow('unsupported npm audit JSON');
  });

  it('rejects a dangling string via reference from a blocking record', () => {
    const audit = auditWithHighAdvisory();
    audit.vulnerabilities.axios.via = ['missing-package'];

    expect(() =>
      evaluateAuditPolicy(
        [{ scope: 'root', audit }],
        { version: 2, exceptions: [], residuals: [] },
        { now: NOW },
      ),
    ).toThrow('dangling');
  });

  it('rejects an empty blocking vulnerability record', () => {
    const audit = auditWithHighAdvisory();
    audit.vulnerabilities.axios.via = [];

    expect(() =>
      evaluateAuditPolicy(
        [{ scope: 'root', audit }],
        { version: 2, exceptions: [], residuals: [] },
        { now: NOW },
      ),
    ).toThrow('no advisory identities');
  });

  it('rejects a cycle in blocking string via references', () => {
    const audit = auditWithHighAdvisory();
    audit.vulnerabilities.axios.via = ['form-data'];
    audit.vulnerabilities['form-data'] = {
      ...audit.vulnerabilities.axios,
      name: 'form-data',
      via: ['axios'],
    };
    audit.metadata.vulnerabilities.high = 2;
    audit.metadata.vulnerabilities.total = 2;

    expect(() =>
      evaluateAuditPolicy(
        [{ scope: 'root', audit }],
        { version: 2, exceptions: [], residuals: [] },
        { now: NOW },
      ),
    ).toThrow('cycle');
  });

  it('accounts an advisory identity through a valid string via chain', () => {
    const audit = auditWithHighAdvisory();
    audit.vulnerabilities['form-data'] = {
      ...audit.vulnerabilities.axios,
      name: 'form-data',
    };
    audit.vulnerabilities.axios.via = ['form-data'];
    audit.metadata.vulnerabilities.high = 2;
    audit.metadata.vulnerabilities.total = 2;

    const result = evaluateAuditPolicy(
      [{ scope: 'root', audit }],
      { version: 2, exceptions: [], residuals: [] },
      { now: NOW },
    );

    expect(result.blockingFindings).toEqual([
      expect.objectContaining({
        package: 'axios',
        advisory: 'GHSA-43fc-jf86-j433',
      }),
    ]);
  });

  it('rejects a blocking record whose advisory object has no identity', () => {
    const audit = auditWithHighAdvisory();
    audit.vulnerabilities.axios.via[0].source = '';
    delete audit.vulnerabilities.axios.via[0].url;

    expect(() =>
      evaluateAuditPolicy(
        [{ scope: 'root', audit }],
        { version: 2, exceptions: [], residuals: [] },
        { now: NOW },
      ),
    ).toThrow('no identity');
  });

  it('rejects high/critical metadata counts that do not match blocking records', () => {
    const audit = auditWithHighAdvisory();
    audit.metadata.vulnerabilities.high = 2;
    audit.metadata.vulnerabilities.total = 1;

    expect(() =>
      evaluateAuditPolicy(
        [{ scope: 'root', audit }],
        { version: 2, exceptions: [], residuals: [] },
        { now: NOW },
      ),
    ).toThrow('metadata high count mismatch');
  });

  it.each(['2026-13-01', '2026-02-30', '2027-02-29'])(
    'rejects invalid calendar expiry %s',
    (expires) => {
      const result = evaluateAuditPolicy(
        [{ scope: 'root', audit: auditWithHighAdvisory() }],
        {
          version: 2,
          exceptions: [validException({ expires })],
          residuals: [],
        },
        { now: NOW },
      );

      expect(result.ok).toBe(false);
      expect(result.exceptionErrors.join('\n')).toContain('valid calendar');
    },
  );

  it('accepts a valid future leap-day expiry', () => {
    const result = evaluateAuditPolicy(
      [{ scope: 'root', audit: auditWithHighAdvisory() }],
      {
        version: 2,
        exceptions: [validException({ expires: '2028-02-29' })],
        residuals: [],
      },
      { now: NOW },
    );

    expect(result.ok).toBe(true);
    expect(result.acceptedFindings).toHaveLength(1);
  });

  it.each([
    ['operational exit', { status: 2, signal: null }],
    ['null exit', { status: null, signal: null }],
    ['signal termination', { status: null, signal: 'SIGTERM' }],
  ])(
    'rejects an npm audit %s even when stdout is valid JSON',
    (_label, result) => {
      expect(() =>
        parseAuditCommandResult('root', {
          ...result,
          error: undefined,
          stdout: JSON.stringify(auditWithHighAdvisory()),
          stderr: '',
        }),
      ).toThrow('operational failure');
    },
  );

  it('accepts npm audit status 1 when stdout is valid audit JSON', () => {
    expect(
      parseAuditCommandResult('root', {
        status: 1,
        signal: null,
        error: undefined,
        stdout: JSON.stringify(auditWithHighAdvisory()),
        stderr: '',
      }),
    ).toEqual(auditWithHighAdvisory());
  });
});
