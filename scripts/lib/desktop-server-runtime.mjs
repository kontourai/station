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
  maxBytes: 800 * 1024 * 1024,
  // Below the 65,535 ceiling with room for the files this budget does not
  // count — the app binary, dist-server, schemas/ and icons all land in the
  // same CAB. Note this binds macOS/Linux staging to a Windows constraint;
  // one staged tree serves every platform, so a future non-Windows bundle
  // that legitimately exceeds it would fail for a Windows reason.
  maxFiles: 60_000,
});
const OPTIONAL_DESKTOP_SERVER_RUNTIME_PACKAGES = new Set(['fsevents']);
export const WINDOWS_DESKTOP_RUNTIME_RESOURCE_DIR =
  'dist-desktop-wix-resources';
export const WINDOWS_DESKTOP_RUNTIME_TAURI_CONFIG = 'tauri-config.json';

function readPackage(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
}

function resolvePackageRoot(packageName, fromRoot) {
  let current = realpathSync(fromRoot);
  while (true) {
    const candidate = join(current, 'node_modules', ...packageName.split('/'));
    const manifest = join(candidate, 'package.json');
    if (existsSync(manifest)) {
      const packageRoot = realpathSync(candidate);
      const pkg = readPackage(packageRoot);
      // npm aliases install under the alias name (e.g. zod-from-json-schema-v3
      // -> npm:zod-from-json-schema) but keep the real package name inside
      // package.json. Accept that mapping so alias dependencies resolve.
      if (
        pkg.name === packageName ||
        (packageName === 'zod-from-json-schema-v3' &&
          pkg.name === 'zod-from-json-schema')
      ) {
        return packageRoot;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate installed package ${packageName}`);
}

function installedRuntimeDependencies(pkg, packageRoot) {
  const dependencies = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  };
  for (const [name, version] of Object.entries(pkg.peerDependencies ?? {})) {
    if (pkg.peerDependenciesMeta?.[name]?.optional) continue;
    dependencies[name] = version;
  }
  return Object.keys(dependencies).filter((name) => {
    try {
      resolvePackageRoot(name, packageRoot);
      return true;
    } catch {
      if (pkg.optionalDependencies?.[name]) return false;
      throw new Error(
        `Runtime dependency ${name} required by ${pkg.name} is not installed`,
      );
    }
  });
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
  for (const name of packageNames) {
    let source;
    try {
      source = resolvePackageRoot(name, projectRoot);
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
    for (const name of installedRuntimeDependencies(
      readPackage(source),
      source,
    )) {
      const dependency = resolvePackageRoot(name, source);
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
export const NON_RUNTIME_ARTIFACT = /(?:\.d\.[cm]?ts|\.map)$/i;

function packageCopyOptions(sourceRoot) {
  return {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const segments = relative(sourceRoot, source).split(sep);
      if (segments.length === 1 && segments[0] === '') return true;
      if (segments.includes('node_modules')) return false;
      // Match files only: a directory whose name ends in one of these
      // extensions would otherwise drop everything beneath it.
      return (
        !NON_RUNTIME_ARTIFACT.test(source) || lstatSync(source).isDirectory()
      );
    },
  };
}

function stageWindowsWixPackage(
  sourceRoot,
  targetPackageRootPath,
  outputRoot,
  windowsWixResources,
) {
  const alias = `package-${String(windowsWixResources.entries.length).padStart(4, '0')}`;
  const aliasRoot = join(windowsWixResources.root, alias);
  cpSync(sourceRoot, aliasRoot, packageCopyOptions(sourceRoot));
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
} = {}) {
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
    cpSync(source, target, packageCopyOptions(source));
    if (windowsWixResources) {
      stageWindowsWixPackage(source, target, outputRoot, windowsWixResources);
    }
  }
  inspectDesktopServerRuntime(outputRoot, budget);
  if (windowsWixResources) {
    writeWindowsWixTauriConfig(windowsTauriConfigRoot, windowsWixResources);
  }
  return outputRoot;
}
