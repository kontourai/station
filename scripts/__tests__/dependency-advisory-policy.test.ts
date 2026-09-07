import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_DEPENDENCY_SCOPES,
  classifyChangedPaths,
} from '../classify-ci-change.mjs';
import {
  AUDIT_SCOPES,
  collectAudits,
  dependencyAuditDecision,
  evaluateAuditPolicy,
  formatPolicyReport,
  parseAuditCommandResult,
  runPolicyCli,
  selectAuditScopes,
  withAuditRetries,
} from '../dependency-advisory-policy.mjs';
import { validateInstalledRemediationGraph } from '../lib/installed-remediation-graph.mjs';
import {
  collectPnpmAudits,
  normalizePnpmAudit,
} from '../lib/pnpm-advisory.mjs';
import {
  pnpmDependencyGraph,
  pnpmImporterManifest,
} from '../lib/pnpm-dependency-graph.mjs';

const NOW = new Date('2026-07-10T00:00:00.000Z');

describe('dependency audit collection', () => {
  it('skips a GitHub pull request whose exact range has no dependency inputs', () => {
    const decision = dependencyAuditDecision({
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_EVENT_PATH: '/event.json',
      },
      loadEvent: () => ({
        pull_request: { base: { sha: 'a' }, head: { sha: 'b' } },
      }),
      // #1430: the classified range starts at the merge base of the two, not
      // at the base branch tip the event carries.
      resolveMergeBase: () => 'mergebase',
      classifyRange: ({ before, after }) => {
        expect({ before, after }).toEqual({ before: 'mergebase', after: 'b' });
        return {
          dependencies: false,
          classification: 'runtime-or-workflow',
          dependencyScopes: [],
        };
      },
    });

    expect(decision).toEqual({
      required: false,
      reason: 'runtime-or-workflow',
      scopes: [],
      range: { before: 'mergebase', after: 'b' },
    });
  });

  it('classifies a pull request from its merge base, not the base branch tip', () => {
    // #1430: GitHub's `pull_request.base.sha` is the base branch's CURRENT
    // tip, so diffing it against the head attributes every dependency change
    // that landed on main after the branch was cut to this pull request. The
    // range handed to the classifier must start at the merge base.
    const classified: { before: string; after: string }[] = [];
    const decision = dependencyAuditDecision({
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: '/event.json',
      },
      loadEvent: () => ({
        pull_request: { base: { sha: 'basetip' }, head: { sha: 'head' } },
      }),
      resolveMergeBase: ({ before, after }) => {
        expect({ before, after }).toEqual({ before: 'basetip', after: 'head' });
        return 'mergebase';
      },
      classifyRange: ({ before, after }) => {
        classified.push({ before, after });
        return {
          dependencies: false,
          classification: 'runtime-or-workflow',
          dependencyScopes: [],
        };
      },
    });

    expect(classified).toEqual([{ before: 'mergebase', after: 'head' }]);
    expect(decision).toEqual({
      required: false,
      reason: 'runtime-or-workflow',
      scopes: [],
      range: { before: 'mergebase', after: 'head' },
    });
  });

  it('leaves a merge-queue candidate to its own base sha', () => {
    // `merge_group.base_sha` already describes the candidate's own boundary,
    // so resolving a merge base here would be wrong as well as unnecessary.
    const classified: { before: string; after: string }[] = [];
    dependencyAuditDecision({
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_EVENT_PATH: '/event.json',
      },
      loadEvent: () => ({
        merge_group: { base_sha: 'candidatebase', head_sha: 'candidatehead' },
      }),
      resolveMergeBase: () => {
        throw new Error('merge base must not be resolved for merge_group');
      },
      classifyRange: ({ before, after }) => {
        classified.push({ before, after });
        return { dependencies: true, classification: 'dependencies' };
      },
    });

    expect(classified).toEqual([
      { before: 'candidatebase', after: 'candidatehead' },
    ]);
  });

  it('keeps scheduled and manual policy runs live', () => {
    expect(
      dependencyAuditDecision({
        env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule' },
      }),
    ).toEqual({
      required: true,
      reason: 'schedule event',
      scopes: ['root', 'sdk', 'shared'],
      range: null,
    });
  });

  it('fails closed when GitHub range evidence is unavailable', () => {
    expect(
      dependencyAuditDecision({
        env: {
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_NAME: 'pull_request_target',
        },
      }),
    ).toEqual({
      required: true,
      reason:
        'range classification failed closed: GITHUB_EVENT_PATH is missing',
      scopes: ['root', 'sdk', 'shared'],
      range: null,
    });
  });

  it('runs full and production audits for every scope concurrently', async () => {
    const scopes = [
      { scope: 'root', cwd: '/repo' },
      { scope: 'sdk', cwd: '/repo/packages/sdk' },
      { scope: 'shared', cwd: '/repo/packages/shared' },
    ];
    let active = 0;
    let peak = 0;
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const runner = (scope: string, _cwd: string, productionOnly: boolean) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const key = `${scope}:${productionOnly ? 'production' : 'full'}`;
        active += 1;
        peak = Math.max(peak, active);
        started.push(key);
        releases.set(key, () => {
          active -= 1;
          resolve({ key });
        });
      });

    const pending = collectAudits(scopes, runner, () => ({}));
    await Promise.resolve();

    expect(started).toEqual([
      'root:full',
      'root:production',
      'sdk:full',
      'sdk:production',
      'shared:full',
      'shared:production',
    ]);
    expect(peak).toBe(6);
    for (const release of releases.values()) release();
    await expect(pending).resolves.toHaveLength(6);
  });

  it('retries one operational audit failure within a fixed attempt bound', async () => {
    let attempts = 0;
    const result = await withAuditRetries('shared', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('registry unavailable');
      return 'audit-report';
    });

    expect(result).toBe('audit-report');
    expect(attempts).toBe(2);
  });
});

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

describe('dependency advisory policy', () => {
  it('keeps the patched brace-expansion graph behaviorally compatible', () => {
    expect(minimatch('app.ts', '{app,test}.ts')).toBe(true);
  });

  it('keeps the remediated dependency graph contract-valid', () => {
    const edges = validateInstalledRemediationGraph(process.cwd());
    for (const directory of new Set(
      edges
        .filter((edge) => edge.name === 'minimatch')
        .map((edge) => edge.directory),
    )) {
      const installed = createRequire(path.join(directory, 'package.json'))(
        directory,
      );
      const match =
        typeof installed === 'function' ? installed : installed.minimatch;
      expect(match('app.ts', '{app,test}.ts')).toBe(true);
      expect(match('other.ts', '{app,test}.ts')).toBe(false);
    }

    expect(
      edges.some(
        (edge) =>
          edge.parent === 'minimatch' && edge.name === 'brace-expansion',
      ),
    ).toBe(true);
  });

  it('rejects broken installed edges even when configuration is unchanged', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'station-remediation-'));
    const put = (directory: string, manifest: object) => {
      mkdirSync(path.join(root, directory), { recursive: true });
      writeFileSync(
        path.join(root, directory, 'package.json'),
        JSON.stringify(manifest),
      );
    };
    const child =
      'node_modules/glob/node_modules/minimatch/node_modules/brace-expansion';
    try {
      writeFileSync(
        path.join(root, 'pnpm-workspace.yaml'),
        `packages: []
nodeLinker: hoisted
overrides:
  minimatch@^10.0.0>brace-expansion: ^5.0.9
  brace-expansion@^2.0.2: ^2.1.4
`,
      );
      put('.', {
        name: 'fixture',
        dependencies: { glob: '^10.0.0', 'test-exclude': '^7.0.0' },
      });
      put('node_modules/glob', {
        name: 'glob',
        version: '10.5.0',
        dependencies: { minimatch: '^9.0.0' },
      });
      put('node_modules/test-exclude', {
        name: 'test-exclude',
        version: '7.0.0',
        dependencies: { minimatch: '^10.0.0' },
      });
      put('node_modules/minimatch', {
        name: 'minimatch',
        version: '10.2.5',
        dependencies: { 'brace-expansion': '^4.0.0' },
      });
      put('node_modules/brace-expansion', {
        name: 'brace-expansion',
        version: '5.0.9',
      });
      put('node_modules/glob/node_modules/minimatch', {
        name: 'minimatch',
        version: '9.0.9',
        dependencies: { 'brace-expansion': '^2.0.2' },
      });
      put(child, { name: 'brace-expansion', version: '2.1.4' });
      expect(validateInstalledRemediationGraph(root)).toHaveLength(6);
      put(child, { name: 'brace-expansion', version: '5.0.9' });
      expect(() => validateInstalledRemediationGraph(root)).toThrow(
        'Invalid installed dependency',
      );
      put(child, { name: 'brace-expansion', version: '2.0.2' });
      expect(() => validateInstalledRemediationGraph(root)).toThrow(
        'Unremediated',
      );
      put(child, { name: 'wrong-package', version: '2.1.4' });
      expect(() => validateInstalledRemediationGraph(root)).toThrow(
        'Invalid installed dependency',
      );
      rmSync(path.join(root, child), { recursive: true });
      // A missing nested copy must not silently accept an incompatible hoist.
      expect(() => validateInstalledRemediationGraph(root)).toThrow(
        'Invalid installed dependency',
      );
      const decoy = 'node_modules/glob/node_modules/node_modules';
      put(decoy, { name: 'decoy-container', version: '1.0.0' });
      put(`${decoy}/brace-expansion`, {
        name: 'brace-expansion',
        version: '2.1.4',
      });
      const actualResolver = createRequire(
        path.join(
          root,
          'node_modules/glob/node_modules/minimatch/package.json',
        ),
      );
      expect(actualResolver.resolve('brace-expansion/package.json')).toBe(
        realpathSync(
          path.join(root, 'node_modules/brace-expansion/package.json'),
        ),
      );
      expect(() => validateInstalledRemediationGraph(root)).toThrow(
        'Invalid installed dependency',
      );
      rmSync(path.join(root, decoy), { recursive: true });
      rmSync(path.join(root, 'node_modules/test-exclude'), { recursive: true });
      expect(() => validateInstalledRemediationGraph(root)).toThrow(
        'Missing installed dependency',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('classifies a JSON error envelope as an operational response', () => {
    expect(() =>
      parseAuditCommandResult('shared', {
        status: 1,
        signal: null,
        error: undefined,
        stdout: JSON.stringify({
          error: { code: 'E503', summary: 'registry unavailable' },
        }),
        stderr: '',
      }),
    ).toThrow(
      'npm audit operational response for shared (exit 1): {"code":"E503","summary":"registry unavailable"}',
    );
  });

  it('reports the registry reason npm puts outside its error envelope', () => {
    // Captured verbatim from `npm audit --json --registry=http://127.0.0.1:9`
    // (exit 1): the reason is a top-level `message` and the error envelope's
    // own fields are empty strings, so quoting `error` alone reports
    // `{"summary":"","detail":""}` and names nothing (#1403).
    expect(() =>
      parseAuditCommandResult('root', {
        status: 1,
        signal: null,
        error: undefined,
        stdout: JSON.stringify({
          message:
            'request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9',
          error: { summary: '', detail: '' },
        }),
        stderr: 'npm error audit endpoint returned an error',
      }),
    ).toThrow(
      'npm audit operational response for root (exit 1): {"message":"request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9","error":{"summary":"","detail":""}}',
    );
  });
});

describe('scoped audit policy composition', () => {
  function committedConfig() {
    return JSON.parse(
      readFileSync(
        new URL('../dependency-advisory-exceptions.json', import.meta.url),
        'utf8',
      ),
    );
  }

  function cleanAudit() {
    return {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 0,
        },
      },
    };
  }

  async function partialDocuments(scopes: string[]) {
    const decision = dependencyAuditDecision({
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: '/event.json',
      },
      loadEvent: () => ({
        pull_request: { base: { sha: 'a' }, head: { sha: 'b' } },
      }),
      // The event uses synthetic identities; compose the real path classifier
      // below, but substitute the merge-base Git I/O just like the event I/O.
      resolveMergeBase: ({ before, after }) => {
        expect({ before, after }).toEqual({ before: 'a', after: 'b' });
        return 'fixture-merge-base';
      },
      classifyRange: ({ before, after }) => {
        expect({ before, after }).toEqual({
          before: 'fixture-merge-base',
          after: 'b',
        });
        return classifyChangedPaths(
          scopes.map((scope) => `packages/${scope}/package-lock.json`),
        );
      },
    });
    const selected = selectAuditScopes(decision);
    expect(selected.map((entry) => entry.scope)).toEqual(scopes);
    return collectAudits(
      selected,
      async () => cleanAudit(),
      () => ({}),
    );
  }

  it.each([
    { scopes: ['sdk'] },
    { scopes: ['shared'] },
    { scopes: ['sdk', 'shared'] },
  ])(
    'evaluates a clean narrowed $scopes scan with the committed root residuals',
    async ({ scopes }) => {
      const documents = await partialDocuments(scopes);
      const result = evaluateAuditPolicy(documents, committedConfig(), {
        now: NOW,
      });
      expect(result.exceptionErrors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(Object.keys(result.scopes)).toEqual(
        scopes.flatMap((scope) => [`${scope}/full`, `${scope}/production`]),
      );
    },
  );

  it.each([
    ['exceptions', { scope: 'rooot' }, 'unknown scope'],
    ['residuals', { scope: 'rooot' }, 'unknown scope'],
    ['exceptions', { owner: '' }, 'owner must be a non-empty string'],
    ['residuals', { controls: '' }, 'controls must be a non-empty string'],
    ['exceptions', { expires: '2026-07-09' }, 'is expired'],
    ['residuals', { expires: '2026-07-09' }, 'is expired'],
    ['exceptions', { surprise: true }, 'unknown field'],
    ['residuals', { surprise: true }, 'unknown field'],
  ])(
    'validates unscanned global %s rules: %j',
    async (kind, override, message) => {
      const config = committedConfig();
      config.exceptions.push(validException());
      Object.assign(config[kind as string][0], override);
      const result = evaluateAuditPolicy(
        await partialDocuments(['sdk']),
        config,
        { now: NOW },
      );
      expect(result.ok).toBe(false);
      expect(result.exceptionErrors.join('\n')).toContain(message);
      expect(result.exceptionErrors.join('\n')).not.toContain('unused');
    },
  );

  it('still rejects unused exceptions and residuals in the audited scope', async () => {
    const config = committedConfig();
    config.exceptions.push(validException({ scope: 'sdk' }));
    config.residuals.push(validResidual({ scope: 'sdk' }));
    const result = evaluateAuditPolicy(
      await partialDocuments(['sdk']),
      config,
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    expect(result.exceptionErrors).toEqual([
      expect.stringContaining('unused exception for sdk:'),
      expect.stringContaining('unused residual for sdk:'),
    ]);
  });

  it.each(['high', 'critical'])(
    'blocks an unaccepted %s in a narrowed scan',
    async (severity) => {
      const documents = await partialDocuments(['sdk']);
      const audit = auditWithHighAdvisory();
      audit.vulnerabilities.axios.severity = severity;
      audit.vulnerabilities.axios.via[0].severity = severity;
      audit.metadata.vulnerabilities.high = severity === 'high' ? 1 : 0;
      audit.metadata.vulnerabilities.critical = severity === 'critical' ? 1 : 0;
      documents[0].audit = audit;
      const result = evaluateAuditPolicy(documents, committedConfig(), {
        now: NOW,
      });
      expect(result.exceptionErrors).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.blockingFindings).toEqual([
        expect.objectContaining({ scope: 'sdk', severity, package: 'axios' }),
      ]);
    },
  );

  it('blocks an untracked production residual in a narrowed scan', async () => {
    const documents = await partialDocuments(['shared']);
    Object.assign(documents[1], productionLowDocument(), { scope: 'shared' });
    const result = evaluateAuditPolicy(documents, committedConfig(), {
      now: NOW,
    });
    expect(result.exceptionErrors).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.untrackedResiduals).toEqual([
      expect.objectContaining({ scope: 'shared', severity: 'low' }),
    ]);
  });

  it('does not report production residuals unused after only a full-graph audit', () => {
    const result = evaluateAuditPolicy(
      [{ scope: 'root', reachability: 'full', audit: cleanAudit() }],
      committedConfig(),
      { now: NOW },
    );
    expect(result.exceptionErrors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('still enforces every committed residual on full scheduled audits', async () => {
    const decision = dependencyAuditDecision({
      env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule' },
    });
    const documents = await collectAudits(
      selectAuditScopes(decision),
      async () => cleanAudit(),
      () => ({}),
    );
    expect(documents).toHaveLength(6);
    const config = committedConfig();
    config.exceptions.push(validException());
    const result = evaluateAuditPolicy(documents, config, { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.exceptionErrors).toEqual([
      expect.stringContaining('unused exception for root:'),
      ...config.residuals.map(() =>
        expect.stringContaining('unused residual for root:'),
      ),
    ]);
  });

  it('refuses an unknown audit document scope, even with no configured rules', () => {
    expect(() =>
      evaluateAuditPolicy(
        [{ scope: 'rooot', audit: cleanAudit() }],
        { version: 2, exceptions: [], residuals: [] },
        { now: NOW },
      ),
    ).toThrow('unknown audit document scope: rooot');
  });
});

/**
 * The selection is the ENFORCEMENT point of #1417's narrowing: the classifier
 * only declares which scopes changed, and every test of that declaration
 * passes just as well if this filter is inverted, dropped, or stripped of its
 * empty-selection guard. Those are the mutations these tests exist to catch.
 */
describe('selectAuditScopes', () => {
  const all = [
    { scope: 'root', cwd: '/repo' },
    { scope: 'sdk', cwd: '/repo/packages/sdk' },
    { scope: 'shared', cwd: '/repo/packages/shared' },
  ];

  it('audits exactly the scopes the decision names', () => {
    expect(selectAuditScopes({ scopes: ['root'], reason: 'x' }, all)).toEqual([
      { scope: 'root', cwd: '/repo' },
    ]);
    expect(
      selectAuditScopes({ scopes: ['sdk', 'shared'], reason: 'x' }, all).map(
        (entry) => entry.scope,
      ),
    ).toEqual(['sdk', 'shared']);
  });

  it('audits every scope when the decision names none at all', () => {
    // Not "audit nothing". A decision without scopes is an older or unknown
    // caller, and the safe reading of silence is everything.
    expect(
      selectAuditScopes({ reason: 'no scopes' }, all).map(
        (entry) => entry.scope,
      ),
    ).toEqual(['root', 'sdk', 'shared']);
  });

  it('refuses an empty selection rather than reporting a clean scan of nothing', () => {
    expect(() => selectAuditScopes({ scopes: [], reason: 'why' }, all)).toThrow(
      /selected no scopes \(decision: why\)/,
    );
  });

  it('refuses when a decision names only scopes the audit does not run', () => {
    // The drift direction that fails loudly: a classifier that knows a scope
    // the audit does not must not silently audit the remainder.
    expect(() =>
      selectAuditScopes({ scopes: ['contracts'], reason: 'drift' }, all),
    ).toThrow(/selected no scopes/);
  });

  it('audits exactly the scopes the classifier can attribute, and no others', () => {
    // The drift direction that would fail SILENTLY if these were two lists:
    // a scope the audit runs but the classifier has never heard of is filtered
    // out of every selection, including the fail-closed ones, and the run
    // reports success having never scanned it.
    //
    // This pins the VALUES agreeing, which is what catches that drift once it
    // is real. It cannot observe that one is derived from the other -- a
    // hardcoded list that happens to match still passes -- so the derivation
    // is a code property, not something this asserts.
    expect(AUDIT_SCOPES.map((entry) => entry.scope)).toEqual([
      ...ALL_DEPENDENCY_SCOPES,
    ]);
  });

  it('resolves each scope to its own package directory', () => {
    // The cwd is what `npm audit` actually runs in and what the lockfile is
    // read from, and nothing else asserts it: a scope root edited to an
    // absolute path, a typo, or a `..` would keep every other test green and
    // surface only as a live "committed lockfile is missing" in CI.
    const byScope = Object.fromEntries(
      AUDIT_SCOPES.map((entry) => [entry.scope, entry.cwd]),
    );
    expect(byScope.sdk).toBe(path.join(byScope.root, 'packages', 'sdk'));
    expect(byScope.shared).toBe(path.join(byScope.root, 'packages', 'shared'));
    for (const cwd of Object.values(byScope)) {
      expect(path.isAbsolute(cwd)).toBe(true);
      expect(cwd).not.toContain('..');
      expect(existsSync(path.join(cwd, 'package.json'))).toBe(true);
      expect(existsSync(path.join(process.cwd(), 'pnpm-lock.yaml'))).toBe(true);
    }
  });
});

describe('runPolicyCli reports the range it decided from (#1442)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureLog() {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    return lines;
  }

  it('names the range on the skip path', async () => {
    const lines = captureLog();
    const code = await runPolicyCli({
      decide: () => ({
        required: false,
        reason: 'runtime-or-workflow',
        scopes: [],
        range: { before: 'aaaaaaaa1111', after: 'bbbbbbbb2222' },
      }),
      runAudits: () => {
        throw new Error('must not audit when the decision skips');
      },
    });

    expect(code).toBe(0);
    // The shas, not merely the word "skipped": #1430 was invisible because
    // the conclusion was logged and the evidence for it was not.
    expect(lines.join('\n')).toContain('aaaaaaaa..bbbbbbbb');
  });

  it('names the range on the scanning path, which is the one that explained nothing', async () => {
    const lines = captureLog();
    const code = await runPolicyCli({
      decide: () => ({
        required: true,
        reason: 'runtime-or-workflow',
        scopes: ['root'],
        range: { before: 'cccccccc3333', after: 'dddddddd4444' },
      }),
      runAudits: async () => {
        const clean = auditWithHighAdvisory();
        clean.vulnerabilities = {};
        clean.metadata.vulnerabilities = {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 0,
        };
        return [{ scope: 'root', audit: clean }];
      },
    });

    // Deliberately not asserting the exit code here. This test's subject is
    // the message, and the verdict it returns depends on the repo's real
    // exception/residual config, which other tests in this file own. Pinning
    // it here would make an unrelated config edit fail a logging test.
    expect(typeof code).toBe('number');
    const scanLine = lines.find((line) => line.includes('scanning'));
    expect(scanLine).toBeDefined();
    expect(scanLine).toContain('cccccccc..dddddddd');
  });

  it('does not claim dependency inputs changed on a scan that never saw a range', async () => {
    // #1465. The fourth cell of the matrix, and the one the first version of
    // this feature got wrong: scanning WITHOUT a range. A scheduled or
    // dispatched run audits everything because it is periodic, not because
    // anything changed, and it never resolves a range -- so the shipped
    // message read "dependency inputs changed in no range (event carries
    // none)", asserting a fact nothing computed. The three tests written
    // alongside it covered the other three cells.
    const lines = captureLog();
    await runPolicyCli({
      decide: () => ({
        required: true,
        reason: 'schedule event',
        scopes: ['root'],
        range: null,
      }),
      runAudits: async () => {
        const clean = auditWithHighAdvisory();
        clean.vulnerabilities = {};
        clean.metadata.vulnerabilities = {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 0,
        };
        return [{ scope: 'root', audit: clean }];
      },
    });

    const scanLine = lines.find((line) => line.includes('scanning'));
    expect(scanLine).toBeDefined();
    expect(scanLine).not.toContain('dependency inputs changed');
    expect(scanLine).toContain('full scan');
    expect(scanLine).toContain('schedule event');
  });

  it('says a decision has no range rather than inventing one', async () => {
    const lines = captureLog();
    await runPolicyCli({
      decide: () => ({
        required: false,
        reason: 'runtime-or-workflow',
        scopes: [],
        range: null,
      }),
      runAudits: () => {
        throw new Error('must not audit when the decision skips');
      },
    });

    const text = lines.join('\n');
    expect(text).toContain('no range');
    // A placeholder that reads like a range is the failure mode this guards.
    expect(text).not.toMatch(/[0-9a-f]{8}\.\.[0-9a-f]{8}/);
  });
});

describe('pnpm lock-backed advisory projection', () => {
  const lock = () => ({
    importers: {
      '.': {
        dependencies: { lib: { version: '1.0.0(peer@2.0.0)' } },
        devDependencies: { tool: { version: '1.0.0' } },
      },
      'packages/sdk': { dependencies: { lib: { version: '2.0.0' } } },
      'packages/shared': { dependencies: {} },
    },
    packages: {
      'lib@1.0.0': {},
      'lib@2.0.0': {},
      'tool@1.0.0': {},
      'peer@2.0.0': {},
    },
    snapshots: {
      'lib@1.0.0(peer@2.0.0)': { dependencies: { peer: '2.0.0' } },
      'lib@2.0.0': {},
      'tool@1.0.0': {},
      'peer@2.0.0': {},
    },
  });
  const response = () => ({
    advisories: {
      one: {
        module_name: 'lib',
        severity: 'high',
        github_advisory_id: 'GHSA-abcd-1234-5678',
        findings: [{ version: '1.0.0', paths: ['.>lib'] }],
      },
      two: {
        module_name: 'tool',
        severity: 'moderate',
        github_advisory_id: 'GHSA-efgh-1234-5678',
        findings: [{ version: '1.0.0', paths: ['.>tool'] }],
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 0 },
    },
  });

  it('uses one registry response for all selected scopes and both reachability views', async () => {
    const run = vi.fn(async () => response());
    const audits = await collectPnpmAudits(
      [{ scope: 'root' }, { scope: 'sdk' }, { scope: 'shared' }],
      { root: '/fixture', run, graph: pnpmDependencyGraph(lock()) },
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(6);
    const full = audits.find(
      (a) => a.scope === 'root' && a.reachability === 'full',
    )!;
    const prod = audits.find(
      (a) => a.scope === 'root' && a.reachability === 'production',
    )!;
    expect(Object.keys(full.audit.vulnerabilities)).toEqual(['lib', 'tool']);
    expect(Object.keys(prod.audit.vulnerabilities)).toEqual(['lib']);
    expect(prod.resolvedVersions['lib@1.0.0(peer@2.0.0)']).toBe('1.0.0');
    expect(
      audits
        .filter((a) => a.scope === 'sdk')
        .every((a) => Object.keys(a.audit.vulnerabilities).length === 0),
    ).toBe(true);
    const result = evaluateAuditPolicy(
      audits,
      { version: 2, exceptions: [], residuals: [] },
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed for malformed or truncated advisory records', () => {
    const bad = response();
    bad.metadata.vulnerabilities.high = 0;
    expect(() =>
      normalizePnpmAudit(bad, pnpmDependencyGraph(lock()), '.', true),
    ).toThrow(/count/);
    expect(() =>
      normalizePnpmAudit(
        { advisories: {} },
        pnpmDependencyGraph(lock()),
        '.',
        true,
      ),
    ).toThrow();
  });

  it('rejects a missing dependency snapshot instead of dropping it from production', () => {
    const bad = lock();
    delete (bad.snapshots as Record<string, unknown>)['peer@2.0.0'];
    expect(() => pnpmDependencyGraph(bad).closure('.', true)).toThrow(
      /Unresolved dependency/,
    );
  });

  it('follows workspace links but excludes that workspace development dependencies', () => {
    const linked = lock();
    (linked.importers['.'].dependencies as Record<string, unknown>).sdk = {
      version: 'link:packages/sdk',
    };
    const graph = pnpmDependencyGraph(linked);
    expect(graph.closure('.', true).has('lib@2.0.0')).toBe(true);
    (linked.importers['.'].dependencies as Record<string, unknown>).sdk = {
      version: 'link:../other',
    };
    expect(() => pnpmDependencyGraph(linked).closure('.', true)).toThrow(
      /Escaping/,
    );
  });
});

describe('pnpm workspace-wide root audit coverage', () => {
  it('includes a vulnerable production dependency owned only by an unlinked CLI workspace', () => {
    const graph = pnpmDependencyGraph({
      importers: {
        '.': {},
        'packages/cli': {
          dependencies: { native: { version: '1.0.0' } },
          devDependencies: { tool: { version: '1.0.0' } },
        },
      },
      packages: { 'native@1.0.0': {}, 'tool@1.0.0': {} },
      snapshots: { 'native@1.0.0': {}, 'tool@1.0.0': {} },
    });
    const raw = {
      advisories: {
        issue: {
          module_name: 'native',
          severity: 'high',
          github_advisory_id: 'GHSA-abcd-1234-5678',
          findings: [{ version: '1.0.0', paths: ['packages/cli>native'] }],
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      },
    };
    expect(
      normalizePnpmAudit(raw, graph, '.', true).audit.metadata.vulnerabilities
        .high,
    ).toBe(1);
  });
});

describe('portable pnpm importer paths', () => {
  it.each([
    'C:\\outside',
    'packages\\..\\..\\outside',
    '//server/share',
    'D:outside',
  ])(
    'refuses native absolute or traversal spelling %s before filesystem reads',
    (importer) => {
      expect(() =>
        pnpmDependencyGraph({
          importers: { [importer]: {} },
          packages: {},
          snapshots: {},
        }),
      ).toThrow(/Invalid pnpm importer/);
      expect(() => pnpmImporterManifest('/fixture', importer)).toThrow(
        /Invalid importer path/,
      );
    },
  );
});

it('rejects an absolute link before POSIX join can disguise it as a nested relative path', () => {
  const graph = pnpmDependencyGraph({
    importers: {
      '.': {},
      'packages/cli': {
        dependencies: { outside: { version: 'link:/outside' } },
      },
      'packages/cli/outside': {},
    },
    packages: {},
    snapshots: {},
  });
  expect(() => graph.closure('packages/cli')).toThrow(
    /Escaping workspace link/,
  );
});

it('treats a package named constructor as data in advisory projection', () => {
  const graph = pnpmDependencyGraph({
    importers: { '.': { dependencies: { constructor: { version: '1.0.0' } } } },
    packages: { 'constructor@1.0.0': {} },
    snapshots: { 'constructor@1.0.0': {} },
  });
  const raw = {
    advisories: {
      one: {
        module_name: 'constructor',
        severity: 'high',
        github_advisory_id: 'GHSA-abcd-1234-5678',
        findings: [{ version: '1.0.0', paths: ['.>constructor'] }],
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
    },
  };
  expect(
    normalizePnpmAudit(raw, graph, '.', true).audit.metadata.vulnerabilities
      .high,
  ).toBe(1);
});
