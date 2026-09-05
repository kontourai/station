import { execSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import type { build as EsbuildBuild } from 'esbuild';
import { readPluginManifest } from './parsers.js';

const sharedDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * esbuild, loaded only when a plugin is actually built.
 *
 * This used to be a static `import { build } from 'esbuild'`, which meant every
 * consumer of this module paid for esbuild at load time — and, more expensively,
 * at *install* time: esbuild resolves a per-platform native binary from its own
 * package (~9.9 MB unpacked, ~4.2 MB downloaded). `@kontourai/station-cli`
 * inlines this module into its published bundle, so that binary was a hard
 * dependency of a CLI whose ~28 client verbs never build anything.
 *
 * Deferring the import lets the CLI declare esbuild as an *optional peer*: the
 * plugin-authoring verbs (`plugin build`, `plugin dev`, `plugin install`) load
 * it on demand, and everyone else never downloads it. Nothing else changes —
 * `buildPlugin` was always async, so the await is free, and in the server and
 * the monorepo (where esbuild is a real dependency) the import always resolves.
 */
let esbuildBuild: typeof EsbuildBuild | undefined;

async function loadEsbuild(): Promise<typeof EsbuildBuild> {
  if (esbuildBuild) return esbuildBuild;
  try {
    // A literal specifier on purpose: it stays statically analysable for the
    // publish-surface contract, and esbuild leaves a dynamic import of an
    // *external* package as a real runtime `import()` rather than inlining it.
    const loaded = await import('esbuild');
    esbuildBuild = loaded.build;
    return esbuildBuild;
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
    throw new Error(
      [
        'Building a plugin needs `esbuild`, which is not installed.',
        'It ships a per-platform native binary (~10 MB), so it is an optional',
        'peer dependency rather than something every install pays for.',
        'Install it once, alongside the CLI:',
        '    npm install -g esbuild',
      ].join('\n'),
      { cause: error },
    );
  }
}

/**
 * Modules provided by the host app at runtime via window.__station_ai_shared.
 */
export const SHARED_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@kontourai/station-sdk',
  '@kontourai/station-sdk/client',
  '@kontourai/station-sdk/voice',
  '@kontourai/station-components',
  '@tanstack/react-query',
  'dompurify',
  'debug',
  'zod',
];

/** esbuild filter regex matching all shared externals */
export const SHARED_EXTERNALS_REGEX =
  /^react$|^react\/|^@kontourai\/station-sdk(?:\/(?:client|voice))?$|^@kontourai\/station-components$|^@tanstack\/react-query$|^dompurify$|^debug$|^zod$/;

/**
 * Runtime require() shim — maps externals to window.__station_ai_shared.
 */
export const RUNTIME_SHIM = [
  'var __shared = (typeof window !== "undefined" && window.__station_ai_shared) || {};',
  'var require = globalThis.require = function(m) {',
  '  if (__shared[m]) return __shared[m];',
  '  if (m === "react" || m === "react/jsx-runtime" || m === "react/jsx-dev-runtime") return __shared["react"];',
  '  console.warn("[Plugin] Unknown shared module:", m);',
  '  return {};',
  '};',
].join('\n');

/** Registration footer — exposes plugin exports on window.__station_ai_plugins */
export function registrationFooter(pluginName: string): string {
  return `window.__station_ai_plugins = window.__station_ai_plugins || {}; window.__station_ai_plugins[${JSON.stringify(pluginName)}] = __plugin;`;
}

export interface BuildResult {
  built: boolean;
  bundlePath?: string;
  cssPath?: string;
}

/**
 * Build a plugin. Workspace plugins (with entrypoint) use esbuild JS API directly.
 * Manifest-controlled shell build commands are rejected by the host.
 */
export async function buildPlugin(
  pluginDir: string,
  mode: 'production' | 'dev' = 'production',
  validatedManifest?: PluginManifest,
): Promise<BuildResult> {
  const manifest = validatedManifest ?? readPluginManifest(pluginDir);
  if (
    !validatedManifest &&
    String(
      (manifest as unknown as { $schema?: unknown }).$schema ?? '',
    ).startsWith('https://agent-plugins.org/schemas/')
  )
    throw new Error(
      'Agent Plugin builds require a validated Station namespace manifest from the installation owner',
    );
  if (manifest.build) {
    throw new Error(
      `Plugin '${manifest.name}' declares manifest.build, but host shell builds are not supported. Prebuild the plugin bundle or use Station-supported entrypoints.`,
    );
  }
  if (!manifest.entrypoint) {
    return buildCustomPlugin(pluginDir);
  }
  return buildLayoutPlugin(
    pluginDir,
    { ...manifest, entrypoint: manifest.entrypoint },
    mode,
  );
}

async function buildLayoutPlugin(
  pluginDir: string,
  manifest: PluginManifest & { entrypoint: string },
  mode: 'production' | 'dev',
): Promise<BuildResult> {
  // Resolved before anything mutates the plugin directory, so a missing
  // esbuild reports itself instead of leaving a half-prepared build.
  const esbuild = await loadEsbuild();
  const isDev = mode === 'dev';
  const outdir = join(pluginDir, 'dist');
  const outfile = join(outdir, `bundle${isDev ? '-dev' : ''}.js`);
  const pluginRoot = realpathSync(pluginDir);
  const allowedRoots = buildAllowedInputRoots(pluginRoot);
  const entrypoint = join(pluginDir, manifest.entrypoint);
  assertRealPathInside(allowedRoots, entrypoint, 'Plugin entrypoint');

  ensurePluginDeps(pluginDir);
  if (existsSync(outdir) && lstatSync(outdir).isSymbolicLink()) {
    throw new Error(
      `Plugin build output directory escapes plugin root: ${outdir}`,
    );
  }
  mkdirSync(outdir, { recursive: true });
  assertRealPathInside([pluginRoot], outdir, 'Plugin build output directory');

  await esbuild({
    entryPoints: [entrypoint],
    bundle: true,
    format: 'iife',
    globalName: '__plugin',
    outfile,
    jsx: 'automatic',
    sourcemap: isDev ? 'inline' : false,
    banner: { js: RUNTIME_SHIM },
    footer: { js: registrationFooter(manifest.name) },
    define: {
      'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
    },
    plugins: [
      {
        name: 'externalize-shared',
        setup(build) {
          build.onResolve({ filter: SHARED_EXTERNALS_REGEX }, (args) => ({
            path: args.path,
            namespace: 'shared-external',
          }));
          build.onLoad(
            { filter: /.*/, namespace: 'shared-external' },
            (args) => ({
              contents: `var _m = globalThis.require('${args.path}'); module.exports = _m; module.exports.__esModule = true; if (!module.exports.default) module.exports.default = _m;`,
              loader: 'js',
            }),
          );
        },
      },
      {
        name: 'plugin-root-containment',
        setup(build) {
          build.onLoad({ filter: /.*/ }, (args) => {
            assertRealPathInside(allowedRoots, args.path, 'Plugin build input');
            return null;
          });
        },
      },
    ],
    logLevel: 'info',
  });

  const cssPath = outfile.replace(/\.js$/, '.css');
  return {
    built: true,
    bundlePath: outfile,
    cssPath: existsSync(cssPath) ? cssPath : undefined,
  };
}

function assertRealPathInside(
  allowedRootRealPaths: string[],
  targetPath: string,
  label: string,
): void {
  const targetRealPath = realpathSync(targetPath);
  const insideAllowedRoot = allowedRootRealPaths.some(
    (rootRealPath) =>
      targetRealPath === rootRealPath ||
      targetRealPath.startsWith(`${rootRealPath}${sep}`),
  );
  if (!insideAllowedRoot) {
    throw new Error(`${label} escapes plugin root: ${targetPath}`);
  }
}

/**
 * Directories a plugin build is allowed to read from: the plugin itself, plus
 * whichever of `shared`/`sdk` exist on disk as real source roots for the
 * runtime shim to resolve against.
 *
 * `shared` used to fall back to `<this package>/../packages/shared` when
 * `resolveWorkspacePackageRoot` found nothing — the same path that helper
 * already tries and rejects when it has no `src/index.ts`. Inside the monorepo
 * the fallback never fired; from the published CLI bundle (where `shared` is
 * inlined and there is no `packages/` directory at all) it fired every time and
 * `realpathSync` threw `ENOENT`, so `station plugin build` and `station plugin
 * dev` were unusable from an npm install. A root that is not on disk allows
 * nothing, so dropping it narrows the containment set rather than widening it.
 */
function buildAllowedInputRoots(pluginRoot: string): string[] {
  const devRoot = resolve(sharedDirectory, '..');
  const roots = [pluginRoot];
  const sharedRoot = resolveWorkspacePackageRoot('shared', devRoot);
  if (sharedRoot) roots.push(sharedRoot);
  const sdkRoot = resolveWorkspacePackageRoot(
    'sdk',
    resolve(devRoot, '..', 'sdk'),
  );
  if (sdkRoot) roots.push(sdkRoot);
  // A plugin's declared dependencies are legitimate build inputs, and Node
  // resolves them by walking node_modules directories from the plugin upward.
  // For a plugin that is itself a workspace member (examples/*, or a scaffold
  // living inside a checkout), npm hoists those installs to the host root —
  // outside every root above, which is how a dependency as ordinary as
  // examples/builder-delivery-viewer's @kontourai/surface came to fail
  // containment on every fresh checkout (#905). Allow exactly the
  // node_modules directories on that resolution path, bounded at the host
  // workspace root: nothing above it, and realpath containment still rejects
  // a package that is only a symlink out of the workspace.
  const workspaceRoot = hostWorkspaceRootFor(pluginRoot);
  if (workspaceRoot) {
    // Each candidate must PHYSICALLY live inside the workspace: a
    // node_modules that is itself a symlink (plugin/node_modules ->
    // /Users/victim) would otherwise realpath its target straight into the
    // allowlist, and assertRealPathInside would then bless anything under it.
    const workspaceRootReal = realpathSync(workspaceRoot);
    const insideWorkspace = (candidateReal: string) =>
      candidateReal === workspaceRootReal ||
      candidateReal.startsWith(`${workspaceRootReal}${sep}`);
    for (let dir = pluginRoot; ; dir = dirname(dir)) {
      const nodeModules = join(dir, 'node_modules');
      if (existsSync(nodeModules)) {
        const nodeModulesReal = realpathSync(nodeModules);
        if (insideWorkspace(nodeModulesReal)) roots.push(nodeModulesReal);
      }
      if (dir === workspaceRoot || dirname(dir) === dir) break;
    }
  }
  return roots.map((root) => realpathSync(root));
}

function buildCustomPlugin(pluginDir: string): BuildResult {
  readPluginManifest(pluginDir);
  return { built: false };
}

/**
 * Resolves a sibling workspace package's real source root, trying two
 * on-disk shapes in order: (a) running from source/tsx inside the monorepo
 * — this module lives at `packages/shared/src/build.ts`, so `devCandidate`
 * (computed per-target by the caller, since "this module's own package" and
 * "a sibling package" sit a different number of hops from `sharedDirectory`)
 * is checked first; (b) running from a single-file bundled server
 * (`esbuild.config.mjs`'s `dist-server*` output — the real shape
 * `/api/plugins/install` runs under in production), where this file's
 * bundled location sits directly under the repo root and every workspace
 * package is uniformly a `packages/<name>` hop away. `null` when neither
 * shape resolves (package genuinely absent).
 *
 * `ensurePluginDeps`'s `sharedRoot` already needed exactly this two-shape
 * fallback (shape (b) below is the pre-existing logic, unchanged in
 * behavior) — `sdkRoot` previously only checked shape (a), so an
 * installed-from-directory plugin (the bundled-server codepath) that
 * imports `@kontourai/station-sdk` (or a subpath, e.g. `/client`) never got
 * its symlink created there, only under `station plugin build`/`plugin dev`
 * run via source. Both call sites now share this one resolution helper.
 */
export function resolveWorkspacePackageRoot(
  name: string,
  devCandidate: string,
): string | null {
  if (existsSync(join(devCandidate, 'src', 'index.ts'))) return devCandidate;

  const bundledCandidate = resolve(sharedDirectory, '..', 'packages', name);
  if (existsSync(join(bundledCandidate, 'src', 'index.ts'))) {
    return bundledCandidate;
  }

  return null;
}

/**
 * Packages this build resolves for the plugin itself — by workspace symlink
 * inside the monorepo, by the bundle's runtime shim at load time. A plugin
 * author may also have a real copy installed from the registry so that
 * editors and `tsc` can see the types; that copy is theirs, not ours to prune.
 */
const HOST_PROVIDED_PACKAGES = [
  '@kontourai/station-sdk',
  '@kontourai/station-shared',
];

/**
 * Runs `install` with any real (non-symlink) install of
 * `HOST_PROVIDED_PACKAGES` moved aside and put back afterwards.
 *
 * `npm install --legacy-peer-deps` resolves as if `peerDependencies` were not
 * declared, so it prunes anything installed only to satisfy one — and the
 * plugin scaffold puts `@kontourai/station-sdk` in `peerDependencies`. Inside
 * the monorepo that deletion is invisible: the workspace symlink below puts
 * the SDK straight back. Outside it, `resolveWorkspacePackageRoot` returns
 * `null`, nothing replaces it, and an external author's every build silently
 * uninstalls the SDK they need for IntelliSense and `tsc`.
 *
 * Only real directories are parked. A workspace symlink is left for npm to do
 * whatever it already did with it, and the link loop below recreates it — so
 * in-monorepo behavior is unchanged.
 */
function withHostProvidedPackagesPreserved(
  pluginDir: string,
  install: () => void,
): void {
  const modulesDir = join(pluginDir, 'node_modules');
  const parkingDir = join(modulesDir, '.station-preserved');
  const parked: Array<{ from: string; to: string }> = [];

  for (const packageName of HOST_PROVIDED_PACKAGES) {
    const installed = join(modulesDir, ...packageName.split('/'));
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(installed);
    } catch {
      continue;
    }
    if (!entry.isDirectory()) continue;
    const destination = join(parkingDir, packageName.replace('/', '+'));
    mkdirSync(parkingDir, { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    renameSync(installed, destination);
    parked.push({ from: destination, to: installed });
  }

  try {
    install();
  } finally {
    for (const { from, to } of parked) {
      if (existsSync(to)) {
        // npm reinstalled it; its copy wins.
        rmSync(from, { recursive: true, force: true });
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    rmSync(parkingDir, { recursive: true, force: true });
  }
}

/**
 * Nearest ancestor package.json that declares `workspaces`, i.e. the host
 * monorepo root whose lockfile an install from inside it would rewrite.
 * Returns null for a plugin that lives outside any workspace.
 */
export function hostWorkspaceRootFor(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
          workspaces?: unknown;
        };
        // The plugin's own manifest never declares workspaces; only the host's.
        if (parsed.workspaces && dir !== resolve(startDir)) return dir;
      } catch {
        // An unreadable manifest is not a workspace root for our purposes.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Symlinks `HOST_PROVIDED_PACKAGES` into the plugin's `node_modules` from
 * this workspace checkout, so both `tsc`/editors and the actual bundle build
 * resolve them locally. A no-op once the link already exists (idempotent —
 * safe to call before *and* after `npm install`).
 */
function linkHostProvidedPackages(pluginDir: string): void {
  const devRoot = resolve(sharedDirectory, '..');
  const sharedRoot =
    resolveWorkspacePackageRoot('shared', devRoot) ??
    // Never actually null in practice (this module IS `packages/shared`, so
    // its own root always resolves one way or the other) — kept as a
    // last-resort literal fallback rather than a non-null assertion, same
    // as this ternary's own pre-existing (unchanged) shape-(b) fallback.
    resolve(sharedDirectory, '..', 'packages', 'shared');
  const sdkRoot = resolveWorkspacePackageRoot(
    'sdk',
    resolve(devRoot, '..', 'sdk'),
  );

  const linkTargets: Array<{ scope: string; name: string; root: string }> = [
    { scope: '@kontourai', name: 'station-shared', root: sharedRoot },
  ];
  if (sdkRoot) {
    linkTargets.push({
      scope: '@kontourai',
      name: 'station-sdk',
      root: sdkRoot,
    });
  }

  for (const target of linkTargets) {
    const link = join(pluginDir, 'node_modules', target.scope, target.name);
    if (existsSync(link)) continue;
    mkdirSync(join(pluginDir, 'node_modules', target.scope), {
      recursive: true,
    });
    try {
      unlinkSync(link);
    } catch {}
    symlinkSync(target.root, link);
  }
}

/**
 * Install plugin npm deps and symlink the workspace shared/sdk packages.
 */
function ensurePluginDeps(pluginDir: string): void {
  if (!existsSync(join(pluginDir, 'package.json'))) return;

  const hostRoot = hostWorkspaceRootFor(realpathSync(pluginDir));
  if (hostRoot) {
    const hostManifest = JSON.parse(
      readFileSync(join(hostRoot, 'package.json'), 'utf8'),
    ) as {
      workspaces?: string[] | { packages?: string[] };
      packageManager?: string;
    };
    const workspaces = Array.isArray(hostManifest.workspaces)
      ? hostManifest.workspaces
      : (hostManifest.workspaces?.packages ?? []);
    const pluginPath = relative(hostRoot, realpathSync(pluginDir)).replaceAll(
      '\\',
      '/',
    );
    if (workspaces.some((pattern) => matchesGlob(pluginPath, pattern))) {
      const pluginManifest = JSON.parse(
        readFileSync(join(pluginDir, 'package.json'), 'utf8'),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const missing = Object.keys({
        ...pluginManifest.dependencies,
        ...pluginManifest.devDependencies,
      }).filter((name) => {
        let scope = realpathSync(pluginDir);
        for (;;) {
          if (
            existsSync(
              join(scope, 'node_modules', ...name.split('/'), 'package.json'),
            )
          )
            return false;
          if (scope === hostRoot) return true;
          const parent = dirname(scope);
          if (parent === scope) return true;
          scope = parent;
        }
      });
      const marker = hostManifest.packageManager?.startsWith('pnpm@')
        ? join(hostRoot, 'node_modules', '.modules.yaml')
        : join(hostRoot, 'node_modules');
      if (!existsSync(marker) || missing.length) {
        throw new Error(
          `Workspace plugin dependencies are missing${missing.length ? `: ${missing.join(', ')}` : ''}. Run npm run dependencies:ci in ${hostRoot} before building this plugin.`,
        );
      }
      // The managed workspace owns installation and links. Even a lockfile-free
      // npm install here can prune or replace the host dependency tree.
      return;
    }
  }
  // Standalone plugin installation stays npm-based. Both the explicit local
  // prefix and disabled workspaces are required to keep a nested plugin from
  // walking upward and mutating the Station installation.
  const installArgs = [
    'npm install --prefix . --workspaces=false --ignore-scripts --legacy-peer-deps',
    hostRoot ? '--no-save' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Provision the workspace symlinks *before* installing, not after. Some
  // scaffolds (pre-dating the fix that dropped these two packages from
  // `devDependencies`) still list `@kontourai/station-sdk`/`-shared` there
  // with a real semver range; neither package has ever been published, so a
  // plain `npm install` would 404 trying to fetch it. Pre-linking means npm's
  // own actual-tree scan finds a node at that path whose `package.json`
  // version already satisfies the manifest's range — verified live: it skips
  // the registry fetch for exactly that edge and installs everything else
  // normally, and the generated lockfile correctly records the edge as a
  // `"link": true` resolution, not a fabricated registry entry. This never
  // touches the plugin author's package.json, and it fails exactly as loudly
  // as a normal install would if the local symlink's version ever stops
  // satisfying the manifest's range (e.g. after these packages are actually
  // published and a scaffold's pinned range no longer matches) — no attempt
  // here catches or masks that outcome.
  linkHostProvidedPackages(pluginDir);
  withHostProvidedPackagesPreserved(pluginDir, () => {
    execSync(installArgs, {
      cwd: pluginDir,
      timeout: MS_PER_MINUTE,
      stdio: 'pipe',
      windowsHide: true,
    });
  });

  // Idempotent: recreates the link if `--legacy-peer-deps` pruned it as
  // satisfying nothing but a peer entry (see withHostProvidedPackagesPreserved).
  linkHostProvidedPackages(pluginDir);
}
