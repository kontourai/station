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
import { validateDependencyPatchBinding } from '../lib/dependency-patch-binding.mjs';

const makeTempDir = trackTempDirs();
const nodeVersion = process.versions.node;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const source = 'reviewed source';
const minified = 'reviewed minified bundle';
const patch = 'reviewed package patch\n';

function fixture() {
  const name = 'node-forge';
  const version = '1.4.0';
  const advisory = 'GHSA-86w9-cpqp-85rv';
  const severity = 'high';
  const files = [
    'lib/index.js',
    'lib/rsa.js',
    'dist/forge.min.js',
    'dist/forge.all.min.js',
  ];
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
      patchedDependencies: { [`${name}@${version}`]: 'patches/package.patch' },
    }),
  );
  write('patches/package.patch', patch);
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
      browser: { buffer: false, crypto: false, process: false },
    }),
  );
  for (const file of files)
    write(
      `node_modules/${name}/${file}`,
      file.startsWith('dist/') ? minified : source,
    );
  const patchBinding = {
    schemaVersion: 1,
    package: name,
    version,
    patchPath: 'patches/package.patch',
    patchSha256: patchHash,
    nodeMajor: 24,
    installedEntrypoints: files.map((file) => ({
      path: `node_modules/${name}/${file}`,
      sha256: hash(file.startsWith('dist/') ? minified : source),
    })),
  };
  const remediation = {
    scope: 'root',
    package: name,
    version,
    advisory,
    severity,
    owner: 'station-maintainers',
    reason: 'Reviewed RSA repair',
    trackingIssue: 'https://github.com/kontourai/station/issues/3122',
    patchBinding,
  };
  const config = {
    version: 2,
    exceptions: [],
    residuals: [],
    remediations: [remediation],
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
          moderate: 0,
          high: 1,
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
  return { root, write, lock, remediation, config, audit, evaluate };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process.versions, 'node', { value: nodeVersion });
});

describe('machine-bound high-severity RSA remediation', () => {
  it('reports PATCHED through the audit CLI after the old acceptance deadline, and blocks changed installed bytes', async () => {
    const f = fixture();
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
    const f = fixture();
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
      const f = fixture();
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
    const f = fixture();
    Reflect.deleteProperty(f.remediation, 'patchBinding');
    expect(f.evaluate().ok).toBe(false);
    f.config.remediations = [];
    expect(f.evaluate().blockingFindings).toHaveLength(1);
    expect(f.evaluate().ok).toBe(false);
  });

  it('refuses a new unaccounted installed Forge instance', () => {
    const f = fixture();
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
    const f = fixture();
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
    const f = fixture();
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

  it.each(['patches/package.patch', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])(
    'blocks changed %s at the high-severity decision',
    (file) => {
      const f = fixture();
      const original = readFileSync(join(f.root, file), 'utf8');
      f.write(file, file.endsWith('.patch') ? 'changed patch' : '{}');
      expect(f.evaluate().ok).toBe(false);
      expect(f.evaluate().blockingFindings).toHaveLength(1);
      f.write(file, original);
      expect(f.evaluate().ok).toBe(true);
    },
  );

  it('rejects duplicate remediations and unrelated schema fields', () => {
    const f = fixture();
    f.config.remediations.push(f.remediation);
    expect(f.evaluate().ok).toBe(false);
    f.config.remediations.pop();
    Object.assign(f.remediation, { acceptAllVersions: true });
    expect(f.evaluate().ok).toBe(false);
    Reflect.deleteProperty(f.remediation, 'acceptAllVersions');
    expect(f.evaluate().ok).toBe(true);
  });

  it('does not remediate another advisory on Forge', () => {
    const f = fixture();
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

// node-forge is the only identity the verifier admits, so every installed-tree
// control below runs through it.
describe('installed-tree verification, exercised through the node-forge remediation', () => {
  const forgeDir = 'node_modules/node-forge';
  const forgeManifest = JSON.stringify({
    name: 'node-forge',
    version: '1.4.0',
    main: 'lib/index.js',
    browser: { buffer: false, crypto: false, process: false },
  });
  const forgeFiles: ReadonlyArray<readonly [string, string]> = [
    ['lib/index.js', source],
    ['lib/rsa.js', source],
    ['dist/forge.min.js', minified],
    ['dist/forge.all.min.js', minified],
  ];
  const writeForgeCopy = (
    f: ReturnType<typeof fixture>,
    directory: string,
    override?: string,
  ) => {
    f.write(`${directory}/package.json`, forgeManifest);
    for (const [file, original] of forgeFiles)
      f.write(`${directory}/${file}`, override ?? original);
  };
  const expectBlocked = (f: ReturnType<typeof fixture>, message: RegExp) => {
    const result = f.evaluate();
    expect(result.ok).toBe(false);
    expect(result.patchedFindings).toHaveLength(0);
    expect(result.blockingFindings).toHaveLength(1);
    expect(result.exceptionErrors.join(' ')).toMatch(message);
  };

  it.each([
    [
      'patch bytes',
      /patch bytes changed/,
      (f: ReturnType<typeof fixture>) =>
        f.write('patches/package.patch', 'changed patch'),
    ],
    [
      'workspace binding',
      /workspace or lock binding mismatch/,
      (f: ReturnType<typeof fixture>) =>
        f.write(
          'pnpm-workspace.yaml',
          JSON.stringify({ nodeLinker: 'hoisted', patchedDependencies: {} }),
        ),
    ],
    [
      'lock hash',
      /workspace or lock binding mismatch/,
      (f: ReturnType<typeof fixture>) => {
        f.lock.patchedDependencies['node-forge@1.4.0'] = '0'.repeat(64);
        f.write('pnpm-lock.yaml', JSON.stringify(f.lock));
      },
    ],
    [
      'snapshot edge to an absent variant',
      /Unresolved dependency/,
      (f: ReturnType<typeof fixture>) => {
        f.lock.snapshots['argparse@1.0.10'].dependencies['node-forge'] =
          '1.4.0';
        f.write('pnpm-lock.yaml', JSON.stringify(f.lock));
      },
    ],
    [
      'snapshot edge to an unpatched variant',
      /unpatched or absent locked package/,
      (f: ReturnType<typeof fixture>) => {
        f.lock.snapshots['argparse@1.0.10'].dependencies['node-forge'] =
          '1.4.0';
        f.lock.snapshots['node-forge@1.4.0'] = {};
        f.write('pnpm-lock.yaml', JSON.stringify(f.lock));
      },
    ],
    [
      'development-only dangling edge',
      /Unresolved dependency/,
      (f: ReturnType<typeof fixture>) => {
        f.lock.importers['.'].devDependencies = {
          'node-forge': { specifier: '1.4.0', version: '1.4.0' },
        };
        f.write('pnpm-lock.yaml', JSON.stringify(f.lock));
      },
    ],
    [
      'missing evidence file',
      /ENOENT/,
      (f: ReturnType<typeof fixture>) =>
        rmSync(join(f.root, forgeDir, 'dist/forge.min.js')),
    ],
    [
      'unaccounted copy',
      /unaccounted installed copy or entrypoint/,
      (f: ReturnType<typeof fixture>) =>
        writeForgeCopy(f, 'node_modules/argparse/node_modules/node-forge'),
    ],
    [
      'caller-directory shadow copy',
      /unaccounted installed copy or entrypoint/,
      (f: ReturnType<typeof fixture>) => {
        const caller = 'node_modules/argparse/lib/help/formatter.js';
        const copy = 'node_modules/argparse/lib/help/node_modules/node-forge';
        f.write(caller, 'module.exports = require("node-forge");');
        writeForgeCopy(f, copy, 'unpatched caller shadow');
        expect(createRequire(join(f.root, caller)).resolve('node-forge')).toBe(
          realpathSync(join(f.root, copy, 'lib/index.js')),
        );
      },
    ],
    [
      'package identity',
      /installed package identity changed/,
      (f: ReturnType<typeof fixture>) =>
        f.write(
          `${forgeDir}/package.json`,
          JSON.stringify({
            name: 'unbound-package',
            version: '1.4.0',
            main: 'lib/index.js',
          }),
        ),
    ],
    [
      'runtime entrypoint contract',
      /runtime entrypoint contract changed/,
      (f: ReturnType<typeof fixture>) =>
        f.write(
          `${forgeDir}/package.json`,
          JSON.stringify({
            name: 'node-forge',
            version: '1.4.0',
            main: 'lib/index.js',
            browser: { buffer: true, crypto: false, process: false },
          }),
        ),
    ],
  ])(
    'keeps the high finding blocked after %s drift, then passes after restoration',
    (_name, message, mutate) => {
      const f = fixture();
      expect(f.evaluate().ok).toBe(true);
      const originals = new Map<string, Buffer>();
      for (const file of [
        'pnpm-workspace.yaml',
        'pnpm-lock.yaml',
        'patches/package.patch',
        `${forgeDir}/package.json`,
        ...forgeFiles.map(([file]) => `${forgeDir}/${file}`),
      ])
        originals.set(file, readFileSync(join(f.root, file)));
      mutate(f);
      expectBlocked(f, message);
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

  it('refuses a Node-resolvable file shadow and restores acceptance after removal', () => {
    const f = fixture();
    const caller = 'node_modules/argparse/lib/help/formatter.js';
    const shadow = 'node_modules/argparse/lib/help/node_modules/node-forge.js';
    f.write(caller, 'module.exports = require("node-forge");');
    f.write(shadow, 'module.exports = { unpatched: true };');
    expect(createRequire(join(f.root, caller)).resolve('node-forge')).toBe(
      realpathSync(join(f.root, shadow)),
    );
    expectBlocked(f, /unaccounted module file shadow/);
    rmSync(join(f.root, shadow));
    expect(f.evaluate().ok).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a file symlink shadow at the real caller lookup',
    () => {
      const f = fixture();
      const caller = 'node_modules/argparse/lib/help/formatter.js';
      const target = 'node_modules/argparse/lib/unpatched.js';
      const shadow = 'node_modules/argparse/lib/help/node_modules/node-forge';
      f.write(caller, 'module.exports = require("node-forge");');
      f.write(target, 'module.exports = { unpatched: true };');
      mkdirSync(join(f.root, shadow, '..'), { recursive: true });
      symlinkSync(join(f.root, target), join(f.root, shadow), 'file');
      expect(createRequire(join(f.root, caller)).resolve('node-forge')).toBe(
        realpathSync(join(f.root, target)),
      );
      expectBlocked(f, /unaccounted module file shadow|unaccounted linked/);
      rmSync(join(f.root, shadow));
      expect(f.evaluate().ok).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses any directory symlink under a module directory, because its target cannot be accounted',
    () => {
      const f = fixture();
      const vendor = 'node_modules/argparse/vendor/forge-copy';
      const link = 'node_modules/argparse/node_modules/forge-alias';
      writeForgeCopy(f, vendor, 'unpatched linked copy');
      mkdirSync(join(f.root, link, '..'), { recursive: true });
      symlinkSync(join(f.root, vendor), join(f.root, link), 'dir');
      expectBlocked(f, /unaccounted linked dependency/);
      rmSync(join(f.root, link));
      expect(f.evaluate().ok).toBe(true);
    },
  );

  it('traverses unrelated manifestless module directories without hiding copies', () => {
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
    const shadow = 'node_modules/argparse/lib/help/NODE_MODULES/node-forge';
    f.write(caller, 'module.exports = require("node-forge");');
    writeForgeCopy(f, shadow, 'unbound shadow');
    const resolved = createRequire(join(f.root, caller)).resolve('node-forge');
    const observed = statSync(resolved);
    const shadowFile = statSync(join(f.root, shadow, 'lib/index.js'));
    expect([observed.dev, observed.ino]).toEqual([
      shadowFile.dev,
      shadowFile.ino,
    ]);
    expectBlocked(f, /unaccounted installed copy or entrypoint/);
    rmSync(join(f.root, shadow), { recursive: true });
    expect(f.evaluate().ok).toBe(true);
  });

  it('accounts for every installed copy when all of their hashes are explicitly bound', () => {
    const f = fixture();
    const nested = 'node_modules/argparse/node_modules/node-forge';
    writeForgeCopy(f, nested);
    for (const [file, original] of forgeFiles)
      f.remediation.patchBinding.installedEntrypoints.push({
        path: `${nested}/${file}`,
        sha256: hash(file.startsWith('dist/') ? minified : original),
      });
    f.write(`${nested}/dist/forge.min.js`, source);
    expectBlocked(f, /installed entrypoint bytes changed/);
    f.write(`${nested}/dist/forge.min.js`, minified);
    expect(f.evaluate().ok).toBe(true);
  });

  it('refuses missing binding evidence and a changed Node runtime', () => {
    const f = fixture();
    const entries = f.remediation.patchBinding.installedEntrypoints;
    f.remediation.patchBinding.installedEntrypoints = [];
    expectBlocked(f, /missing entrypoint evidence/);
    f.remediation.patchBinding.installedEntrypoints = entries;
    expect(f.evaluate().ok).toBe(true);
    Object.defineProperty(process.versions, 'node', { value: '25.0.0' });
    expectBlocked(f, /runtime changed/);
  });

  it('refuses evidence for a file no installed copy accounts for', () => {
    const f = fixture();
    f.remediation.patchBinding.installedEntrypoints.push({
      path: `${forgeDir}/lib/extra.js`,
      sha256: hash(source),
    });
    expectBlocked(f, /unobserved entrypoint evidence/);
  });
});

describe('patch-binding admission', () => {
  const binding = fixture().remediation.patchBinding;
  const forge = {
    scope: 'root',
    package: 'node-forge',
    version: '1.4.0',
    advisory: 'GHSA-86w9-cpqp-85rv',
    severity: 'high',
    reachability: 'production',
    patchBinding: binding,
  };
  // The binding names the same package and version as its record, so only the
  // identity allow-list can refuse these.
  const retired = {
    ...forge,
    package: 'sprintf-js',
    version: '1.0.3',
    advisory: 'GHSA-hp3w-g68c-fv3c',
    severity: 'moderate',
    patchBinding: { ...binding, package: 'sprintf-js', version: '1.0.3' },
  };

  it('refuses an identity other than the reviewed node-forge pair', () => {
    expect(validateDependencyPatchBinding(forge)).toBe(binding);
    expect(() => validateDependencyPatchBinding(retired)).toThrow(
      /unsupported identity/,
    );
    for (const change of [
      { version: '1.4.1', patchBinding: { ...binding, version: '1.4.1' } },
      {
        package: 'node-forge-fork',
        patchBinding: { ...binding, package: 'node-forge-fork' },
      },
      { advisory: 'GHSA-aaaa-bbbb-cccc' },
      { severity: 'moderate' },
      { scope: 'full' },
    ])
      expect(
        () => validateDependencyPatchBinding({ ...forge, ...change }),
        JSON.stringify(change),
      ).toThrow(/unsupported identity/);
  });

  it('does not let a residual carry installed-byte evidence', () => {
    const f = fixture();
    f.config.remediations = [];
    f.config.residuals.push({
      ...retired,
      owner: 'station-maintainers',
      disposition: 'Reviewed local patch',
      controls: 'Exact machine binding',
      trackingUrl: 'https://github.com/kontourai/station/pull/3445',
      expires: '2026-12-31',
      recheckTrigger: 'No automatic renewal',
    } as never);
    const result = f.evaluate();
    expect(result.ok).toBe(false);
    expect(result.exceptionErrors.join(' ')).toContain(
      'unknown field: patchBinding',
    );
  });
});
