import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveNpmCli } from '../../../../scripts/dependency-lifecycle.mjs';
import { sanitizedGitEnvironment } from '../../../../scripts/lib/git-environment.mjs';
import {
  assertCommandAvailable,
  CONTRIBUTOR_COMMANDS,
  contributorCommandMessage,
} from '../distribution.js';

/**
 * The published CLI, exercised as the artifact a stranger actually gets.
 *
 * Nothing in the suite used to run the CLI as anything other than an in-repo
 * TypeScript module, so every packaging assumption — `bin` resolving without
 * `tsx`, no `src-server` in the tarball, no raw `.ts` reaching the runtime —
 * was unenforced. That is the same class of defect the publish-surface
 * contract was written for, and `docs/design/cli-product.md` names an
 * install-the-tarball test as the one thing the bundling slice must not ship
 * without.
 *
 * So these tests `npm pack` the package (which rebuilds the bundle through
 * `prepack`), unpack the tarball somewhere else, and run *that* file with a
 * bare `node` from a working directory outside the checkout. What they cannot
 * cover offline is npm's own resolution of the tarball's declared
 * dependencies; the PR carries a full `npm i <tgz>` transcript for that.
 *
 * The weight of that install is part of the contract, not an afterthought:
 * `perf/cli-bundle-weight` took the package from 13.2 MB installed to 632 kB
 * by making esbuild an optional peer and dropping the sourcemap, so the checks
 * below pin both halves — nothing may be statically imported that npm would
 * not install, and an optional peer must still work when it is present.
 */

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8'),
) as {
  version: string;
  bin: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

/**
 * Everything npm would install for a consumer of the tarball: real
 * dependencies plus non-optional peers. An *optional* peer is deliberately
 * absent — nothing may be statically imported from one.
 */
const installedForConsumers = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
  ),
]);

const optionalPeers = new Set(
  Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) => manifest.peerDependenciesMeta?.[name]?.optional === true,
  ),
);

let packedRoot: string;
let packedFiles: string[];
let packedBin: string;
let bundleSource: string;
let packedTarball: string;
let packedTarballSha256: string;

/**
 * The bundle's module specifiers, split by how they are reached.
 *
 * Parsed with the TypeScript scanner rather than a regex: the published bundle
 * is minified, so `import{x}from"y"` has no whitespace for a `^import\s` regex
 * to anchor on and the old pattern would have matched nothing at all — passing
 * vacuously while an undeclared runtime import shipped. A real parse cannot
 * degrade that way.
 */
function bundleSpecifiers(source: string): {
  static: string[];
  dynamic: string[];
} {
  const file = ts.createSourceFile(
    'station.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const statics = new Set<string>();
  const dynamics = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        statics.add(specifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      dynamics.add(
        argument && ts.isStringLiteralLike(argument)
          ? argument.text
          : '<computed>',
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { static: [...statics], dynamic: [...dynamics] };
}

/**
 * Run the packed bundle exactly as an installed `station` would be run: from a
 * directory that is not the repo, so anything silently depending on the
 * checkout's `node_modules` or `cwd` fails here instead of on a user's machine.
 */
function runBundle(
  args: string[],
  cwd: string = tmpdir(),
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [packedBin, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    // No Station instance is running in unit tests; every network verb below
    // must fail fast rather than hang out its default timeout.
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Symlink one of the repo's installed packages into the unpacked tarball. */
function linkIntoPackedTree(name: string): void {
  const repoRoot = resolve(packageDir, '..', '..');
  const link = join(packedRoot, 'package', 'node_modules', name);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(repoRoot, 'node_modules', name), link, 'dir');
}

/**
 * A plugin the bundled builder can build without a network: `plugin.json` plus
 * an entrypoint and, deliberately, no `package.json` — which is the one
 * condition under which `ensurePluginDeps` skips its `npm install`.
 */
function scaffoldBuildablePlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-cli-plugin-'));
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      name: 'bundle-test-plugin',
      version: '0.0.0',
      entrypoint: 'index.js',
    }),
  );
  writeFileSync(join(dir, 'index.js'), 'export const hello = () => 1;\n');
  return dir;
}

describe('published CLI bundle', () => {
  beforeAll(() => {
    packedRoot = mkdtempSync(join(tmpdir(), 'station-cli-pack-'));
    // Focused tests deliberately run with npm lifecycle scripts disabled.
    // Build the package artifact explicitly, then pack that exact output once;
    // the consumer proof below hashes and installs this same tarball.
    execFileSync(process.execPath, ['esbuild.config.mjs'], {
      cwd: packageDir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
    });
    const packed = JSON.parse(
      execFileSync(
        process.execPath,
        [resolveNpmCli(), 'pack', '--json', '--pack-destination', packedRoot],
        {
          cwd: packageDir,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 120_000,
        },
      ),
    )[0] as { filename: string; files: { path: string }[] };
    packedFiles = packed.files.map((file) => file.path);
    packedTarball = join(packedRoot, packed.filename);
    packedTarballSha256 = createHash('sha256')
      .update(readFileSync(packedTarball))
      .digest('hex');
    execFileSync('tar', ['-xzf', packedTarball], {
      cwd: packedRoot,
      windowsHide: true,
      timeout: 30_000,
    });
    packedBin = join(packedRoot, 'package', 'dist', 'station.mjs');
    bundleSource = readFileSync(packedBin, 'utf8');

    // Stand up the installed layout offline: exactly what npm would install
    // for a consumer, nothing else. An undeclared runtime import therefore
    // fails to resolve here — which is the whole point — while npm's own
    // registry resolution stays out of the unit suite. Optional peers are
    // deliberately *not* linked: this is the client-verb install.
    for (const dependency of installedForConsumers) {
      linkIntoPackedTree(dependency);
    }
  }, 300_000);

  afterAll(() => {
    if (packedRoot) rmSync(packedRoot, { recursive: true, force: true });
  });

  it('ships the bundle and nothing else', () => {
    expect(manifest.bin.station).toBe('./dist/station.mjs');
    expect(packedFiles).toContain('dist/station.mjs');
    expect(packedFiles.filter((file) => file.startsWith('src/'))).toEqual([]);
    expect(packedFiles.filter((file) => /\.tsx?$/.test(file))).toEqual([]);
    // The sourcemap is 2.2 MB — more than three times the bundle — and every
    // installer paid for it. It is still written next to the bundle for local
    // debugging; `files` must keep it out of the tarball.
    expect(packedFiles.filter((file) => /\.map$/.test(file))).toEqual([]);
    expect(bundleSource).not.toContain('sourceMappingURL');
    // npm adds package.json itself; every other member is an explicit
    // allowlist entry. An accidental source or server addition must fail here.
    expect([...packedFiles].sort()).toEqual(
      ['LICENSE', 'README.md', 'dist/station.mjs', 'package.json'].sort(),
    );
  });

  it('carries only the audited keyring and pairing QR dependencies', () => {
    // The keyring is the deliberately audited runtime dependency: a client
    // A saved Station credential must use the OS store rather than a plaintext file.
    // esbuild resolves a per-platform native binary from its own package
    // (~9.9 MB unpacked): three quarters of what `npm i -g` used to install,
    // for three plugin-authoring verbs. It is an optional peer, so npm skips
    // it, and `@kontourai/station-shared/build` loads it on demand.
    // Pairing offers render a terminal QR code; qrcode is the reviewed,
    // runtime-only encoder used by that command.
    expect(manifest.dependencies ?? {}).toEqual({
      '@napi-rs/keyring': '1.3.0',
      qrcode: '^1.5.4',
    });
    expect(optionalPeers).toContain('esbuild');
  });

  it('arrives executable with a node shebang', () => {
    // npm's bin shim symlinks straight at this file on POSIX, so the mode has
    // to survive the tarball.
    expect(statSync(packedBin).mode & 0o111).not.toBe(0);
    expect(bundleSource.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('statically imports nothing but builtins and always-installed packages', () => {
    const specifiers = bundleSpecifiers(bundleSource);
    // Sanity check on the parse itself: a scan that silently found nothing
    // would make every assertion below vacuous.
    expect(specifiers.static).toContain('node:fs');
    expect(
      specifiers.static.filter(
        (specifier) =>
          !isBuiltin(specifier) && !installedForConsumers.has(specifier),
      ),
    ).toEqual([]);
    // An optional peer may only be reached lazily — a static import of one
    // would crash `station --version` on a client-verb install.
    expect(
      specifiers.static.filter((specifier) => optionalPeers.has(specifier)),
    ).toEqual([]);
    // The workspace packages are inlined, not resolved: `station-connect` is
    // private, and `sdk`/`shared`/`contracts` publish raw TypeScript.
    expect(
      [...specifiers.static, ...specifiers.dynamic].filter((specifier) =>
        specifier.startsWith('@kontourai/'),
      ),
    ).toEqual([]);
  });

  it('reaches every optional peer through a lazy import()', () => {
    const specifiers = bundleSpecifiers(bundleSource);
    for (const peer of optionalPeers) {
      expect(specifiers.dynamic).toContain(peer);
    }
    // Nothing may be imported dynamically that is neither a builtin, an
    // always-installed package, nor a declared optional peer.
    expect(
      specifiers.dynamic.filter(
        (specifier) =>
          !isBuiltin(specifier) &&
          !installedForConsumers.has(specifier) &&
          !optionalPeers.has(specifier),
      ),
    ).toEqual([]);
  });

  it('resolves no TypeScript and inlines no server source', () => {
    expect(bundleSource).not.toMatch(/from\s+["'][^"']+\.tsx?["']/);
    // `src-server` legitimately appears as a *string* in contributor-tier
    // lifecycle code that inspects a checkout's directories. What must never
    // appear is server source inlined into the bundle — the class
    // `scripts/station-cli.ts` injects, which the published entry omits.
    expect(bundleSource).not.toContain('class EnvironmentSecurityService');
    // And per-module, from the build's own sourcemap: no bundled source may
    // live under src-server at all. A `../../../../src-server/...` deep
    // import once shipped two whole server modules in the published binary;
    // the class-name probe above cannot see that shape.
    // The tarball deliberately omits the map, but the prepack build that
    // produced this tarball wrote it beside the local dist output.
    const map = JSON.parse(
      readFileSync(join(packageDir, 'dist', 'station.mjs.map'), 'utf8'),
    ) as { sources: string[] };
    expect(map.sources.length).toBeGreaterThan(100);
    expect(
      map.sources.filter((source) => source.includes('src-server/')),
    ).toEqual([]);
  });

  it('reports its version without reading a package.json', () => {
    const result = runBundle(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`station ${manifest.version}`);
    expect(result.stdout).toMatch(/development [0-9a-f]{40}(?:-dirty)?/);
  });

  it('prints usage that discloses which verbs are missing', () => {
    const result = runBundle(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Station CLI (@kontourai/station-cli)');
    expect(result.stdout).toContain('Not available in the packaged client');
    expect(result.stdout).toContain(CONTRIBUTOR_COMMANDS.join(', '));
  });

  it('keeps guided-triage help available from the packed client', () => {
    const result = runBundle(['triage', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'station triage [--context-only] [--agent=codex|claude] [--problem=<text>] [--search-issues]',
    );
    expect(result.stdout).toContain('does not inspect local files');
  });

  it('runs a client verb that needs no checkout', () => {
    const result = runBundle(['stations', 'list']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('station stations add');
  });

  it('installs the one packed artifact as an isolated consumer without lifecycle scripts', () => {
    // This is intentionally distinct from the symlinked offline layout above:
    // npm resolves the tarball's own dependencies in a fresh consumer tree.
    // `--ignore-scripts` is mandatory — no dependency hook is authorized by
    // this client-package proof. Unlike the symlinked offline check above,
    // this exercises npm's independent dependency resolver.
    const consumer = mkdtempSync(join(tmpdir(), 'station-cli-consumer-'));
    const consumerHome = join(consumer, 'home');
    const consumerStationHome = join(consumer, 'station-home');
    const unrelatedCwd = join(consumer, 'unrelated-checkout');
    mkdirSync(unrelatedCwd, { recursive: true });
    execFileSync('git', ['init'], {
      cwd: unrelatedCwd,
      windowsHide: true,
      timeout: 10_000,
      env: sanitizedGitEnvironment(),
    });
    writeFileSync(
      join(unrelatedCwd, 'station-build.json'),
      JSON.stringify({ version: '999.999.999', sha: 'f'.repeat(40) }),
    );
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'station-cli-consumer-fixture', private: true }),
    );
    const env = {
      ...process.env,
      HOME: consumerHome,
      USERPROFILE: consumerHome,
      STATION_HOME: consumerStationHome,
      // #4401 owns the meaning of this root. Setting it here prevents a
      // consumer test from accidentally borrowing a developer's ambient root.
      STATION_ROOT: join(consumer, 'station-root'),
      npm_config_ignore_scripts: 'true',
    };
    try {
      expect(
        createHash('sha256').update(readFileSync(packedTarball)).digest('hex'),
      ).toBe(packedTarballSha256);
      execFileSync(
        process.execPath,
        [
          resolveNpmCli(),
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--no-package-lock',
          packedTarball,
        ],
        {
          cwd: consumer,
          encoding: 'utf8',
          env,
          windowsHide: true,
          timeout: 120_000,
        },
      );
      const installedBin = join(
        consumer,
        'node_modules',
        '@kontourai',
        'station-cli',
        'dist',
        'station.mjs',
      );
      expect(statSync(installedBin).isFile()).toBe(true);
      expect(
        createHash('sha256').update(readFileSync(packedTarball)).digest('hex'),
      ).toBe(packedTarballSha256);

      const refusalInvocations: Array<{
        args: string[];
        expectedStatus: number;
        expectedError?: string;
      }> = [
        { args: ['--help'], expectedStatus: 0 },
        { args: ['--version'], expectedStatus: 0 },
        { args: [], expectedStatus: 1 },
        { args: ['--inline'], expectedStatus: 1 },
        { args: ['--service'], expectedStatus: 1 },
        { args: ['--temp-home'], expectedStatus: 1 },
        {
          args: ['setup', '--name=x', 'local'],
          expectedStatus: 1,
          expectedError: 'Local Station setup starts and installs a backend',
        },
        { args: ['stop'], expectedStatus: 1 },
        { args: ['environment', '--verbose', 'show'], expectedStatus: 1 },
        {
          args: [
            'environment',
            '--api-base=http://127.0.0.1:1',
            'access',
            'approve',
          ],
          expectedStatus: 1,
        },
        {
          args: ['environment', 'peers', 'list'],
          expectedStatus: 1,
          expectedError: 'Environment security commands require',
        },
        { args: ['environment', 'offer'], expectedStatus: 1 },
      ];
      for (const {
        args,
        expectedStatus,
        expectedError,
      } of refusalInvocations) {
        const result = spawnSync(process.execPath, [installedBin, ...args], {
          cwd: unrelatedCwd,
          encoding: 'utf8',
          env,
          windowsHide: true,
          timeout: 30_000,
        });
        expect(result.status).toBe(expectedStatus);
        expect(`${result.stdout}${result.stderr}`).not.toContain('    at ');
        if (args[0] === '--version')
          expect(`${result.stdout}${result.stderr}`).not.toContain(
            '999.999.999',
          );
        if (expectedError)
          expect(`${result.stdout}${result.stderr}`).toContain(expectedError);
      }
      // Passive/refusal paths do not create a profile store or touch an
      // ambient home. Native-keyring behavior itself remains platform proof.
      expect(() => statSync(consumerStationHome)).toThrow();
      expect(() => statSync(env.STATION_ROOT)).toThrow();
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  }, 300_000);

  it('explains an unreachable Station instead of crashing', () => {
    const result = runBundle([
      'agents',
      'list',
      '--api-base=http://127.0.0.1:1',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Can't reach Station at http://127.0.0.1:1",
    );
    expect(result.stderr).not.toContain('    at ');
  });

  it('names the missing optional peer when a plugin build needs it', () => {
    const pluginDir = scaffoldBuildablePlugin();
    try {
      const result = runBundle(['plugin', 'build'], pluginDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('needs `esbuild`');
      expect(result.stderr).toContain('npm install -g esbuild');
      expect(result.stderr).not.toContain('    at ');
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('builds a plugin once the optional peer is installed', () => {
    // The other half of the trade: dropping esbuild from `dependencies` is
    // only defensible if the lazy `import()` actually resolves it when a user
    // installs it. Linking it into the unpacked tarball is the same resolution
    // a global `npm i -g esbuild` produces.
    const pluginDir = scaffoldBuildablePlugin();
    linkIntoPackedTree('esbuild');
    try {
      const result = runBundle(['plugin', 'build'], pluginDir);
      // esbuild's own build summary goes to stderr; a *failure* would not.
      expect(result.stderr).not.toContain('needs `esbuild`');
      expect(result.stderr).not.toContain('    at ');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('dist/bundle.js');
      expect(
        statSync(join(pluginDir, 'dist', 'bundle.js')).size,
      ).toBeGreaterThan(0);
    } finally {
      rmSync(join(packedRoot, 'package', 'node_modules', 'esbuild'), {
        force: true,
      });
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it.each([...CONTRIBUTOR_COMMANDS])(
    'refuses the contributor verb `%s` by naming ./station',
    (command) => {
      const result = runBundle([command]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`./station ${command}`);
      expect(result.stderr).not.toContain('    at ');
    },
  );

  it('still answers --help for a contributor verb', () => {
    const result = runBundle(['doctor', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('doctor');
  });

  it('refuses host-local environment verbs by naming ./station', () => {
    const result = runBundle(['environment', 'show']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'require the Station repository launcher (./station)',
    );
  });
});

describe('distribution tiers', () => {
  it('is a no-op when running from a checkout', () => {
    expect(
      (globalThis as { __STATION_CLI_BUNDLE__?: unknown })
        .__STATION_CLI_BUNDLE__,
    ).toBeUndefined();
    for (const command of CONTRIBUTOR_COMMANDS) {
      expect(() => assertCommandAvailable(command)).not.toThrow();
    }
  });

  it('names the exact command to rerun', () => {
    expect(contributorCommandMessage('start', ['--port=3242'])).toContain(
      './station start --port=3242',
    );
  });
});
