import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { readBoundedRegularFileSync } from './regular-file.js';

/**
 * The tsconfig a plugin bundle is built with, read by Station instead of by
 * esbuild (epic #2323 S3 security review, HIGH-2).
 *
 * Left to itself, esbuild looks for `tsconfig.json` beside every input and in
 * every parent directory, and follows `extends` to any path on the host. That
 * made any readable host file a build input: `"extends": "/etc/passwd"`
 * parsed the file and echoed its first token back in the build error. For a
 * draft, that error is served to every Project member. esbuild's `onLoad`
 * containment never sees these reads.
 *
 * So the bundle options pass `tsconfigRaw` (which stops every tsconfig disk
 * read in esbuild) built here from the plugin's OWN `tsconfig.json`:
 *
 * - read only when it is a regular file inside the plugin root, bounded in
 *   size;
 * - `extends` followed only to a regular file whose real path is inside the
 *   plugin root (relative/absolute paths, or a package installed in the
 *   plugin's own `node_modules`), at most {@link MAX_EXTENDS_DEPTH} levels;
 *   anything else is ignored, never read;
 * - only the compiler options esbuild honors are kept, and `paths` entries
 *   whose targets resolve outside the plugin root are dropped. `baseUrl` is
 *   made absolute, so resolution does not depend on the build's working
 *   directory.
 *
 * A file this cannot parse is treated as absent rather than as an error:
 * esbuild never saw it either way, and the host sets `jsx: 'automatic'`
 * itself.
 */

const MAX_TSCONFIG_BYTES = 256 * 1024;
const MAX_EXTENDS_DEPTH = 5;

const HONORED_COMPILER_OPTIONS = [
  'jsx',
  'jsxFactory',
  'jsxFragmentFactory',
  'jsxImportSource',
  'experimentalDecorators',
  'useDefineForClassFields',
  'verbatimModuleSyntax',
  'preserveValueImports',
  'importsNotUsedAsValues',
  'alwaysStrict',
  'strict',
  'target',
] as const;

type CompilerOptions = Record<string, unknown>;

function insideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** Bounded read of a regular file that really lives inside `root`, or null. */
function readContainedFile(root: string, path: string): string | null {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  if (!insideRoot(root, real)) return null;
  return readBoundedRegularFileSync(real, MAX_TSCONFIG_BYTES);
}

/**
 * JSON with comments and trailing commas, as tsconfig allows. One
 * string-aware pass: comments and trailing commas are removed only outside
 * string literals, so a value like `"h,}"` survives intact.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  /** Index in `out` of a comma not yet known to be trailing. */
  let pendingComma = -1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/'))
        i += 1;
      i += 1;
      continue;
    }
    if (/\s/.test(char)) {
      out += char;
      continue;
    }
    if ((char === '}' || char === ']') && pendingComma >= 0) {
      out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
    }
    pendingComma = -1;
    if (char === ',') pendingComma = out.length;
    if (char === '"') inString = true;
    out += char;
  }
  return JSON.parse(out);
}

function resolveExtends(
  root: string,
  fromDir: string,
  specifier: string,
): string | null {
  const candidates: string[] = [];
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    const base = resolve(fromDir, specifier);
    candidates.push(base, `${base}.json`, join(base, 'tsconfig.json'));
  } else {
    // A package extends resolves ONLY within the plugin's own dependencies.
    const base = join(root, 'node_modules', specifier);
    candidates.push(base, `${base}.json`, join(base, 'tsconfig.json'));
  }
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (insideRoot(root, real) && lstatSync(real).isFile()) return real;
    } catch {}
  }
  return null;
}

function loadOptions(
  root: string,
  file: string,
  depth: number,
  dropped: string[],
): CompilerOptions | null {
  const text = readContainedFile(root, file);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;
  const config = parsed as {
    extends?: unknown;
    compilerOptions?: unknown;
  };
  const dir = dirname(file);
  let inherited: CompilerOptions = {};
  const parents = Array.isArray(config.extends)
    ? config.extends
    : config.extends === undefined
      ? []
      : [config.extends];
  if (depth < MAX_EXTENDS_DEPTH) {
    for (const parent of parents) {
      if (typeof parent !== 'string') continue;
      const target = resolveExtends(root, dir, parent);
      const options = target
        ? loadOptions(root, target, depth + 1, dropped)
        : null;
      if (options) inherited = { ...inherited, ...options };
      else dropped.push(parent);
    }
  } else {
    for (const parent of parents)
      if (typeof parent === 'string') dropped.push(parent);
  }
  const own =
    config.compilerOptions &&
    typeof config.compilerOptions === 'object' &&
    !Array.isArray(config.compilerOptions)
      ? (config.compilerOptions as CompilerOptions)
      : {};
  const merged: CompilerOptions = { ...inherited };
  for (const key of HONORED_COMPILER_OPTIONS) {
    if (key in own) merged[key] = own[key];
  }
  // baseUrl and paths are relative to the file that declares them.
  if (typeof own.baseUrl === 'string') {
    merged.baseUrl = resolve(dir, own.baseUrl);
  }
  if (own.paths && typeof own.paths === 'object') {
    merged.paths = own.paths;
    merged.__pathsBase = merged.baseUrl ?? dir;
  }
  return merged;
}

/** The `tsconfigRaw` a plugin under `pluginRoot` (a real path) builds with. */
export function pluginTsconfigRaw(pluginRoot: string): {
  compilerOptions: CompilerOptions;
} {
  return pluginTsconfig(pluginRoot).tsconfigRaw;
}

/**
 * {@link pluginTsconfigRaw} plus the `extends` entries it did not follow
 * (outside the plugin root, hoisted into a workspace `node_modules`,
 * unreadable, or too deep), so a build can say which inherited settings it
 * did not apply instead of silently building differently than `tsc` would.
 */
export function pluginTsconfig(pluginRoot: string): {
  tsconfigRaw: { compilerOptions: CompilerOptions };
  droppedExtends: string[];
} {
  const droppedExtends: string[] = [];
  const tsconfigRaw = buildTsconfigRaw(pluginRoot, droppedExtends);
  return { tsconfigRaw, droppedExtends };
}

function buildTsconfigRaw(
  pluginRoot: string,
  dropped: string[],
): { compilerOptions: CompilerOptions } {
  const file = join(pluginRoot, 'tsconfig.json');
  const loaded = existsSync(file)
    ? loadOptions(pluginRoot, file, 0, dropped)
    : null;
  const options: CompilerOptions = {};
  for (const key of HONORED_COMPILER_OPTIONS) {
    if (loaded && key in loaded) options[key] = loaded[key];
  }
  const pathsBase =
    typeof loaded?.__pathsBase === 'string' ? loaded.__pathsBase : undefined;
  const baseUrl =
    typeof loaded?.baseUrl === 'string' &&
    insideRoot(pluginRoot, loaded.baseUrl)
      ? loaded.baseUrl
      : undefined;
  if (loaded?.paths && pathsBase && insideRoot(pluginRoot, pathsBase)) {
    const paths: Record<string, string[]> = {};
    for (const [pattern, targets] of Object.entries(
      loaded.paths as Record<string, unknown>,
    )) {
      if (!Array.isArray(targets)) continue;
      const contained = targets.filter(
        (target): target is string =>
          typeof target === 'string' &&
          insideRoot(pluginRoot, resolve(pathsBase, target)),
      );
      if (contained.length > 0) paths[pattern] = contained;
    }
    if (Object.keys(paths).length > 0) {
      options.paths = paths;
      options.baseUrl = pathsBase;
    }
  } else if (baseUrl) {
    options.baseUrl = baseUrl;
  }
  return { compilerOptions: options };
}
