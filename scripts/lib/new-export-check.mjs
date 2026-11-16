/**
 * A new export that no other file names: the one shape of the code-health
 * gate's `unused_exports` blocker that recurs on pull requests (nine distinct
 * exports on nine branches, 2026-11-13 to 15), found from Git alone in about
 * a second instead of a full fallow audit.
 *
 * For one pushed commit against its merge base with main:
 *
 * 1. Files the gate can report an unused export in: JavaScript/TypeScript
 *    sources (the extensions fallow analyzes here) that the pushed commit's
 *    `.fallowrc.json` does not exempt from both `unused-exports` and
 *    `unused-types` (tests, examples, the published package sources).
 * 2. Export names those files gain: declarations (`export const|let|var|
 *    function|async function|class|abstract class|type|interface|enum NAME`)
 *    and local export lists (`export { a, b as c }`, the exported name
 *    counts). `export default` and re-exports (`export … from`) are not
 *    collected. A name the same file already exported at the merge base is
 *    inherited, not new.
 * 3. A name that no OTHER tracked file of the pushed commit contains as a
 *    whole word is a finding.
 *
 * It is narrower than the analyzer on purpose. A name that appears in another
 * file by coincidence passes here, and an export whose last caller was
 * removed is never collected; CI's statics job still judges both
 * (`node scripts/code-health-gate.mjs --base=<merge base>`).
 */
import { spawnSync } from 'node:child_process';
import { extname, matchesGlob, posix } from 'node:path';
import { CAPTURE_MAX_BYTES } from './bounded-capture.mjs';

/** fallow's JavaScript/TypeScript extensions (`fallow list --files` here). */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
]);
const BLOCKER_RULES = ['unused-exports', 'unused-types'];
const NAME = '[A-Za-z_$][\\w$]*';
const DECLARATION = new RegExp(
  `^\\s*export\\s+(?:declare\\s+)?(?:async\\s+)?(const\\s+enum|abstract\\s+class|const|let|var|function\\s*\\*?|class|type|interface|enum)\\s+(${NAME})`,
);

function git(args, options = {}) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: CAPTURE_MAX_BYTES,
    ...options,
  });
}

/** Is one rule `off` for this path, after the config's override order? */
function ruleIsOff(path, rule, config) {
  let severity = config?.rules?.[rule];
  for (const override of config?.overrides ?? []) {
    if (!(rule in (override?.rules ?? {}))) continue;
    if ((override.files ?? []).some((glob) => matchesGlob(path, glob)))
      severity = override.rules[rule];
  }
  return severity === 'off';
}

/** Can the code-health gate report an unused export in this path? */
function reportable(path, config) {
  return (
    SOURCE_EXTENSIONS.has(extname(path)) &&
    !path.endsWith('.d.ts') &&
    !BLOCKER_RULES.every((rule) => ruleIsOff(path, rule, config))
  );
}

/**
 * Exported names in a sequence of source lines. Local export lists may span
 * lines; one ending in `from '…'` is a re-export and contributes nothing.
 */
function exportedNames(lines) {
  const names = [];
  let list = null;
  const finishList = (text) => {
    if (/\}\s*from\s*['"]/.test(text)) return;
    const typeList = /^\s*export\s+type\s*\{/.test(text);
    const body = text.slice(text.indexOf('{') + 1, text.indexOf('}'));
    for (const part of body.split(',')) {
      const trimmed = part.trim();
      const spec = trimmed.replace(/^type\s+/, '').split(/\s+as\s+/);
      const name = (spec[1] ?? spec[0])?.trim();
      if (name && new RegExp(`^${NAME}$`).test(name) && name !== 'default')
        names.push({
          name,
          typeOnly: typeList || /^type\s+/.test(trimmed),
        });
    }
  };
  for (const line of lines) {
    if (list !== null) {
      list += ` ${line}`;
      if (line.includes('}')) {
        finishList(list);
        list = null;
      }
      continue;
    }
    if (/^\s*export\s+default\b/.test(line)) continue;
    const declared = DECLARATION.exec(line);
    if (declared) {
      names.push({
        name: declared[2],
        typeOnly: ['type', 'interface'].includes(declared[1]),
      });
      continue;
    }
    if (/^\s*export\s+(?:type\s+)?\{/.test(line)) {
      if (line.includes('}')) finishList(line);
      else list = line;
    }
  }
  return names;
}

/** Added lines per file in `base..sha`, for files that pass `keep`. */
function addedLines(base, sha, keep) {
  const diff = git([
    'diff',
    '--no-renames',
    '--no-color',
    '--diff-filter=AM',
    '-U0',
    `${base}..${sha}`,
  ]);
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
  const files = new Map();
  let current = null;
  for (const line of diff.stdout.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.startsWith('+++ b/') ? line.slice(6) : null;
      current = path && keep(path) ? path : null;
      if (current) files.set(current, []);
    } else if (current && line.startsWith('+') && !line.startsWith('+++'))
      files.get(current).push(line.slice(1));
  }
  return files;
}

function blobAt(rev, path) {
  const shown = git(['show', `${rev}:${path}`]);
  return shown.status === 0 ? shown.stdout : '';
}

/** Lines of `git grep` output at `sha`, as `[path, rest]`. */
function grepAt(sha, args, pathspecs = []) {
  const grep = git(['grep', '-I', ...args, sha, '--', ...pathspecs]);
  if (grep.error || ![0, 1].includes(grep.status ?? -1))
    throw new Error(`git grep failed: ${grep.stderr || grep.error?.message}`);
  const prefix = `${sha}:`;
  return grep.stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      const rest = line.slice(prefix.length);
      const cut = rest.indexOf(':');
      return [rest.slice(0, cut), rest.slice(cut + 1)];
    });
}

/** Files fallow treats as entry points without reading code: their exports are externally reachable. */
const ENTRY_REFERENCE_PATHS = [
  'package.json',
  '.github',
  '.githooks',
  '.fallowrc.json',
];

/**
 * Every JavaScript/TypeScript module of `sha`, read in one `git cat-file
 * --batch` (about 11k files, ~1s here). The searches below then cost the same
 * whatever the number of new names: a long-lived branch adds hundreds against
 * its merge base, and a per-name `git grep` took over ten seconds for 105.
 */
function modulesAt(sha) {
  const listed = git(['ls-tree', '-r', '-z', sha]);
  if (listed.status !== 0)
    throw new Error(`git ls-tree failed: ${listed.stderr}`);
  const modules = listed.stdout
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [, type, oid] = line.slice(0, tab).split(' ');
      return { type, oid, path: line.slice(tab + 1) };
    })
    .filter(
      (entry) =>
        entry.type === 'blob' && SOURCE_EXTENSIONS.has(extname(entry.path)),
    );
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    input: modules.map((entry) => `${entry.oid}\n`).join(''),
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (batch.status !== 0) throw new Error('git cat-file --batch failed');
  const out = batch.stdout;
  let offset = 0;
  return modules.map(({ path }) => {
    const end = out.indexOf(10, offset);
    const size = Number(
      out.subarray(offset, end).toString('latin1').split(' ')[2],
    );
    const text = out.subarray(end + 1, end + 1 + size).toString('utf8');
    offset = end + 1 + size + 1;
    return { path, text };
  });
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const WHOLE_IMPORT =
  /(?:\*\s*as\s+[\w$]+\s+from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const GLOB_IMPORT = /import\.meta\.glob\(\s*\[?\s*['"]([^'"]+)['"]/g;
const withoutExtension = (path) => path.replace(/\.[^./]+$/, '');

/** Defining files another module loads whole: every export counts as used. */
function wholeImportedPaths(modules, paths) {
  const byStem = new Map();
  for (const path of paths) {
    byStem.set(withoutExtension(path), path);
    if (/\/index\.[^/]+$/.test(path))
      byStem.set(path.replace(/\/index\.[^/]+$/, ''), path);
  }
  const whole = new Set();
  for (const { path: file, text } of modules) {
    if (text.includes('import') || text.includes('require'))
      for (const [, specifier] of text.matchAll(WHOLE_IMPORT)) {
        if (!specifier.startsWith('.')) continue;
        const target = withoutExtension(
          posix.normalize(posix.join(posix.dirname(file), specifier)),
        );
        const hit = byStem.get(target);
        if (hit && hit !== file) whole.add(hit);
      }
    if (text.includes('import.meta.glob('))
      for (const [, pattern] of text.matchAll(GLOB_IMPORT)) {
        const resolved = posix.normalize(
          posix.join(posix.dirname(file), pattern),
        );
        for (const path of paths)
          if (matchesGlob(path, resolved)) whole.add(path);
      }
  }
  return whole;
}

/**
 * For one pushed commit: `findings` (`{ path, name }` for each new export no
 * other module names) and `checked` (new names searched). Throws when Git
 * cannot answer.
 *
 * Three cases the analyzer does not report are left out, each found by
 * fallow's own `--trace` on a landed commit this check first flagged:
 * - an entry-point file (a test-directory module, or a file package.json,
 *   a workflow, a hook or .fallowrc.json names): fallow treats its exports
 *   as externally accessible;
 * - a module another file imports whole (`import * as`, `import()`,
 *   `require()`, or an `import.meta.glob` pattern that matches it): every
 *   export counts as used, and a name search cannot see it;
 * - a type-only export used elsewhere in its own file
 *   (`ignoreExportsUsedInFile` for types in .fallowrc.json).
 * Only module sources count as naming an export: a name in prose or
 * configuration is not an import to the analyzer either.
 */
export function newUnnamedExports({ base, sha }) {
  const configText = git(['show', `${sha}:.fallowrc.json`]);
  const config = configText.status === 0 ? JSON.parse(configText.stdout) : {};
  const added = addedLines(base, sha, (path) => reportable(path, config));
  const candidates = [];
  for (const [path, lines] of added) {
    if (path.includes('/__tests__/') || path.startsWith('__tests__/')) continue;
    if (!lines.some((line) => /\bexport\b/.test(line))) continue;
    const inherited = new Set(
      exportedNames(blobAt(base, path).split('\n')).map((entry) => entry.name),
    );
    const seen = new Set();
    for (const entry of exportedNames(lines))
      if (!inherited.has(entry.name) && !seen.has(entry.name)) {
        seen.add(entry.name);
        candidates.push({ path, ...entry });
      }
  }
  if (candidates.length === 0) return { findings: [], checked: 0 };
  const names = new Set(candidates.map((entry) => entry.name));
  const definers = [...new Set(candidates.map((entry) => entry.path))];
  const entries = new Set(
    grepAt(
      sha,
      ['-o', '-F', ...definers.flatMap((path) => ['-e', path])],
      ENTRY_REFERENCE_PATHS,
    ).map(([, match]) => match),
  );
  const modules = modulesAt(sha);
  const wholeImports = wholeImportedPaths(modules, definers);
  // Whole-word occurrences of each new name, per module, in one pass.
  const namedIn = new Map([...names].map((name) => [name, new Map()]));
  for (const { path, text } of modules)
    for (const [token] of text.matchAll(IDENTIFIER)) {
      const files = namedIn.get(token);
      if (files) files.set(path, (files.get(path) ?? 0) + 1);
    }
  const findings = candidates
    .filter(({ path, name, typeOnly }) => {
      if (entries.has(path) || wholeImports.has(path)) return false;
      const files = namedIn.get(name);
      if ([...files.keys()].some((file) => file !== path)) return false;
      return !(typeOnly && (files.get(path) ?? 0) > 1);
    })
    .map(({ path, name }) => ({ path, name }));
  return { findings, checked: names.size };
}
