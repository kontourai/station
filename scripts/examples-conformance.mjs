/**
 * Examples conformance gate.
 *
 * `examples/` is the surface people copy from, and until now exactly one of the
 * nineteen examples was exercised by any test. A manifest could name an
 * entrypoint that had been renamed, a README could document a command that no
 * longer exists, and nothing would notice.
 *
 * This checks every example against the real contract and the real files on
 * disk:
 *
 *   - `plugin.json` parses and carries the fields PluginManifest requires.
 *   - Every path the manifest names actually exists: entrypoint, serverModule,
 *     agent sources, layout sources, prompt sources.
 *   - Every `npm run <script>` a README documents exists in that example's
 *     package.json — the failure mode that shipped `npm run dev` for an example
 *     with no dev script.
 *   - Declared dependency on `@kontourai/station-sdk` resolves to a real
 *     workspace version rather than a stale range.
 *   - Every TypeScript source under `examples/` is compiled by one of the
 *     projects `npm run typecheck:examples` names, or its example is listed in
 *     TYPECHECK_EXCLUDED with a README note saying so (station#2343: thirteen
 *     examples had TS sources no compiler ever saw, and 76 errors hid in one).
 *
 * That every manifest declares only fields the runtime reads is proven by
 * src-server/services/plugins/__tests__/example-manifests-conformance.test.ts,
 * which loads each one through the install preview's own reader (#2401).
 *
 * Live build/run proof is a separate lane: see `--build`. Examples that need
 * credentials are declared here rather than skipped silently, so "not proven"
 * is visible instead of being confused with "passing".
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { npmInvocation } from './lib/npm-cli.mjs';

const ROOT = process.cwd();
const EXAMPLES_DIR = join(ROOT, 'examples');

/**
 * Examples whose runtime proof needs a credential or an external service.
 * Listed explicitly so an unproven example is a disclosed gap, not a silence.
 */
export const CREDENTIAL_GATED = new Map([
  ['elevenlabs-voice', 'needs an ElevenLabs API key'],
  ['openai-realtime-voice', 'needs an OpenAI API key'],
  ['nova-sonic-voice', 'needs AWS Bedrock credentials for Nova Sonic'],
  ['meeting-transcription', 'needs a speech-to-text provider credential'],
]);

/**
 * Examples deliberately left out of `typecheck:examples`, as name -> reason.
 * This is the ONLY place an example with TypeScript sources may opt out, and
 * an entry is only honoured when the example's README carries
 * TYPECHECK_EXCLUDED_README_NOTE, so a reader copying from it is told. Empty
 * means every example that ships TypeScript is type-checked.
 */
export const TYPECHECK_EXCLUDED = new Map();

/** The sentence an excluded example's README must contain. */
export const TYPECHECK_EXCLUDED_README_NOTE =
  'Unmaintained reference code: not type-checked by `npm run typecheck:examples`.';

const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;
// Declaration files are compiler output here (shared-providers emits its
// `providers/*.d.ts`), not sources anyone authors or copies.
const TS_DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);

/** Every authored TypeScript file under `dir`, absolute. */
export function typeScriptSources(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...typeScriptSources(full));
    } else if (TS_SOURCE.test(entry.name) && !TS_DECLARATION.test(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}

/** The tsconfig paths `typecheck:examples` passes to `-p`, repo-relative. */
export function typecheckedProjects(command) {
  return typecheckSegments(command).map((segment) => segment.project);
}

// The whole segment is the slot runner, bare flags and one `-p <tsconfig>`,
// and nothing else: `… -p x || true`, a pipe or a `;` would let the compile
// fail without failing the chain. A flag that takes a value does not match;
// the chain uses none.
const TSC_SEGMENT =
  /^node scripts\/tsc-slot\.mjs((?:\s+--?[\w-]+)*\s+-p\s+[^\s|;&]+(?:\s+--?[\w-]+)*)$/;

/**
 * The compiler runs `typecheck:examples` performs: `&&`-joined segments that
 * invoke the slot runner, each with the project it passes to `-p`. A segment
 * that runs anything else (`echo -p x`, say) type-checks nothing and is not
 * counted, however its arguments read.
 */
export function typecheckSegments(command) {
  const segments = [];
  for (const raw of (command ?? '').split('&&')) {
    const match = TSC_SEGMENT.exec(raw.trim());
    if (!match) continue;
    const args = match[1].trim().split(/\s+/);
    const at = args.indexOf('-p');
    if (at === -1 || !args[at + 1]) continue;
    segments.push({ project: args[at + 1], args });
  }
  return segments;
}

/** `// @ts-nocheck` (or its block form) switches a file's checking off. */
const TS_NOCHECK = /^\s*(?:\/\/|\/\*)\s*@ts-nocheck\b/m;

/**
 * The files TypeScript itself resolves for a project -- the compiler's own
 * include/exclude/files evaluation, not a re-implementation of its globbing.
 */
export function projectFiles(tsconfigPath) {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      `${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(tsconfigPath),
  );
  return {
    files: parsed.fileNames.map((file) => resolve(file)),
    noCheck: parsed.options.noCheck === true,
  };
}

/**
 * Problems with how `examples/` TypeScript is (not) type-checked: a source no
 * `typecheck:examples` project compiles, or an exclusion that is stale,
 * contradicted by coverage, or undisclosed in the example's README.
 */
export function typecheckCoverageProblems({
  root = ROOT,
  examplesDir = join(root, 'examples'),
  typecheckCommand = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ).scripts?.['typecheck:examples'],
  excluded = TYPECHECK_EXCLUDED,
} = {}) {
  const problems = [];
  const covered = new Set();
  for (const { project, args } of typecheckSegments(typecheckCommand)) {
    const path = resolve(root, project);
    if (!existsSync(path)) {
      problems.push(`typecheck:examples names a missing project: ${project}`);
      continue;
    }
    const { files, noCheck } = projectFiles(path);
    // A project compiled without checking covers nothing.
    if (noCheck || args.includes('--noCheck')) {
      problems.push(
        `${project} is compiled with noCheck, so typecheck:examples does not type-check it`,
      );
      continue;
    }
    for (const file of files) covered.add(file);
  }

  const examples = listExamples(examplesDir);
  for (const name of examples) {
    const dir = join(examplesDir, name);
    const sources = typeScriptSources(dir);
    const uncovered = sources.filter((file) => !covered.has(file));
    if (excluded.has(name)) {
      if (sources.length === 0) {
        problems.push(
          `${name}: listed in TYPECHECK_EXCLUDED but has no TypeScript sources`,
        );
      } else if (uncovered.length < sources.length) {
        problems.push(
          `${name}: listed in TYPECHECK_EXCLUDED but typecheck:examples compiles it`,
        );
      }
      const readme = join(dir, 'README.md');
      if (
        !existsSync(readme) ||
        !readFileSync(readme, 'utf8').includes(TYPECHECK_EXCLUDED_README_NOTE)
      ) {
        problems.push(
          `${name}: listed in TYPECHECK_EXCLUDED but its README does not say "${TYPECHECK_EXCLUDED_README_NOTE}"`,
        );
      }
      continue;
    }
    for (const file of sources) {
      if (TS_NOCHECK.test(readFileSync(file, 'utf8'))) {
        problems.push(
          `${relative(root, file).split(sep).join('/')} disables type checking with @ts-nocheck`,
        );
      }
    }
    for (const file of uncovered) {
      problems.push(
        `${relative(root, file).split(sep).join('/')} is TypeScript that no typecheck:examples project compiles; add it to a project or list ${name} in TYPECHECK_EXCLUDED`,
      );
    }
  }
  for (const name of excluded.keys()) {
    if (!examples.includes(name)) {
      problems.push(`TYPECHECK_EXCLUDED names a missing example: ${name}`);
    }
  }
  return problems;
}

/** Manifest fields whose values are repo-relative paths that must exist. */
function declaredPaths(manifest) {
  const paths = [];
  if (manifest.entrypoint) paths.push(['entrypoint', manifest.entrypoint]);
  if (manifest.serverModule)
    paths.push(['serverModule', manifest.serverModule]);
  if (manifest.prompts?.source)
    paths.push(['prompts.source', manifest.prompts.source]);
  for (const agent of manifest.agents ?? []) {
    paths.push([`agents[${agent.slug}].source`, agent.source]);
  }
  for (const layout of [
    ...(manifest.layout ? [manifest.layout] : []),
    ...(manifest.layouts ?? []),
  ]) {
    paths.push([`layout[${layout.slug}].source`, layout.source]);
  }
  return paths;
}

/** `npm run <name>` occurrences in a markdown file. */
export function documentedScripts(markdown) {
  return [...markdown.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1]);
}

export function checkExample(dir, name) {
  const problems = [];
  const manifestPath = join(dir, 'plugin.json');
  const packagePath = join(dir, 'package.json');

  let manifest = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      problems.push(`plugin.json does not parse: ${error.message}`);
    }
  }

  if (manifest) {
    // PluginManifest requires exactly these two.
    for (const field of ['name', 'version']) {
      if (typeof manifest[field] !== 'string' || !manifest[field]) {
        problems.push(`plugin.json is missing required "${field}"`);
      }
    }
    if (manifest.name && manifest.name !== name) {
      problems.push(
        `plugin.json name "${manifest.name}" does not match directory "${name}"`,
      );
    }
    for (const [field, value] of declaredPaths(manifest)) {
      if (!existsSync(resolve(dir, value))) {
        problems.push(`${field} points at a missing file: ${value}`);
      }
    }
  }

  let pkg = null;
  if (existsSync(packagePath)) {
    try {
      pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    } catch (error) {
      problems.push(`package.json does not parse: ${error.message}`);
    }
  }

  // A README that documents a script the example does not define sends the
  // reader straight into an error.
  const readmePath = join(dir, 'README.md');
  if (existsSync(readmePath)) {
    const documented = new Set(
      documentedScripts(readFileSync(readmePath, 'utf8')),
    );
    const defined = new Set(Object.keys(pkg?.scripts ?? {}));
    for (const script of documented) {
      // Root-level scripts are legitimately referenced from an example README.
      if (defined.has(script)) continue;
      const rootScripts = JSON.parse(
        readFileSync(join(ROOT, 'package.json'), 'utf8'),
      ).scripts;
      if (script in rootScripts) continue;
      problems.push(
        `README documents \`npm run ${script}\`, which neither this example nor the repo root defines`,
      );
    }
  } else {
    problems.push('no README.md');
  }

  return problems;
}

export function listExamples(examplesDir = EXAMPLES_DIR) {
  return readdirSync(examplesDir)
    .filter((name) => statSync(join(examplesDir, name)).isDirectory())
    .sort();
}

export function uncataloguedExamples(
  examples = listExamples(),
  catalog = readFileSync(join(EXAMPLES_DIR, 'README.md'), 'utf8'),
) {
  return examples.filter((name) => !catalog.includes(`](${name}/README.md)`));
}

function buildExample(dir, name) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return { name, status: 'no-package' };
  const scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
  if (!scripts.build) return { name, status: 'no-build-script' };

  const npm = npmInvocation(['run', 'build']);
  const result = spawnSync(npm.command, npm.args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    name,
    status: result.status === 0 ? 'built' : 'failed',
    output: result.status === 0 ? '' : `${result.stdout}${result.stderr}`,
  };
}

function main() {
  const withBuild = process.argv.includes('--build');
  const examples = listExamples();
  console.log(`\nExamples conformance (${examples.length} examples).`);

  let failed = 0;
  const uncatalogued = uncataloguedExamples(examples);
  if (uncatalogued.length > 0) {
    failed += 1;
    console.error(
      `\n  examples/README.md does not list: ${uncatalogued.join(', ')}`,
    );
  }
  const typecheckProblems = typecheckCoverageProblems();
  if (typecheckProblems.length > 0) {
    failed += 1;
    console.error('\n  TypeScript coverage (typecheck:examples):');
    for (const problem of typecheckProblems) console.error(`    - ${problem}`);
  }
  for (const name of examples) {
    const problems = checkExample(join(EXAMPLES_DIR, name), name);
    if (problems.length === 0) continue;
    failed += 1;
    console.error(`\n  ${name}:`);
    for (const problem of problems) console.error(`    - ${problem}`);
  }

  if (failed > 0) {
    console.error(`\nFAIL: ${failed} example(s) have conformance problems.`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK: all ${examples.length} examples conform.`);

  for (const [name, reason] of CREDENTIAL_GATED) {
    console.log(`  NOT PROVEN AT RUNTIME: ${name} — ${reason}`);
  }
  for (const [name, reason] of TYPECHECK_EXCLUDED) {
    console.log(`  NOT TYPE-CHECKED: ${name} — ${reason}`);
  }

  if (!withBuild) return;

  console.log('\nBuilding examples that declare a build script...');
  const results = examples.map((name) =>
    buildExample(join(EXAMPLES_DIR, name), name),
  );
  const built = results.filter((r) => r.status === 'built');
  const broke = results.filter((r) => r.status === 'failed');
  const skipped = results.filter(
    (r) => r.status === 'no-build-script' || r.status === 'no-package',
  );

  for (const r of built) console.log(`  built: ${r.name}`);
  console.log(`  no build script (nothing to compile): ${skipped.length}`);
  for (const r of broke) {
    console.error(`\n  FAILED: ${r.name}\n${r.output.slice(0, 2000)}`);
  }
  if (broke.length > 0) {
    console.error(`\nFAIL: ${broke.length} example(s) failed to build.`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK: ${built.length} example(s) built.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
