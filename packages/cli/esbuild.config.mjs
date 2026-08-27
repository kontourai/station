/**
 * Bundle `@kontourai/station-cli` into a single executable ESM file.
 *
 * `package.json`'s `"prepack": "node esbuild.config.mjs"` invokes this file
 * automatically on `npm pack`/`npm publish` — EXCEPT from inside this
 * checkout, where the repo-root `.npmrc`'s `ignore-scripts=true` (dependency
 * lifecycle code starts disabled by design) silently suppresses it. `npm
 * publish` run bare from `packages/cli` in this repo therefore packs
 * whatever `dist/station.mjs` already happens to exist on disk — stale,
 * missing, or (verified live) simply absent, producing a 3-file tarball with
 * a dangling `bin` at exit 0, no error. The prepack hook is real protection
 * for anyone packing/publishing from OUTSIDE this checkout (no inherited
 * `.npmrc`) and for CI, which never relies on it at all: `publish-packages.yml`
 * runs `npm run build` for this package as its own explicit workflow step
 * before the publish step, unaffected by `.npmrc`. A human publishing from
 * this checkout must run `npm run build:cli` first — see the bootstrap note
 * in `publish-packages.yml`.
 *
 * Why a bundle at all: the package's `bin` used to point at `src/cli.ts` with a
 * `#!/usr/bin/env tsx` shebang, and `tsx` is a devDependency — so `npx` or a
 * global install could not resolve its own interpreter. The CLI is an
 * executable, not a bundler consumer, so it is bundled at publish time rather
 * than transpiled on every run (`docs/design/cli-product.md`).
 *
 * What gets inlined: every `@kontourai/station-*` workspace package. Those
 * publish raw TypeScript deliberately (their consumer is a bundler), and
 * `@kontourai/station-connect` is `private: true` — inlining `device-pairing`
 * at build time means that package never has to be published just to satisfy
 * an import, and no raw-`.ts` resolution ever happens at runtime.
 *
 * What stays external: only packages that cannot be inlined, for the reasons
 * `scripts/lib/server-build-config.mjs` already documents for the server
 * build. Anything left external here MUST be declared in
 * `packages/cli/package.json` — as a `dependency`, or as an *optional* peer
 * that the code loads lazily and degrades from — or the tarball is broken for
 * a stranger.
 *
 * What the published artifact deliberately omits, and why (measured on
 * 0.4.0, `perf/cli-bundle-weight`):
 *
 * - **The sourcemap.** `dist/station.mjs.map` was 2.2 MB — nearly two thirds of
 *   the tarball's unpacked bytes and 17% of the installed footprint — to make
 *   crash traces from a CLI that catches its own errors marginally nicer. It is
 *   still emitted for local debugging (`npm run build` in this package) but
 *   `files` no longer ships it.
 * - **Unminified output.** Minifying takes the bundle from 1,194,642 to 638,384
 *   bytes. `keepNames` is on, so function and class names survive into stack
 *   traces; the 34 kB it costs over a bare `minify` is the price of readable
 *   crash reports.
 */

import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { STATION_SERVER_EXTERNALS } from '../../scripts/lib/server-build-config.mjs';
import { deriveCliBundleMetadata } from './build-metadata.mjs';
import { CLI_EXTERNALS } from './bundle-externals.mjs';

const packageDir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8'),
);

const bundleMetadata = deriveCliBundleMetadata({
  packageDir,
  packageVersion: manifest.version,
});

/**
 * The CLI's only unbundleable import. `@kontourai/station-shared/build` calls
 * esbuild's JS API to build plugins, and esbuild ships a per-platform native
 * binary resolved from its own installed package — the same reason the server
 * build keeps it external. Asserted against the server list so this cannot
 * drift into an invented set of externals.
 *
 * It is reached through a lazy `await import('esbuild')`
 * (`packages/shared/src/build.ts`), which esbuild preserves as a runtime
 * `import()` for an external package, so the three plugin-authoring verbs load
 * it on demand and `packages/cli/package.json` can declare it as an optional
 * peer instead of a dependency every client-verb user downloads.
 *
 * The list itself lives in `./bundle-externals.mjs`, shared with
 * `scripts/__tests__/publish-surface.test.ts` — that test asserts every name
 * here is a declared, non-private `@kontourai/station-cli` dependency, which
 * is the bundled-package equivalent of the source-shipping check it runs for
 * every other publishable workspace package.
 */
const unshared = CLI_EXTERNALS.filter(
  (name) => !STATION_SERVER_EXTERNALS.includes(name),
);
if (unshared.length > 0) {
  throw new Error(
    `CLI externals not justified by the server build config: ${unshared.join(', ')}`,
  );
}

const outfile = join(packageDir, 'dist', 'station.mjs');
mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [join(packageDir, 'src', 'bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // `external`, not `linked`: the map is still written next to the bundle for
  // local debugging, but the published `station.mjs` carries no
  // `sourceMappingURL` pointing at a file the tarball does not ship.
  sourcemap: 'external',
  minify: true,
  keepNames: true,
  external: CLI_EXTERNALS,
  banner: {
    js: [
      '#!/usr/bin/env node',
      // Some inlined dependencies still reach for CommonJS `require` at
      // runtime; ESM output has no such binding. Same shim the server build
      // installs.
      "import { createRequire as __stationCreateRequire } from 'node:module';",
      'const require = __stationCreateRequire(import.meta.url);',
      // The one signal that distinguishes the published bundle from a
      // contributor running the TypeScript sources through the repo-root
      // `./station` launcher. `src/distribution.ts` is the only reader:
      // it suppresses `cli.ts`'s run-as-script block (whose `import.meta.url`
      // check would otherwise fire a second time inside the bundle) and gates
      // the contributor-tier verbs. The version travels with it so
      // `station --version` never has to guess at a package.json path.
      `globalThis.__STATION_CLI_BUNDLE__ = ${JSON.stringify(bundleMetadata)};`,
    ].join('\n'),
  },
});

chmodSync(outfile, 0o755);
