import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs';
import {
  evaluateAuditPolicy,
  runPolicyCli,
} from '../dependency-advisory-policy.mjs';

const makeTempDir = trackTempDirs();
const nodeVersion = process.versions.node;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const source = 'reviewed source formatter';
const minified = 'reviewed minified formatter';
const patch = 'reviewed package patch\n';

function fixture(name: 'sprintf-js' | 'node-forge' = 'sprintf-js') {
  const forge = name === 'node-forge';
  const version = forge ? '1.4.0' : '1.0.3';
  const advisory = forge ? 'GHSA-86w9-cpqp-85rv' : 'GHSA-hp3w-g68c-fv3c';
  const severity = forge ? 'high' : 'moderate';
  const files = forge
    ? [
        'lib/index.js',
        'lib/rsa.js',
        'dist/forge.min.js',
        'dist/forge.all.min.js',
      ]
    : ['src/sprintf.js', 'dist/sprintf.min.js'];
  const root = makeTempDir('station-patch-binding-');
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const patchHash = hash(patch);
  const pkg = `${name}@${version}(patch_hash=${patchHash})`;
  const lock = {
    lockfileVersion: '9.0',
    patchedDependencies: { [`${name}@${version}`]: patchHash },
    importers: {
      '.': {
        dependencies: { argparse: { specifier: '1.0.10', version: '1.0.10' } },
      },
    },
    packages: { 'argparse@1.0.10': {}, [`${name}@${version}`]: {} },
    snapshots: {
      'argparse@1.0.10': {
        dependencies: { [name]: `${version}(patch_hash=${patchHash})` },
      },
      [pkg]: {},
    },
  };
  write('pnpm-lock.yaml', JSON.stringify(lock));
  write(
    'pnpm-workspace.yaml',
    JSON.stringify({
      nodeLinker: 'hoisted',
      patchedDependencies: { [`${name}@${version}`]: 'patches/sprintf.patch' },
    }),
  );
  write('patches/sprintf.patch', patch);
  write(
    'node_modules/argparse/package.json',
    JSON.stringify({ name: 'argparse', version: '1.0.10' }),
  );
  write(
    `node_modules/${name}/package.json`,
    JSON.stringify({
      name,
      version,
      main: files[0],
      ...(forge
        ? { browser: { buffer: false, crypto: false, process: false } }
        : {}),
    }),
  );
  for (const file of files)
    write(
      `node_modules/${name}/${file}`,
      file.startsWith('dist/') ? minified : source,
    );
  const residual = {
    scope: 'root',
    package: name,
    version,
    advisory,
    severity,
    reachability: 'production',
    owner: 'station-maintainers',
    disposition: 'Reviewed local patch',
    controls: 'Exact machine binding',
    trackingUrl: 'https://github.com/kontourai/station/pull/3445',
    expires: '2026-10-13',
    recheckTrigger: 'No automatic renewal',
    patchBinding: {
      schemaVersion: 1,
      package: name,
      version,
      patchPath: 'patches/sprintf.patch',
      patchSha256: patchHash,
      nodeMajor: 24,
      installedEntrypoints: files.map((file) => ({
        path: `node_modules/${name}/${file}`,
        sha256: hash(file.startsWith('dist/') ? minified : source),
      })),
    },
  };
  const remediation = {
    scope: residual.scope,
    package: name,
    version,
    advisory,
    severity,
    owner: residual.owner,
    reason: 'Reviewed RSA repair',
    trackingIssue: 'https://github.com/kontourai/station/issues/3122',
    patchBinding: residual.patchBinding,
  };
  const config = {
    version: 2,
    exceptions: [],
    residuals: forge ? [] : [residual],
    remediations: forge ? [remediation] : [],
  };
  write('scripts/dependency-advisory-exceptions.json', JSON.stringify(config));
  const audit = {
    scope: 'root',
    reachability: 'production',
    resolvedVersions: { [pkg]: version },
    audit: {
      auditReportVersion: 2,
      vulnerabilities: {
        [name]: {
          name,
          severity,
          nodes: [pkg],
          via: [
            {
              name,
              severity,
              url: `https://github.com/advisories/${advisory}`,
            },
          ],
        },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: forge ? 0 : 1,
          high: forge ? 1 : 0,
          critical: 0,
          total: 1,
        },
      },
    },
  };
  const evaluate = () =>
    evaluateAuditPolicy([audit], config, {
      root,
      now: new Date('2026-10-06T00:00:00Z'),
    });
  return { root, write, lock, residual, remediation, config, audit, evaluate };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process.versions, 'node', { value: nodeVersion });
});

describe('machine-bound production residual acceptance', () => {
  it('reaches real file verification through the audit CLI and refuses changed bytes on the next decision', async () => {
    const f = fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = async () => {
      log.mockClear();
      const status = await runPolicyCli({
        root: f.root,
        decide: () => ({
          required: true,
          scopes: ['root'],
          reason: 'fixture',
          range: null,
        }),
        runAudits: async () => [f.audit],
      });
      return { status, report: log.mock.calls.flat().join('\n') };
    };
    const good = await run();
    expect(good.status, `good decision:\n${good.report}`).toBe(0);
    f.write(
      'node_modules/sprintf-js/dist/sprintf.min.js',
      'pristine vulnerable formatter',
    );
    const bad = await run();
    expect(bad.status, `bad-byte decision:\n${bad.report}`).toBe(1);
    expect(bad.report).toContain('installed entrypoint bytes changed');
    f.write('node_modules/sprintf-js/dist/sprintf.min.js', minified);
    const restored = await run();
    expect(restored.status, `restored decision:\n${restored.report}`).toBe(0);
  });

  it('refuses an expired residual through the real audit CLI with valid machine-bound bytes', async () => {
    const f = fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const status = await runPolicyCli({
      root: f.root,
      decide: () => ({
        required: true,
        scopes: ['root'],
        reason: 'fixture expiry control',
        range: null,
      }),
      runAudits: async () => [f.audit],
    });
    const report = log.mock.calls.flat().join('\n');
    expect(status, `expiry decision:\n${report}`).toBe(1);
    expect(
      report.split('\n').filter((line) => line.startsWith('EXCEPTION ERROR:')),
    ).toEqual(['EXCEPTION ERROR: residual 1 is expired (2026-10-13)']);
    expect(report).not.toContain('patch binding refused');
  });

  it.each([
    [
      'patch bytes',
      (f: ReturnType<typeof fixture>) =>
        f.write('patches/sprintf.patch', 'changed patch'),
    ],
    [
      'workspace binding',
      (f: ReturnType<typeof fixture>) =>
        f.write(
          'pnpm-workspace.yaml',
          JSON.stringify({ nodeLinker: 'hoisted', patchedDependencies: {} }),
        ),
    ],
    [
      'lock hash',
      (f: ReturnType<typeof fixture>) => {
        f.lock.patchedDependencies['sprintf-js@1.0.3'] = '0'.repeat(64);
        f.write('pnpm-lock.yaml', JSON.stringify(f.lock));
      },
    ],
    [
      'snapshot edge',
      (f: ReturnType<typeof fixture>) => {
        f.lock.snapshots['argparse@1.0.10'].dependencies['sprintf-js'] =
          '1.0.3';
        f.write('pnpm-lock.yaml', JSON.stringify(f.lock));
      },
    ],
    [
      'source bytes',
      (f: ReturnType<typeof fixture>) =>
        f.write(
          'node_modules/sprintf-js/src/sprintf.js',
          'pristine vulnerable formatter',
        ),
    ],
    [
      'minified bytes',
      (f: ReturnType<typeof fixture>) =>
        f.write(
          'node_modules/sprintf-js/dist/sprintf.min.js',
          'pristine vulnerable formatter',
        ),
    ],
    [
      'missing evidence file',
      (f: ReturnType<typeof fixture>) =>
        rmSync(join(f.root, 'node_modules/sprintf-js/dist/sprintf.min.js')),
    ],
    [
      'unaccounted copy',
      (f: ReturnType<typeof fixture>) => {
        f.write(
          'node_modules/argparse/node_modules/sprintf-js/package.json',
          JSON.stringify({
            name: 'sprintf-js',
            version: '1.0.3',
            main: 'src/sprintf.js',
          }),
        );
        f.write(
          'node_modules/argparse/node_modules/sprintf-js/src/sprintf.js',
          source,
        );
        f.write(
          'node_modules/argparse/node_modules/sprintf-js/dist/sprintf.min.js',
          minified,
        );
      },
    ],
    [
      'caller-directory shadow copy',
      (f: ReturnType<typeof fixture>) => {
        const caller = 'node_modules/argparse/lib/help/formatter.js';
        const copy = 'node_modules/argparse/lib/help/node_modules/sprintf-js';
        f.write(caller, 'module.exports = require("sprintf-js");');
        f.write(
          copy + '/package.json',
          JSON.stringify({
            name: 'sprintf-js',
            version: '1.0.3',
            main: 'src/sprintf.js',
          }),
        );
        f.write(copy + '/src/sprintf.js', 'unpatched caller shadow');
        f.write(copy + '/dist/sprintf.min.js', 'unpatched caller shadow');
        expect(createRequire(join(f.root, caller)).resolve('sprintf-js')).toBe(
          realpathSync(join(f.root, copy, 'src/sprintf.js')),
        );
      },
    ],
    [
      'package identity',
      (f: ReturnType<typeof fixture>) =>
        f.write(
          'node_modules/sprintf-js/package.json',
          JSON.stringify({
            name: 'unbound-package',
            version: '1.0.3',
            main: 'src/sprintf.js',
          }),
        ),
    ],
  ])(
    'keeps the exact production finding red after %s drift, then passes after restoration',
    (_name, mutate) => {
      const f = fixture();
      expect(f.evaluate().ok).toBe(true);
      const originals = new Map<string, Buffer>();
      for (const file of [
        'pnpm-workspace.yaml',
        'pnpm-lock.yaml',
        'patches/sprintf.patch',
        'node_modules/sprintf-js/package.json',
        'node_modules/sprintf-js/src/sprintf.js',
        'node_modules/sprintf-js/dist/sprintf.min.js',
      ])
        originals.set(file, readFileSync(join(f.root, file)));
      mutate(f);
      const result = f.evaluate();
      expect(result.ok).toBe(false);
      expect(result.trackedResiduals).toHaveLength(0);
      expect(result.untrackedResiduals).toHaveLength(1);
      expect(result.exceptionErrors.join(' ')).toMatch(
        /patch binding|ENOENT|Unresolved dependency/,
      );
      rmSync(join(f.root, 'node_modules/argparse/node_modules'), {
        recursive: true,
        force: true,
      });
      rmSync(join(f.root, 'node_modules/argparse/lib'), {
        recursive: true,
        force: true,
      });
      for (const [path, data] of originals) f.write(path, data.toString());
      expect(f.evaluate().ok).toBe(true);
    },
  );

  it('refuses a Node-resolvable formatter file shadow and restores acceptance after removal', () => {
    const f = fixture();
    const caller = 'node_modules/argparse/lib/help/formatter.js';
    const shadow = 'node_modules/argparse/lib/help/node_modules/sprintf-js.js';
    f.write(caller, 'module.exports = require("sprintf-js");');
    f.write(
      shadow,
      'module.exports = { sprintf: (format, value) => value.toFixed(101) };',
    );
    expect(createRequire(join(f.root, caller)).resolve('sprintf-js')).toBe(
      realpathSync(join(f.root, shadow)),
    );
    expect(f.evaluate().ok).toBe(false);
    rmSync(join(f.root, shadow));
    expect(f.evaluate().ok).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a formatter file symlink shadow at the real caller lookup',
    () => {
      const f = fixture();
      const caller = 'node_modules/argparse/lib/help/formatter.js';
      const target = 'node_modules/argparse/lib/unpatched.js';
      const shadow = 'node_modules/argparse/lib/help/node_modules/sprintf-js';
      f.write(caller, 'module.exports = require("sprintf-js");');
      f.write(
        target,
        'module.exports = { sprintf: (format, value) => value.toFixed(101) };',
      );
      mkdirSync(join(f.root, shadow, '..'), { recursive: true });
      symlinkSync(join(f.root, target), join(f.root, shadow), 'file');
      expect(createRequire(join(f.root, caller)).resolve('sprintf-js')).toBe(
        realpathSync(join(f.root, target)),
      );
      expect(f.evaluate().ok).toBe(false);
      rmSync(join(f.root, shadow));
      expect(f.evaluate().ok).toBe(true);
    },
  );

  it('traverses unrelated manifestless module directories without hiding formatter copies', () => {
    const f = fixture();
    f.write(
      'node_modules/argparse/lib/node_modules/@types/fixture/index.d.ts',
      'export type Name = string;',
    );
    expect(f.evaluate().ok).toBe(true);
  });

  it('refuses caller shadows through a case-equivalent module directory', ({
    skip,
  }) => {
    const f = fixture();
    f.write('case-probe', 'case-probe');
    if (!existsSync(join(f.root, 'CASE-PROBE'))) {
      skip();
      return;
    }
    const caller = 'node_modules/argparse/lib/help/formatter.js';
    const shadow = 'node_modules/argparse/lib/help/NODE_MODULES/sprintf-js';
    f.write(caller, 'module.exports = require("sprintf-js");');
    f.write(
      shadow + '/package.json',
      JSON.stringify({
        name: 'sprintf-js',
        version: '1.0.3',
        main: 'src/sprintf.js',
      }),
    );
    f.write(
      shadow + '/src/sprintf.js',
      'module.exports = { sprintf: (format, value) => value.toFixed(101) };',
    );
    f.write(shadow + '/dist/sprintf.min.js', 'unbound minified formatter');
    const resolved = createRequire(join(f.root, caller)).resolve('sprintf-js');
    const observed = statSync(resolved);
    const shadowFile = statSync(join(f.root, shadow, 'src/sprintf.js'));
    expect([observed.dev, observed.ino]).toEqual([
      shadowFile.dev,
      shadowFile.ino,
    ]);
    expect(f.evaluate().ok).toBe(false);
    rmSync(join(f.root, shadow), { recursive: true });
    expect(f.evaluate().ok).toBe(true);
  });

  it('does not accept another advisory on the same installed package', () => {
    const f = fixture();
    f.audit.audit.vulnerabilities['sprintf-js'].via.push({
      name: 'sprintf-js',
      severity: 'moderate',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    });
    const result = f.evaluate();
    expect(result.ok).toBe(false);
    expect(result.trackedResiduals).toHaveLength(1);
    expect(
      result.untrackedResiduals.map((finding) => finding.advisory),
    ).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('cannot fall back to identity-only acceptance when the binding is deleted', () => {
    const f = fixture();
    Reflect.deleteProperty(f.residual, 'patchBinding');
    expect(f.evaluate().ok).toBe(false);
    expect(f.evaluate().untrackedResiduals).toHaveLength(1);
  });

  it('refuses missing binding evidence, changed runtime and expired acceptance', () => {
    const f = fixture();
    f.residual.patchBinding.installedEntrypoints = [];
    expect(f.evaluate().ok).toBe(false);
    f.residual.patchBinding.installedEntrypoints = [
      { path: 'node_modules/sprintf-js/src/sprintf.js', sha256: hash(source) },
      {
        path: 'node_modules/sprintf-js/dist/sprintf.min.js',
        sha256: hash(minified),
      },
    ];
    Object.defineProperty(process.versions, 'node', { value: '25.0.0' });
    expect(f.evaluate().ok).toBe(false);
    Object.defineProperty(process.versions, 'node', { value: nodeVersion });
    f.residual.expires = '2026-10-06';
    expect(f.evaluate().ok).toBe(false);
  });

  it('accounts for every installed copy when all source and minified hashes are explicitly bound', () => {
    const f = fixture();
    const nested = 'node_modules/argparse/node_modules/sprintf-js';
    f.write(
      nested + '/package.json',
      JSON.stringify({
        name: 'sprintf-js',
        version: '1.0.3',
        main: 'src/sprintf.js',
      }),
    );
    f.write(nested + '/src/sprintf.js', source);
    f.write(nested + '/dist/sprintf.min.js', minified);
    f.residual.patchBinding.installedEntrypoints.push(
      { path: nested + '/src/sprintf.js', sha256: hash(source) },
      { path: nested + '/dist/sprintf.min.js', sha256: hash(minified) },
    );
    expect(f.evaluate().ok).toBe(true);
    f.write(nested + '/dist/sprintf.min.js', 'unpatched duplicate');
    expect(f.evaluate().ok).toBe(false);
  });
});

describe('machine-bound high-severity RSA remediation', () => {
  it('reports PATCHED through the audit CLI after the old acceptance deadline, and blocks changed installed bytes', async () => {
    const f = fixture('node-forge');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = async () => {
      log.mockClear();
      const status = await runPolicyCli({
        root: f.root,
        decide: () => ({
          required: true,
          scopes: ['root'],
          reason: 'RSA remediation',
          range: null,
        }),
        runAudits: async () => [f.audit],
      });
      return { status, report: log.mock.calls.flat().join('\n') };
    };
    const good = await run();
    expect(good.status, good.report).toBe(0);
    expect(good.report).toContain(
      'PATCHED root/production: node-forge@1.4.0 GHSA-86w9-cpqp-85rv (high; installed bytes verified)',
    );
    expect(good.report).not.toContain('ACCEPTED');
    f.write(
      'node_modules/node-forge/dist/forge.all.min.js',
      'unpatched bundle',
    );
    const bad = await run();
    expect(bad.status, bad.report).toBe(1);
    expect(bad.report).toContain('installed entrypoint bytes changed');
    f.write('node_modules/node-forge/dist/forge.all.min.js', minified);
    const restored = await run();
    expect(restored.status, restored.report).toBe(0);
  });

  it.each([
    ['lib/index.js', source],
    ['lib/rsa.js', source],
    ['dist/forge.min.js', minified],
    ['dist/forge.all.min.js', minified],
  ])('blocks %s drift and passes after exact restoration', (file, original) => {
    const f = fixture('node-forge');
    expect(f.evaluate().ok).toBe(true);
    f.write(`node_modules/node-forge/${file}`, 'unpatched code');
    const bad = f.evaluate();
    expect(bad.ok).toBe(false);
    expect(bad.blockingFindings).toHaveLength(1);
    expect(bad.patchedFindings).toHaveLength(0);
    f.write(`node_modules/node-forge/${file}`, original);
    expect(f.evaluate().ok).toBe(true);
  });

  it.each(['version', 'severity', 'advisory'] as const)(
    'does not remediate a different %s',
    (field) => {
      const f = fixture('node-forge');
      f.remediation[field] =
        field === 'version'
          ? '1.4.1'
          : field === 'severity'
            ? 'critical'
            : 'GHSA-aaaa-bbbb-cccc';
      expect(f.evaluate().ok).toBe(false);
      expect(f.evaluate().patchedFindings).toHaveLength(0);
    },
  );

  it('blocks missing patch evidence and an absent remediation rather than falling back to risk acceptance', () => {
    const f = fixture('node-forge');
    Reflect.deleteProperty(f.remediation, 'patchBinding');
    expect(f.evaluate().ok).toBe(false);
    f.config.remediations = [];
    expect(f.evaluate().blockingFindings).toHaveLength(1);
    expect(f.evaluate().ok).toBe(false);
  });

  it('refuses a new unaccounted installed Forge instance', () => {
    const f = fixture('node-forge');
    f.write(
      'node_modules/argparse/node_modules/node-forge/package.json',
      JSON.stringify({
        name: 'node-forge',
        version: '1.4.0',
        main: 'lib/index.js',
        browser: { buffer: false, crypto: false, process: false },
      }),
    );
    expect(f.evaluate().ok).toBe(false);
    expect(f.evaluate().exceptionErrors.join(' ')).toContain(
      'unaccounted installed copy',
    );
  });

  it('requires removing the remediation when the advisory disappears', () => {
    const f = fixture('node-forge');
    f.audit.audit.vulnerabilities = {};
    f.audit.audit.metadata.vulnerabilities.high = 0;
    f.audit.audit.metadata.vulnerabilities.total = 0;
    expect(f.evaluate().ok).toBe(false);
    expect(f.evaluate().exceptionErrors.join(' ')).toContain(
      'unused remediation',
    );
  });
});

describe('RSA remediation admission boundaries', () => {
  it('verifies both full and production views without lowering high severity', () => {
    const f = fixture('node-forge');
    const result = evaluateAuditPolicy(
      [{ ...f.audit, reachability: 'full' }, f.audit],
      f.config,
      { root: f.root },
    );
    expect(result.ok).toBe(true);
    expect(
      result.patchedFindings.map((finding) => [
        finding.reachability,
        finding.severity,
      ]),
    ).toEqual([
      ['full', 'high'],
      ['production', 'high'],
    ]);
  });

  it.each(['patches/sprintf.patch', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])(
    'blocks changed %s at the high-severity decision',
    (file) => {
      const f = fixture('node-forge');
      const original = readFileSync(join(f.root, file), 'utf8');
      f.write(file, file.endsWith('.patch') ? 'changed patch' : '{}');
      expect(f.evaluate().ok).toBe(false);
      expect(f.evaluate().blockingFindings).toHaveLength(1);
      f.write(file, original);
      expect(f.evaluate().ok).toBe(true);
    },
  );

  it('rejects duplicate remediations and unrelated schema fields', () => {
    const f = fixture('node-forge');
    f.config.remediations.push(f.remediation);
    expect(f.evaluate().ok).toBe(false);
    f.config.remediations.pop();
    Object.assign(f.remediation, { acceptAllVersions: true });
    expect(f.evaluate().ok).toBe(false);
    Reflect.deleteProperty(f.remediation, 'acceptAllVersions');
    expect(f.evaluate().ok).toBe(true);
  });

  it('does not remediate another advisory on Forge', () => {
    const f = fixture('node-forge');
    f.audit.audit.vulnerabilities['node-forge'].via.push({
      name: 'node-forge',
      severity: 'high',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    });
    const result = f.evaluate();
    expect(result.ok).toBe(false);
    expect(result.patchedFindings).toHaveLength(1);
    expect(result.blockingFindings.map((finding) => finding.advisory)).toEqual([
      'GHSA-aaaa-bbbb-cccc',
    ]);
  });
});
