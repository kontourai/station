import { execSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import type { build as EsbuildBuild, context as EsbuildContext } from 'esbuild';
import {
  type AgentPluginManifestReport,
  parseAgentPluginManifest,
} from './agent-plugin-manifest.js';
import { readPluginManifest } from './parsers.js';
import { pluginTsconfig } from './plugin-tsconfig.js';
import { isRegularFileSync } from './regular-file.js';

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
let esbuildModule:
  | { build: typeof EsbuildBuild; context: typeof EsbuildContext }
  | undefined;

async function loadEsbuild(): Promise<typeof EsbuildBuild> {
  return (await loadEsbuildModule()).build;
}

async function loadEsbuildModule(): Promise<{
  build: typeof EsbuildBuild;
  context: typeof EsbuildContext;
}> {
  if (esbuildModule) return esbuildModule;
  try {
    // A literal specifier on purpose: it stays statically analysable for the
    // publish-surface contract, and esbuild leaves a dynamic import of an
    // *external* package as a real runtime `import()` rather than inlining it.
    const loaded = await import('esbuild');
    esbuildModule = { build: loaded.build, context: loaded.context };
    return esbuildModule;
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

/**
 * Registration footer for a DRAFT build (epic #2323 S3).
 *
 * A draft is previewed from a Project folder without being installed, and it
 * must never take the place of an installed plugin's registration: an
 * installed plugin and a draft of it routinely share a manifest `name`, and
 * `window.__station_ai_plugins[name]` is what the installed-plugin registry
 * admits. So a draft writes ONLY to a separate global, keyed by an opaque
 * per-generation key the host minted — never by anything the manifest chose.
 */
export function draftRegistrationFooter(registrationKey: string): string {
  return `window.__station_ai_plugin_drafts = window.__station_ai_plugin_drafts || {}; window.__station_ai_plugin_drafts[${JSON.stringify(registrationKey)}] = __plugin;`;
}

export interface BuildResult {
  built: boolean;
  bundlePath?: string;
  cssPath?: string;
  /** Non-fatal notes about how the bundle was built (e.g. a dropped tsconfig extends). */
  warnings?: string[];
}

/** The one-line warning for each tsconfig `extends` a build did not follow. */
function droppedExtendsWarnings(droppedExtends: readonly string[]): string[] {
  return droppedExtends.map(
    (entry) =>
      `tsconfig.json extends ${JSON.stringify(entry)} was not applied: it is outside the plugin folder (or could not be read), so its compiler options are ignored.`,
  );
}

/** Projects only validated build fields. Root lookalikes and unknown client namespaces never control author builds. */
export function readPluginBuildManifest(pluginDir: string): PluginManifest {
  const candidate = readPluginManifest(pluginDir);
  if (
    !String(
      (candidate as unknown as { $schema?: unknown }).$schema ?? '',
    ).startsWith('https://agent-plugins.org/schemas/')
  )
    return candidate;
  const reports: AgentPluginManifestReport[] = [];
  const parsed = parseAgentPluginManifest(candidate, (report) =>
    reports.push(report),
  );
  if (
    !parsed ||
    reports.some(
      (report) =>
        report.code === 'station-extension-invalid' ||
        report.code === 'manifest-invalid',
    )
  )
    throw new Error(
      `Agent Plugin build manifest is invalid: ${reports.find((report) => report.code !== 'unknown-manifest-field')?.message ?? 'unknown validation failure'}`,
    );
  return {
    name: parsed.manifest.name,
    version: parsed.manifest.version ?? '0.0.0-agent-plugin-unversioned',
    ...(parsed.stationExtension?.title
      ? { displayName: parsed.stationExtension.title }
      : {}),
    ...(parsed.stationExtension?.entrypoint
      ? { entrypoint: parsed.stationExtension.entrypoint }
      : {}),
    ...(parsed.stationExtension?.build
      ? { build: parsed.stationExtension.build }
      : {}),
  };
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
  const manifest = validatedManifest ?? readPluginBuildManifest(pluginDir);
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
  if (!isRegularFileSync(realpathSync(entrypoint))) {
    throw new Error(`Plugin entrypoint is not a regular file: ${entrypoint}`);
  }

  ensurePluginDeps(pluginDir);
  if (existsSync(outdir) && lstatSync(outdir).isSymbolicLink()) {
    throw new Error(
      `Plugin build output directory escapes plugin root: ${outdir}`,
    );
  }
  mkdirSync(outdir, { recursive: true });
  assertRealPathInside([pluginRoot], outdir, 'Plugin build output directory');

  const tsconfig = pluginTsconfig(pluginRoot);
  await esbuild(
    pluginBundleOptions({
      pluginRoot,
      tsconfigRaw: tsconfig.tsconfigRaw,
      entrypoint,
      outfile,
      isDev,
      footer: registrationFooter(manifest.name),
      allowedRoots,
    }),
  );

  const cssPath = outfile.replace(/\.js$/, '.css');
  const warnings = droppedExtendsWarnings(tsconfig.droppedExtends);
  return {
    built: true,
    bundlePath: outfile,
    cssPath: existsSync(cssPath) ? cssPath : undefined,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * The one esbuild configuration every plugin bundle is built with: installed
 * builds and draft builds differ only in where the output goes and which
 * global the footer registers on. Sharing it keeps a draft's runtime shape
 * (externals, shim, containment) identical to what an install would produce.
 */
function pluginBundleOptions({
  pluginRoot,
  tsconfigRaw,
  entrypoint,
  outfile,
  isDev,
  footer,
  allowedRoots,
  logLevel = 'info',
  sourcemap = isDev,
}: {
  /** Real path of the plugin folder. */
  pluginRoot: string;
  /** From `pluginTsconfig(pluginRoot)`; never read by esbuild from disk. */
  tsconfigRaw: ReturnType<typeof pluginTsconfig>['tsconfigRaw'];
  entrypoint: string;
  outfile: string;
  isDev: boolean;
  footer: string;
  allowedRoots: string[];
  logLevel?: 'info' | 'silent';
  sourcemap?: boolean;
}): Parameters<typeof EsbuildBuild>[0] {
  return {
    // Relative paths in diagnostics and `baseUrl` resolve against the plugin.
    absWorkingDir: pluginRoot,
    // Never let esbuild read a tsconfig from disk: it searches parent
    // directories and follows `extends` anywhere on the host, outside every
    // containment check below (S3 review HIGH-2). The plugin's own tsconfig
    // is read, contained and filtered by `pluginTsconfig` instead.
    tsconfigRaw,
    entryPoints: [entrypoint],
    bundle: true,
    format: 'iife',
    globalName: '__plugin',
    outfile,
    jsx: 'automatic',
    sourcemap: sourcemap ? 'inline' : false,
    banner: { js: RUNTIME_SHIM },
    footer: { js: footer },
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
            // A FIFO (or device) as an input would block esbuild's read
            // forever and hold the build open. Decided on the descriptor,
            // opened non-blocking, not by a stat that a swap could outrun.
            if (!isRegularFileSync(realpathSync(args.path))) {
              throw new Error(`${NOT_REGULAR_FILE_MARKER}: ${args.path}`);
            }
            return null;
          });
        },
      },
    ],
    logLevel,
  };
}

const NOT_REGULAR_FILE_MARKER = 'Plugin build input is not a regular file';

/** One esbuild message, reduced to what a draft author needs and nothing host-local. */
export interface PluginDraftBuildDiagnostic {
  readonly text: string;
  /** Path relative to the plugin root, when esbuild attributed the message to a file. */
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface PluginDraftBuildOptions {
  /** The author's plugin folder. Read only: nothing is written under it. */
  readonly pluginDir: string;
  /** Host-owned output directory. Must not lie inside `pluginDir`. */
  readonly outdir: string;
  /** Opaque host-minted key the bundle registers under (see {@link draftRegistrationFooter}). */
  readonly registrationKey: string;
  /** The manifest the host already parsed and validated. */
  readonly manifest: PluginManifest;
  /** Aborting cancels the esbuild run and resolves as a failed build. */
  readonly signal?: AbortSignal;
}

export type PluginDraftBuildResult =
  | {
      readonly ok: true;
      readonly bundlePath: string;
      readonly cssPath?: string;
      /** Non-fatal notes, shown with the revision. */
      readonly warnings?: readonly PluginDraftBuildDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly PluginDraftBuildDiagnostic[];
    };

const MAX_DRAFT_DIAGNOSTICS = 20;
const MAX_DRAFT_DIAGNOSTIC_TEXT = 500;

/**
 * Builds a plugin DRAFT for in-app preview (epic #2323 S3).
 *
 * Three things distinguish it from {@link buildPlugin}, each deliberate:
 *
 * - It never installs dependencies and never writes into the author's folder.
 *   The install path runs `npm install` in the plugin directory and writes
 *   `<dir>/dist`; a preview that did either would mutate the very Project the
 *   author (or their agent) is editing, on every keystroke. Output goes to the
 *   host-owned `outdir`, and a dependency that is not already resolvable is
 *   reported as a diagnostic, not fetched.
 * - It registers under {@link draftRegistrationFooter}, never the installed
 *   global, so a draft cannot shadow an installed plugin of the same name.
 * - Build errors come back as bounded diagnostics rather than a throw, because
 *   a broken draft is the normal state of a draft being written.
 *
 * Input containment is the install path's own: the same allowed roots and the
 * same realpath check on every file esbuild loads, so a symlink in the Project
 * folder cannot pull a file from outside it into the bundle.
 */
export async function buildPluginDraft(
  options: PluginDraftBuildOptions,
): Promise<PluginDraftBuildResult> {
  const { pluginDir, outdir, registrationKey, manifest, signal } = options;
  const fail = (text: string): PluginDraftBuildResult => ({
    ok: false,
    diagnostics: [{ text }],
  });
  if (manifest.build) {
    return fail(
      'plugin.json declares a build command. Station does not run manifest build commands; declare an entrypoint instead.',
    );
  }
  if (!manifest.entrypoint) {
    return fail(
      'plugin.json declares no entrypoint, so there is no bundle to preview.',
    );
  }
  let pluginRoot: string;
  try {
    pluginRoot = realpathSync(pluginDir);
  } catch {
    return fail('The plugin folder could not be read.');
  }
  const resolvedOutdir = resolve(outdir);
  if (
    resolvedOutdir === pluginRoot ||
    resolvedOutdir.startsWith(`${pluginRoot}${sep}`) ||
    resolve(pluginDir) === resolvedOutdir ||
    resolvedOutdir.startsWith(`${resolve(pluginDir)}${sep}`)
  ) {
    throw new Error('Draft build output must not be inside the plugin folder');
  }
  const esbuild = await loadEsbuildModule();
  const entrypoint = join(pluginRoot, manifest.entrypoint);
  const allowedRoots = buildAllowedInputRoots(pluginRoot);
  try {
    assertRealPathInside(allowedRoots, entrypoint, 'Plugin entrypoint');
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    return fail(
      code === 'ENOENT'
        ? `The entrypoint ${manifest.entrypoint} does not exist.`
        : `The entrypoint ${manifest.entrypoint} resolves outside the plugin folder.`,
    );
  }
  if (!isRegularFileSync(realpathSync(entrypoint))) {
    return fail(
      `The entrypoint ${manifest.entrypoint} is not a regular file, so it cannot be bundled.`,
    );
  }
  const special = findSpecialFile(pluginRoot);
  if (special) {
    return {
      ok: false,
      diagnostics: [
        {
          text: 'This is not a regular file (a pipe, socket or device), so the folder cannot be bundled. Remove it or move it out of the plugin folder.',
          file: special,
        },
      ],
    };
  }
  mkdirSync(resolvedOutdir, { recursive: true });
  const outfile = join(resolvedOutdir, 'bundle.js');
  const tsconfig = pluginTsconfig(pluginRoot);
  // A context rather than a one-shot build so a caller's abort (the draft
  // service's build deadline) can cancel the esbuild run itself.
  let context: Awaited<ReturnType<typeof EsbuildContext>> | undefined;
  const cancel = () => void context?.cancel().catch(() => {});
  try {
    if (signal?.aborted) return fail(DRAFT_BUILD_STOPPED);
    context = await esbuild.context(
      pluginBundleOptions({
        pluginRoot,
        tsconfigRaw: tsconfig.tsconfigRaw,
        entrypoint,
        outfile,
        isDev: true,
        footer: draftRegistrationFooter(registrationKey),
        allowedRoots,
        logLevel: 'silent',
        // An inline map's `sources` are relative to the host-owned outdir,
        // so they would publish Station's storage layout to every member.
        sourcemap: false,
      }),
    );
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return fail(DRAFT_BUILD_STOPPED);
    await context.rebuild();
    if (signal?.aborted) return fail(DRAFT_BUILD_STOPPED);
  } catch (error) {
    if (signal?.aborted) return fail(DRAFT_BUILD_STOPPED);
    return { ok: false, diagnostics: draftDiagnostics(error, pluginRoot) };
  } finally {
    signal?.removeEventListener('abort', cancel);
    void context?.dispose().catch(() => {});
  }
  const cssPath = join(resolvedOutdir, 'bundle.css');
  const hasCss = existsSync(cssPath);
  const size = statSync(outfile).size + (hasCss ? statSync(cssPath).size : 0);
  if (size > MAX_DRAFT_BUNDLE_BYTES) {
    rmSync(resolvedOutdir, { recursive: true, force: true });
    return fail(
      `The draft bundle is ${Math.ceil(size / 1024 / 1024)} MB, over the ${MAX_DRAFT_BUNDLE_BYTES / 1024 / 1024} MB preview limit.`,
    );
  }
  const warnings = droppedExtendsWarnings(tsconfig.droppedExtends).map(
    (text) => ({ text, file: 'tsconfig.json' }),
  );
  return {
    ok: true,
    bundlePath: outfile,
    ...(hasCss ? { cssPath } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

const DRAFT_BUILD_STOPPED = 'The draft build was stopped before it finished.';

const SPECIAL_FILE_SWEEP_BUDGET = 5_000;
const SPECIAL_FILE_SWEEP_SKIP = new Set(['node_modules', '.git']);

/**
 * First line of defence for a draft (S3 review round 3): esbuild's resolver
 * reads files such as `package.json` itself, never through `onLoad`, so a
 * FIFO there blocks inside esbuild where no check can see it. This lstat
 * sweep refuses any pipe, socket or device under the plugin root before a
 * build starts. It is racy by nature (the file can appear afterwards), which
 * is why the server also runs each draft build in a disposable process that
 * is killed at its deadline. Bounded; a tree past the budget is not swept
 * further. Symlinks are checked by target type and never descended.
 */
function findSpecialFile(pluginRoot: string): string | null {
  let budget = SPECIAL_FILE_SWEEP_BUDGET;
  const isSpecial = (stats: Stats) =>
    stats.isFIFO() ||
    stats.isSocket() ||
    stats.isCharacterDevice() ||
    stats.isBlockDevice();
  const visit = (dir: string): string | null => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (SPECIAL_FILE_SWEEP_SKIP.has(entry)) continue;
      budget -= 1;
      if (budget < 0) return null;
      const path = join(dir, entry);
      let stats: Stats;
      try {
        stats = lstatSync(path);
        if (stats.isSymbolicLink()) {
          const target = statSync(path);
          if (isSpecial(target))
            return relative(pluginRoot, path).replaceAll('\\', '/');
          continue;
        }
      } catch {
        continue;
      }
      if (isSpecial(stats))
        return relative(pluginRoot, path).replaceAll('\\', '/');
      if (stats.isDirectory()) {
        const found = visit(path);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(pluginRoot);
}

/**
 * Upper bound on one draft revision's js + css. The server reads a revision
 * into memory to digest and serve it, so the builder is where it is bounded.
 */
export const MAX_DRAFT_BUNDLE_BYTES = 8 * 1024 * 1024;

function draftDiagnostics(
  error: unknown,
  pluginRoot: string,
): PluginDraftBuildDiagnostic[] {
  type EsbuildLocation = {
    file?: unknown;
    line?: unknown;
    column?: unknown;
  } | null;
  const messages = (
    error as {
      errors?: Array<{
        text?: unknown;
        location?: EsbuildLocation;
        notes?: Array<{ location?: EsbuildLocation }>;
      }>;
    }
  )?.errors;
  const inRoot = (location: EsbuildLocation | undefined) => {
    if (typeof location?.file !== 'string') return undefined;
    const file = relative(
      pluginRoot,
      resolve(pluginRoot, location.file),
    ).replaceAll('\\', '/');
    return file.startsWith('..') || isAbsolute(file) ? undefined : file;
  };
  const at = (location: EsbuildLocation | undefined, file: string) => ({
    file,
    ...(typeof location?.line === 'number' ? { line: location.line } : {}),
    ...(typeof location?.column === 'number'
      ? { column: location.column }
      : {}),
  });
  const bound = (text: string) =>
    text.length > MAX_DRAFT_DIAGNOSTIC_TEXT
      ? `${text.slice(0, MAX_DRAFT_DIAGNOSTIC_TEXT)}…`
      : text;
  // Host-absolute paths are replaced by the plugin-relative path: the author
  // needs to know which of THEIR files, not where Station keeps things.
  const scrub = (text: string) => text.split(pluginRoot + sep).join('');
  if (!Array.isArray(messages) || messages.length === 0) {
    const text =
      error instanceof Error ? error.message : 'The draft build failed.';
    return [{ text: bound(scrub(text)) }];
  }
  return messages.slice(0, MAX_DRAFT_DIAGNOSTICS).map((message) => {
    const rawText = String(message.text ?? 'Build error');
    // Station's own input refusals are thrown from its onLoad hook, so esbuild
    // locates them in this module; the file that matters is the IMPORTER,
    // which esbuild names in a note. Checked before the outside-file scrub
    // below, which would otherwise swallow them. The refused path itself is
    // never echoed: for a symlink escape it is a host path.
    const refusal = rawText.includes('escapes plugin root')
      ? 'This import resolves outside the plugin folder (a symlink?), so it cannot be bundled.'
      : rawText.includes(NOT_REGULAR_FILE_MARKER)
        ? 'This import is not a regular file (a FIFO or device?), so it cannot be bundled.'
        : undefined;
    if (refusal) {
      const importer = [
        message.location,
        ...(message.notes ?? []).map((note) => note.location),
      ]
        .map((location) => ({ location, file: inRoot(location) }))
        .find((candidate) => candidate.file);
      return {
        text: refusal,
        ...(importer?.file ? at(importer.location, importer.file) : {}),
      };
    }
    const text = rawText;
    const location = message.location ?? undefined;
    const rawFile =
      typeof location?.file === 'string' ? location.file : undefined;
    const file = rawFile
      ? relative(pluginRoot, resolve(pluginRoot, rawFile)).replaceAll('\\', '/')
      : undefined;
    // A message located in a file outside the plugin folder is esbuild
    // quoting a file the author does not own (a parent package.json, a
    // dependency). Its text can carry that file's contents, so it is never
    // echoed; only that it happened.
    if (file && (file.startsWith('..') || isAbsolute(file))) {
      return {
        text: 'A file outside the plugin folder could not be read or parsed while building.',
      };
    }
    return {
      text: bound(scrub(text)),
      ...(file ? { file } : {}),
      ...(typeof location?.line === 'number' ? { line: location.line } : {}),
      ...(typeof location?.column === 'number'
        ? { column: location.column }
        : {}),
    };
  });
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
