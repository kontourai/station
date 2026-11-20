import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { STATION_SERVER_EXTERNALS } from './server-build-config.mjs';

export const DESKTOP_SERVER_RUNTIME_PACKAGES = STATION_SERVER_EXTERNALS;
/**
 * A single MSI CAB cannot hold more than 65,535 files: WiX fails the build
 * with LGHT0306 at that ceiling, and the bundler reports only `failed to run
 * light.exe` (station#2424). The file budget must therefore sit BELOW the
 * ceiling, not above it — at 80,000 this gate stayed green while the tree
 * grew to 68,828 files and Windows packaging became impossible.
 */
export const DESKTOP_SERVER_RUNTIME_BUDGET = Object.freeze({
  maxBytes: 512 * 1024 * 1024,
  // Below the 65,535 ceiling with room for the files this budget does not
  // count — the app binary, dist-server, schemas/ and icons all land in the
  // same CAB. Note this binds macOS/Linux staging to a Windows constraint;
  // one staged tree serves every platform, so a future non-Windows bundle
  // that legitimately exceeds it would fail for a Windows reason.
  maxFiles: 30_000,
});
const OPTIONAL_DESKTOP_SERVER_RUNTIME_PACKAGES = new Set(['fsevents']);
export const WINDOWS_DESKTOP_RUNTIME_RESOURCE_DIR =
  'dist-desktop-wix-resources';
export const WINDOWS_DESKTOP_RUNTIME_TAURI_CONFIG = 'tauri-config.json';

function readPackage(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
}

/**
 * The package a declared dependency installs. An npm alias
 * (`"zod-from-json-schema-v3": "npm:zod-from-json-schema@^0.0.5"`) installs
 * under the alias directory but keeps the real name in its package.json, so
 * the identity to verify comes from the declaring package's own spec rather
 * than from a list of known aliases.
 */
function declaredPackageName(dependencyName, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('npm:'))
    return dependencyName;
  const target = spec.slice('npm:'.length);
  const versionAt = target.indexOf('@', target.startsWith('@') ? 1 : 0);
  const name = versionAt === -1 ? target : target.slice(0, versionAt);
  if (!/^(?:@[^/@\s]+\/)?[^/@\s]+$/.test(name)) {
    throw new Error(
      `Dependency ${dependencyName} declares an unreadable npm alias: ${spec}`,
    );
  }
  return name;
}

function resolvePackageRoot(packageName, fromRoot, expectedName = packageName) {
  let current = realpathSync(fromRoot);
  while (true) {
    const candidate = join(current, 'node_modules', ...packageName.split('/'));
    const manifest = join(candidate, 'package.json');
    if (existsSync(manifest)) {
      const packageRoot = realpathSync(candidate);
      if (readPackage(packageRoot).name === expectedName) return packageRoot;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    expectedName === packageName
      ? `Could not locate installed package ${packageName}`
      : `Could not locate installed package ${packageName} (alias of ${expectedName})`,
  );
}

function declaredDependencySpecs(pkg) {
  const specs = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  };
  for (const [name, version] of Object.entries(pkg.peerDependencies ?? {})) {
    if (pkg.peerDependenciesMeta?.[name]?.optional) continue;
    specs[name] = version;
  }
  return specs;
}

/** The installed runtime dependencies of a package, as `[name, realName]`. */
function installedRuntimeDependencies(pkg, packageRoot) {
  const excluded = new Set(
    RUNTIME_DEPENDENCY_EXCLUSIONS.filter(
      (rule) => rule.package === pkg.name,
    ).map((rule) => rule.dependency),
  );
  const dependencies = [];
  for (const [name, spec] of Object.entries(declaredDependencySpecs(pkg))) {
    if (excluded.has(name)) continue;
    const realName = declaredPackageName(name, spec);
    try {
      resolvePackageRoot(name, packageRoot, realName);
    } catch {
      if (pkg.optionalDependencies?.[name]) continue;
      throw new Error(
        `Runtime dependency ${name} required by ${pkg.name} is not installed`,
      );
    }
    dependencies.push([name, realName]);
  }
  return dependencies;
}

function targetPackageRoot(
  packageName,
  sourceRoot,
  parentTargetRoot,
  outputRoot,
  planned,
) {
  // Match Node's nearest node_modules lookup. A different nearer version
  // shadows the root, even when the root has the requested version.
  let current = parentTargetRoot;
  while (true) {
    const candidate = join(current, 'node_modules', packageName);
    const visible = planned.get(candidate);
    if (visible) {
      return visible === sourceRoot
        ? candidate
        : join(parentTargetRoot, 'node_modules', packageName);
    }
    if (current === outputRoot) break;
    current = dirname(current);
  }
  return join(outputRoot, 'node_modules', packageName);
}

function planRuntimePackages(packageNames, projectRoot, outputRoot) {
  outputRoot = resolve(outputRoot);
  const planned = new Map();
  const queue = [];
  const add = (target, source) => {
    const existing = planned.get(target);
    if (existing === source) return;
    if (existing)
      throw new Error(
        `Conflicting runtime packages at ${target}: ${existing} and ${source}`,
      );
    planned.set(target, source);
    queue.push({ target, source });
  };
  // Root imports must retain the versions selected by the server, regardless
  // of which transitive dependency happens to be traversed first.
  // A root import may itself be an alias the project declares.
  const projectManifest = join(projectRoot, 'package.json');
  const projectSpecs = existsSync(projectManifest)
    ? declaredDependencySpecs(readPackage(projectRoot))
    : {};
  for (const name of packageNames) {
    let source;
    try {
      source = resolvePackageRoot(
        name,
        projectRoot,
        declaredPackageName(name, projectSpecs[name]),
      );
    } catch (error) {
      if (OPTIONAL_DESKTOP_SERVER_RUNTIME_PACKAGES.has(name)) continue;
      throw error;
    }
    add(join(outputRoot, 'node_modules', name), source);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const { target, source } = queue[index];
    // Reserve all siblings before visiting their descendants. Otherwise a
    // later sibling can silently shadow a dependency already hoisted for a child.
    for (const [name, realName] of installedRuntimeDependencies(
      readPackage(source),
      source,
    )) {
      const dependency = resolvePackageRoot(name, source, realName);
      add(
        targetPackageRoot(name, dependency, target, outputRoot, planned),
        dependency,
      );
    }
  }
  return planned;
}

/**
 * Build-time artifacts the packaged Node runtime never reads: TypeScript
 * declarations and source maps (nothing here runs with
 * `--enable-source-maps`). At the time of the station#2424 break these were
 * 30,698 of the staged tree's 68,828 files, which is what pushed Windows
 * packaging past the CAB ceiling above.
 *
 * Markdown is deliberately NOT pruned, though it was ~3,100 files of that
 * same tree. In this dependency closure it is load-bearing data, not
 * documentation: `@kontourai/flow-agents` ships its canonical skills as
 * `skills/<name>/SKILL.md` (plus the kit skill trees, `POWER.md` files and
 * the prompt markdown), and Station's `resolveCanonicalSkillSources` requires
 * those exact files to exist — its `hasSkillFolders` drops a source whose
 * SKILL.md is missing, fail-open and unlogged, so pruning them silently
 * emptied the flow-agents-contributed skills from the packaged app on every
 * platform (Station's own skills were unaffected) while dev runs, against an
 * unpruned node_modules, stayed correct. `LICENSE.md` is also `.md`, and MIT
 * text must accompany redistribution.
 */
export const NON_RUNTIME_ARTIFACT = /(?:\.d\.[cm]?ts|\.map|\.pdb)$/i;
// `.pdb` is Windows debug-symbol data read only by a debugger, never by the
// loader: node-pty ships one beside every Windows binary (~27 MB per arch).

const SEMANTIC_CONVENTIONS_NODE_EXPORTS = Object.freeze({
  '.': './build/src/index.js',
  './incubating': './build/src/index-incubating.js',
});
const SEMANTIC_CONVENTIONS_BUNDLER_CONDITIONS = new Set([
  'esnext',
  'module',
  'types',
  'default',
]);

function hasReviewedSemanticConventionNodeExports(pkg) {
  const exports = pkg.exports ?? {};
  return (
    pkg.main === 'build/src/index.js' &&
    (!pkg.type || pkg.type === 'commonjs') &&
    Object.keys(exports).length === 2 &&
    Object.entries(exports).every(
      ([subpath, conditions]) =>
        Object.hasOwn(SEMANTIC_CONVENTIONS_NODE_EXPORTS, subpath) &&
        conditions?.default === SEMANTIC_CONVENTIONS_NODE_EXPORTS[subpath] &&
        Object.keys(conditions).every((condition) =>
          SEMANTIC_CONVENTIONS_BUNDLER_CONDITIONS.has(condition),
        ),
    )
  );
}

/**
 * Package-scoped subtrees the packaged server never reads (#2694). Each rule
 * names one package and the top-level entries of it that are dropped; the
 * target is the platform/arch the tree is staged for (the staging host unless
 * a caller says otherwise).
 *
 * - node-pty's loader (lib/utils.js `loadNativeModule`) tries `build/Release`,
 *   `build/Debug`, then exactly `prebuilds/${process.platform}-${process.arch}`,
 *   and Station's spawn-helper chmod (src-server/adapters/node-pty-adapter.ts)
 *   probes only that same directory. Release packages ship pinned Node, but
 *   desktop debug builds select Node from the login PATH. Its architecture can
 *   differ from the staging host's, so keep every prebuild for the target OS
 *   and omit only other operating systems.
 * - RxJS's published exports choose dist/cjs under Node for both import and
 *   require, including internal/* and testing. Keep that shared identity and
 *   package metadata/licenses; omit browser distributions and TypeScript input.
 * - OTLP transformer's Node entry is build/src/index.js for both import and
 *   require. Its build/esm and build/esnext trees are alternate bundler
 *   distributions, including duplicate generated protobuf code. Keep the
 *   Node implementation, package metadata and license; omit those variants.
 * - Semantic conventions' stable and incubating exports likewise choose
 *   build/src under normal Node import and require. Only prune its bundler
 *   distributions while the manifest retains the reviewed default targets
 *   and conditions; a new Node import/require condition keeps every variant.
 * - koffi (#4524) is the FFI the managed policy's Windows registry and ACL
 *   reader loads with `require('koffi')` on first use, and only on Windows
 *   (packages/shared/src/managed-policy-windows.ts). Keep `src/`: the public
 *   entrypoint loads JavaScript from it. `vendor/` and `doc/` are build inputs
 *   and documentation, never loaded at runtime. The
 *   runtime binary comes from `lib/native` or the `@koromix/koffi-<os>-<arch>`
 *   package. Off Windows nothing requires it at all, so koffi and its
 *   platform package keep only their metadata and license there.
 * - flow-agents 9.14 ships its per-harness install bundles as one pack,
 *   `bundles/flow-agents-bundles.pack` (~7 MB). Only its own CLI reads it:
 *   `lib/bundle-store` expands it for `init`, `kit activate` and `workflow
 *   doctor`, and `scripts/install-codex-home.sh` for a Codex home install.
 *   Station imports none of those entrypoints and spawns no flow-agents CLI;
 *   `bundle-store` is only loaded (inert) through the root index. Without the
 *   pack, `resolveBundle` returns null and those commands report it.
 */
export const RUNTIME_PACKAGE_PRUNE_RULES = Object.freeze([
  Object.freeze({
    id: 'compiled-sdk-development-sources',
    package: '*',
    excludes: (segments, _target, packageName) =>
      (packageName === 'zod' ||
        packageName === 'ai' ||
        packageName === 'openai' ||
        packageName === '@anthropic-ai/sdk' ||
        packageName.startsWith('@ai-sdk/')) &&
      (segments[0] === 'src' ||
        segments[0] === 'docs' ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(segments.at(-1))),
  }),
  Object.freeze({
    id: 'cedar-node-runtime-only',
    package: '@cedar-policy/cedar-wasm',
    excludes: (segments) => ['esm', 'web'].includes(segments[0]),
  }),
  Object.freeze({
    id: 'rxjs-node-runtime-only',
    package: 'rxjs',
    excludes: (segments) =>
      segments[0] === 'src' ||
      (segments[0] === 'dist' &&
        ['esm', 'esm5', 'bundles'].includes(segments[1])),
  }),
  Object.freeze({
    id: 'otlp-transformer-node-runtime-only',
    package: '@opentelemetry/otlp-transformer',
    excludes: (segments) =>
      segments[0] === 'build' && ['esm', 'esnext'].includes(segments[1]),
  }),
  Object.freeze({
    id: 'semantic-conventions-node-runtime-only',
    package: '@opentelemetry/semantic-conventions',
    appliesTo: hasReviewedSemanticConventionNodeExports,
    excludes: (segments) =>
      segments[0] === 'build' && ['esm', 'esnext'].includes(segments[1]),
  }),
  Object.freeze({
    id: 'node-pty-foreign-prebuilds',
    package: 'node-pty',
    excludes: (segments, target) =>
      segments[0] === 'prebuilds' &&
      segments.length > 1 &&
      !segments[1].startsWith(`${target.platform}-`),
  }),
  Object.freeze({
    id: 'koffi-build-sources',
    package: 'koffi',
    excludes: (segments) => ['vendor', 'doc'].includes(segments[0]),
  }),
  Object.freeze({
    id: 'flow-agents-harness-bundle-pack',
    package: '@kontourai/flow-agents',
    excludes: (segments) =>
      segments.length === 2 &&
      segments[0] === 'bundles' &&
      segments[1] === 'flow-agents-bundles.pack',
  }),
  Object.freeze({
    id: 'koffi-off-windows',
    package: '*',
    excludes: (segments, target, packageName) =>
      target.platform !== 'win32' &&
      (packageName === 'koffi' || packageName.startsWith('@koromix/koffi-')) &&
      !/^(?:package\.json|LICENSE(?:\.txt|\.md)?)$/i.test(segments.join('/')),
  }),
]);

/**
 * Dependency edges the stager does not follow (#2694). flow-agents depends
 * on esbuild only for `build-universal-bundles` and its own build scripts,
 * which regenerate per-harness `dist/` bundles the published package no longer
 * ships (9.14 dropped `dist/`, `src/` and `evals/`, retiring the prune rules
 * that removed them); its runtime modules are written to load without it
 * ("unavailable in a stripped install", lib/local-artifact-root).
 * The edge pinned a second, nested esbuild (~21 MB) beside the root copy
 * Station itself externalizes, which stays staged, so a stray import still
 * resolves by ordinary node_modules lookup.
 */
export const RUNTIME_DEPENDENCY_EXCLUSIONS = Object.freeze([
  Object.freeze({
    id: 'flow-agents-bundle-builder-esbuild',
    package: '@kontourai/flow-agents',
    dependency: 'esbuild',
  }),
]);

function packageCopyOptions(sourceRoot, target) {
  const pkg = readPackage(sourceRoot);
  const packageName = pkg.name;
  const rules = RUNTIME_PACKAGE_PRUNE_RULES.filter(
    (rule) =>
      (rule.package === packageName || rule.package === '*') &&
      (!rule.appliesTo || rule.appliesTo(pkg)),
  );
  return {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const segments = relative(sourceRoot, source).split(sep);
      if (segments.length === 1 && segments[0] === '') return true;
      if (segments.includes('node_modules')) return false;
      if (rules.some((rule) => rule.excludes(segments, target, packageName)))
        return false;
      // Match files only: a directory whose name ends in one of these
      // extensions would otherwise drop everything beneath it.
      return (
        !NON_RUNTIME_ARTIFACT.test(source) || lstatSync(source).isDirectory()
      );
    },
  };
}

/** Keep full source maps in the build output, outside the installed payload. */
export function stageDesktopServerBundle(projectRoot, outputRoot) {
  cpSync(join(projectRoot, 'dist-server'), join(outputRoot, 'dist-server'), {
    recursive: true,
    filter: (source) =>
      !NON_RUNTIME_ARTIFACT.test(source) || lstatSync(source).isDirectory(),
  });
}

function stageWindowsWixPackage(
  sourceRoot,
  targetPackageRootPath,
  outputRoot,
  windowsWixResources,
  target,
) {
  const alias = `package-${String(windowsWixResources.entries.length).padStart(4, '0')}`;
  const aliasRoot = join(windowsWixResources.root, alias);
  cpSync(sourceRoot, aliasRoot, packageCopyOptions(sourceRoot, target));
  windowsWixResources.entries.push({
    aliasRoot,
    target: join(
      'node_modules',
      relative(join(outputRoot, 'node_modules'), targetPackageRootPath),
    ),
  });
}

function writeWindowsWixTauriConfig(
  windowsTauriConfigRoot,
  windowsWixResources,
) {
  const resources = {
    // JSON merge-patch removes the ordinary deep runtime resource entry from
    // tauri.windows.conf.json. Each alias restores its install destination
    // with a shallow source path that WiX 3.14 can bind.
    '../dist-desktop-runtime/node_modules': null,
  };
  for (const { aliasRoot, target } of windowsWixResources.entries) {
    const source = relative(windowsTauriConfigRoot, aliasRoot)
      .split(sep)
      .join('/');
    resources[source] = target.split(sep).join('/');
  }
  const configPath = join(
    windowsWixResources.root,
    WINDOWS_DESKTOP_RUNTIME_TAURI_CONFIG,
  );
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        // The build wrapper stages these resources before invoking the Tauri
        // CLI with `--config` pointing at this file, so the normal platform
        // command must not restage them.
        build: { beforeBuildCommand: '' },
        bundle: { resources },
      },
      null,
      2,
    )}\n`,
  );
  return configPath;
}

export function inspectDesktopServerRuntime(
  runtimeRoot,
  budget = DESKTOP_SERVER_RUNTIME_BUDGET,
) {
  let bytes = 0;
  let files = 0;
  const pending = [join(runtimeRoot, 'node_modules')];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      files += 1;
      bytes += lstatSync(entryPath).size;
    }
  }
  if (bytes > budget.maxBytes || files > budget.maxFiles) {
    throw new Error(
      `Desktop server runtime exceeds its release budget: ${bytes} bytes/${files} files (maximum ${budget.maxBytes} bytes/${budget.maxFiles} files)`,
    );
  }
  return { bytes, files };
}

export function stageDesktopServerRuntime({
  projectRoot = process.cwd(),
  outputRoot = resolve(projectRoot, 'dist-desktop-runtime'),
  packages = DESKTOP_SERVER_RUNTIME_PACKAGES,
  budget = DESKTOP_SERVER_RUNTIME_BUDGET,
  windowsWixResourceRoot,
  windowsTauriConfigRoot = resolve(projectRoot, 'src-desktop'),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const runtimeTarget = { platform, arch };
  const windowsWixResources = windowsWixResourceRoot
    ? { root: resolve(windowsWixResourceRoot), entries: [] }
    : undefined;
  if (windowsWixResources?.root === resolve(outputRoot)) {
    throw new Error(
      'Windows WiX resource root must differ from runtime output',
    );
  }
  rmSync(outputRoot, { recursive: true, force: true });
  if (windowsWixResources) {
    rmSync(windowsWixResources.root, { recursive: true, force: true });
    mkdirSync(windowsWixResources.root, { recursive: true });
  }
  mkdirSync(outputRoot, { recursive: true });
  const planned = planRuntimePackages(packages, projectRoot, outputRoot);
  for (const [target, source] of planned) {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, packageCopyOptions(source, runtimeTarget));
    if (windowsWixResources) {
      stageWindowsWixPackage(
        source,
        target,
        outputRoot,
        windowsWixResources,
        runtimeTarget,
      );
    }
  }
  inspectDesktopServerRuntime(outputRoot, budget);
  if (windowsWixResources) {
    writeWindowsWixTauriConfig(windowsTauriConfigRoot, windowsWixResources);
  }
  return outputRoot;
}
