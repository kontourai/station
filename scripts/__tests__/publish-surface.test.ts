import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Publish-surface contract for the `@kontourai/station-*` workspace packages.
 *
 * These assertions exist because the external-consumer path was never actually
 * run before: `@kontourai/station-sdk` shipped an import of
 * `@kontourai/station-connect/health-probe` — a package that is neither a
 * declared dependency of the SDK nor published — which resolved only inside
 * this monorepo. A stranger installing the SDK tarball got an unresolvable
 * module. Everything below is a static check on package metadata and source
 * imports, so it costs nothing and catches that class of defect at the point
 * it is introduced.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagesDir = join(repoRoot, 'packages');

interface PackageInfo {
  dir: string;
  name: string;
  manifest: Record<string, any>;
  publishable: boolean;
}

const packages: PackageInfo[] = readdirSync(packagesDir)
  .filter((entry) => existsSync(join(packagesDir, entry, 'package.json')))
  .map((entry) => {
    const dir = join(packagesDir, entry);
    const manifest = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    ) as Record<string, any>;
    return {
      dir,
      name: manifest.name as string,
      manifest,
      publishable: manifest.private !== true,
    };
  });

const publishable = packages.filter((pkg) => pkg.publishable);
const privateNames = new Set(
  packages.filter((pkg) => !pkg.publishable).map((pkg) => pkg.name),
);

/**
 * Packages that ship a pre-bundled executable instead of raw `.ts` sources.
 * A NAMED allowlist, not a "ships zero .ts files" inference: inferring it
 * structurally would let any OTHER package's simply-broken `files`
 * allowlist (ships nothing parseable) pass the shipping-import check below
 * vacuously instead of failing loud.
 */
const BUNDLED_PACKAGES = new Set(['@kontourai/station-cli']);

const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));

const packedFilesCache = new Map<string, string[]>();

/**
 * The files npm would actually put in the tarball, straight from `npm pack`.
 * This is the package's own `files` allowlist (negations included) as npm
 * itself interprets it — never a hardcoded list, so adding a source file or
 * changing `files` cannot silently drop it out of the checks below.
 */
function packedFiles(pkg: PackageInfo): string[] {
  const cached = packedFilesCache.get(pkg.dir);
  if (cached) return cached;
  const listing = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkg.dir,
    encoding: 'utf8',
  });
  const files: string[] = JSON.parse(listing)[0].files.map(
    (file: { path: string }) => file.path,
  );
  packedFilesCache.set(pkg.dir, files);
  return files;
}

/** Shipping TypeScript modules: the tarball's own contents, tests excluded. */
function shippingModules(pkg: PackageInfo): string[] {
  return packedFiles(pkg).filter(
    (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
  );
}

interface Specifier {
  /** Package-relative path of the importing file, e.g. `src/build.ts`. */
  file: string;
  line: number;
  value: string;
}

/**
 * Every module specifier a shipping file resolves at load or type time —
 * `import`/`export ... from`, side-effect `import`, `import()`, `import type`,
 * and `require()`. Parsed with the TypeScript scanner rather than a regex, so
 * a string literal that merely contains the word `from`, or a `require(...)`
 * call written inside a template literal (esbuild's runtime shim in
 * `packages/shared/src/build.ts` does exactly that), is not mistaken for a
 * real dependency edge.
 */
function shippingSpecifiers(pkg: PackageInfo): Specifier[] {
  const found: Specifier[] = [];
  for (const file of shippingModules(pkg)) {
    const absolute = join(pkg.dir, file);
    if (!existsSync(absolute)) continue;
    const source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const record = (node: ts.Node | undefined): void => {
      if (!node || !ts.isStringLiteralLike(node)) return;
      found.push({
        file,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        value: node.text,
      });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        record(node.moduleSpecifier);
      } else if (ts.isImportTypeNode(node)) {
        if (ts.isLiteralTypeNode(node.argument)) record(node.argument.literal);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isRequire =
          ts.isIdentifier(callee) && callee.escapedText === 'require';
        const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        if (isRequire || isDynamicImport) record(node.arguments[0]);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        record(node.moduleReference.expression);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** Root package name of a bare specifier (`@scope/pkg/sub` -> `@scope/pkg`). */
function rootPackageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0];
}

/** Subpath of a bare specifier, `.` when the specifier is the bare root. */
function subpathOf(specifier: string): string {
  const rest = specifier.slice(rootPackageName(specifier).length);
  return rest === '' ? '.' : `.${rest}`;
}

/** Whether a package's `exports` map declares `subpath`, honouring `*`. */
function exportsSubpath(
  manifest: Record<string, any>,
  subpath: string,
): boolean {
  const map = manifest.exports;
  if (map === undefined) return true; // no exports map: node resolves by path
  if (typeof map === 'string') return subpath === '.';
  return Object.keys(map).some((key) => {
    if (!key.startsWith('.')) return false; // conditions object, not a subpath map
    if (!key.includes('*')) return key === subpath;
    const [before, after] = key.split('*');
    return (
      subpath.length >= before.length + after.length &&
      subpath.startsWith(before) &&
      subpath.endsWith(after)
    );
  });
}

/** Bare module specifiers imported by a package's shipping source. */
function externalImports(pkg: PackageInfo): Map<string, string> {
  const found = new Map<string, string>();
  for (const { file, value } of shippingSpecifiers(pkg)) {
    if (value.startsWith('.') || isBuiltin(value)) continue;
    const packageName = rootPackageName(value);
    if (!found.has(packageName)) {
      found.set(packageName, relative(repoRoot, join(pkg.dir, file)));
    }
  }
  return found;
}

describe('publish surface', () => {
  it('has at least one publishable and one private package', () => {
    expect(publishable.length).toBeGreaterThan(0);
    expect(privateNames.size).toBeGreaterThan(0);
  });

  it('declares a contracts release floor that contains every Workspace Pane SDK subpath', () => {
    const contracts = byName.get('@kontourai/station-contracts');
    const sdk = byName.get('@kontourai/station-sdk');
    expect(contracts).toBeDefined();
    expect(sdk).toBeDefined();
    expect(sdk!.manifest.dependencies['@kontourai/station-contracts']).toBe(
      `^${contracts!.manifest.version}`,
    );

    const requiredSubpaths = [
      './workspace-pane',
      './workspace-pane-availability',
      './workspace-pane-layout-adapter',
      './workspace-file-preview',
      './workspace-browser-preview',
    ];
    const packed = new Set(packedFiles(contracts!));
    for (const subpath of requiredSubpaths) {
      const target = contracts!.manifest.exports[subpath] as string | undefined;
      expect(target, `${subpath} must be exported`).toBeTruthy();
      expect(
        packed.has(target!.replace(/^\.\//, '')),
        `${subpath} must ship in the declared minimum contracts tarball`,
      ).toBe(true);
    }
  });

  for (const pkg of publishable) {
    describe(pkg.name, () => {
      it('declares every package it imports', () => {
        const declared = new Set([
          ...Object.keys(pkg.manifest.dependencies ?? {}),
          ...Object.keys(pkg.manifest.peerDependencies ?? {}),
          ...Object.keys(pkg.manifest.optionalDependencies ?? {}),
        ]);
        const undeclared = [...externalImports(pkg)]
          .filter(([name]) => !declared.has(name))
          .map(([name, file]) => `${name} (imported by ${file})`);
        expect(undeclared).toEqual([]);
      });

      it('does not depend on a private workspace package', () => {
        const deps = [
          ...Object.keys(pkg.manifest.dependencies ?? {}),
          ...Object.keys(pkg.manifest.peerDependencies ?? {}),
          ...externalImports(pkg).keys(),
        ];
        expect(deps.filter((dep) => privateNames.has(dep))).toEqual([]);
      });

      it('carries the metadata npm consumers need', () => {
        expect(pkg.manifest.license).toBeTruthy();
        expect(pkg.manifest.author).toBeTruthy();
        expect(pkg.manifest.repository?.url).toContain('kontourai/station');
        expect(pkg.manifest.publishConfig?.access).toBe('public');
        expect(existsSync(join(pkg.dir, 'LICENSE'))).toBe(true);
        expect(existsSync(join(pkg.dir, 'README.md'))).toBe(true);
      });

      it('resolves every shipping import from the tarball alone', () => {
        const shipping = shippingModules(pkg);
        if (BUNDLED_PACKAGES.has(pkg.name)) {
          // A tarball with no shipped `.ts`/`.tsx` module (packages/cli:
          // it ships one pre-bundled `dist/station.mjs`) has no import
          // specifier left to parse — bundling already resolved every
          // import at build time. The equivalent guarantee for a bundled
          // package is asserted below, against the bundler's own
          // `external` list, in the dedicated bundled-package describe
          // block. Asserted here too, the other direction: if this package
          // starts shipping `.ts` again, that is drift this allowlist and
          // this check must both be updated for together, not silently
          // absorbed.
          expect(shipping.length).toBe(0);
          return;
        }
        expect(shipping.length).toBeGreaterThan(0);
        const declared = new Set([
          ...Object.keys(pkg.manifest.dependencies ?? {}),
          ...Object.keys(pkg.manifest.peerDependencies ?? {}),
          ...Object.keys(pkg.manifest.optionalDependencies ?? {}),
        ]);

        const violations: string[] = [];
        const at = (spec: Specifier, reason: string) =>
          violations.push(
            `${relative(repoRoot, pkg.dir)}/${spec.file}:${spec.line} imports '${spec.value}' — ${reason}`,
          );

        for (const spec of shippingSpecifiers(pkg)) {
          if (spec.value.startsWith('.')) {
            // (a) a relative path that climbs out of the package root resolves
            // only because siblings share a monorepo checkout.
            const target = resolve(
              dirname(join(pkg.dir, spec.file)),
              spec.value,
            );
            if (target !== pkg.dir && !target.startsWith(`${pkg.dir}${sep}`)) {
              at(
                spec,
                `a relative path that escapes the package root (resolves to ${relative(repoRoot, target)}, outside ${relative(repoRoot, pkg.dir)})`,
              );
            }
            continue;
          }
          if (isBuiltin(spec.value)) continue;

          const target = rootPackageName(spec.value);
          const subpath = subpathOf(spec.value);
          const workspace = byName.get(target);

          if (target !== pkg.name && !declared.has(target)) {
            // (b) devDependencies deliberately do not count: they are not
            // installed for a consumer of the tarball.
            at(
              spec,
              `'${target}' is not in this package's dependencies or peerDependencies`,
            );
            continue;
          }
          if (workspace && !workspace.publishable) {
            // (c) a private workspace package is never on the registry.
            at(spec, `'${target}' is a private, unpublished workspace package`);
            continue;
          }
          if (
            workspace &&
            subpath !== '.' &&
            !exportsSubpath(workspace.manifest, subpath)
          ) {
            // (d) an undeclared subpath resolves in a workspace symlink but is
            // blocked by the target's `exports` map once installed.
            at(
              spec,
              `'${target}' does not declare the subpath '${subpath}' in its exports map`,
            );
          }
        }

        expect(violations).toEqual([]);
      });

      it('ships no tests, configs, or fixtures in its tarball', () => {
        const files = packedFiles(pkg);
        expect(files.length).toBeGreaterThan(0);
        const leaked = files.filter(
          (file) =>
            /(^|\/)__tests__\//.test(file) ||
            /\.test\.tsx?$/.test(file) ||
            /^tsconfig.*\.json$/.test(file) ||
            /^vitest\.config\./.test(file) ||
            /\.(pem|key|crt)$/.test(file),
        );
        expect(leaked).toEqual([]);
      });
    });
  }

  describe('@kontourai/station-cli (bundled entrypoint)', () => {
    const cli = byName.get('@kontourai/station-cli');

    it('is publishable and ships a pre-bundled entrypoint, not raw source', async () => {
      expect(cli).toBeDefined();
      expect(cli!.publishable).toBe(true);
      // Confirms the assumption the generic loop's early return above
      // relies on: if this package ever starts shipping `.ts` sources
      // again, that early return silently stops covering it and this
      // assertion is what catches it.
      expect(shippingModules(cli!)).toEqual([]);
      expect(packedFiles(cli!)).toContain('dist/station.mjs');
    });

    it('declares every bundler-external package as a real, non-private dependency', async () => {
      const { CLI_EXTERNALS } = await import(
        '../../packages/cli/bundle-externals.mjs'
      );
      expect(CLI_EXTERNALS.length).toBeGreaterThan(0);
      const declared = new Set([
        ...Object.keys(cli!.manifest.dependencies ?? {}),
        ...Object.keys(cli!.manifest.peerDependencies ?? {}),
      ]);
      for (const name of CLI_EXTERNALS) {
        expect(
          declared.has(name),
          `${name} is left external by the CLI bundler but is not a declared dependency or peerDependency of @kontourai/station-cli`,
        ).toBe(true);
        expect(
          privateNames.has(name),
          `${name} is a private, unpublished workspace package and cannot be left external in the published CLI bundle`,
        ).toBe(false);
      }
    });
  });
});
