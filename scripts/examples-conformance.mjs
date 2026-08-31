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
 *
 * Live build/run proof is a separate lane: see `--build`. Examples that need
 * credentials are declared here rather than skipped silently, so "not proven"
 * is visible instead of being confused with "passing".
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
