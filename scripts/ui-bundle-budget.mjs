/**
 * Entry-bundle ceiling gate for `npm run build:ui`.
 *
 * ## Why this number exists
 *
 * The entry bundle is what a browser downloads, parses and executes before a
 * user sees anything. It is paid on every cold load, by every user, on whatever
 * connection and device they have — so it is the one measurement in this repo
 * that converts directly into someone else's waiting.
 *
 * The ceiling is a forcing function, not an accounting exercise. It exists to
 * make the cost of an addition visible at the moment it is added, while reuse
 * is still cheap to choose: import the primitive that already ships instead of
 * writing a second one, lazy-load a surface the first paint does not need,
 * delete the dead thing next to the live one. Almost every red this gate has
 * produced was answerable that way, and the answer left the codebase smaller
 * rather than the number larger.
 *
 * So raising it is a legitimate outcome and a LAST one. Reach for it after you
 * have asked what a user gets for the bytes, not before — and if you do raise,
 * raise by what you measured and say so, because the next reader can only tell
 * a considered raise from a reflexive one by what you wrote down. A ceiling
 * raised reflexively teaches every later lane that the number is paperwork.
 *
 * ## How the measurement works
 *
 * This measurement is exact only because the UI build is reproducible: a given
 * source tree produces byte-identical entry assets, and build identity lives
 * in index.html outside the JavaScript content-hash graph. A commit-only change
 * therefore cannot read as bundle growth. Anything that leaks wall-clock time,
 * randomness, or ambient state into a chunk breaks that contract (see #1080).
 * If this gate goes red, first check that repeated builds of the same tree still
 * agree; raise a ceiling only once they do.
 *
 * Scope of "initial payload" (station#1218): every asset the built
 * `index.html` references *eagerly* — `<script src>`, `<link rel=stylesheet>`,
 * and `<link rel=modulepreload>` — because a browser fetches all three on
 * first paint regardless of how many the bundler emits. This deliberately
 * does NOT follow the module graph transitively: a chunk that is only
 * discoverable via a lazy `import()` (no matching modulepreload in the built
 * HTML) is not part of the initial payload by any browser-observable
 * definition, so it is out of scope here even though it exists on disk.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { assertWorkspacePackageProvenance } from './workspace-dependency-provenance.mjs';

export function evaluateBundleBudget(measured, budget) {
  const failures = [];
  if (measured.entryJsGzipBytes > budget.entryJsGzipBytes) {
    failures.push(
      `entry JS gzip ${measured.entryJsGzipBytes} exceeds ${budget.entryJsGzipBytes} bytes`,
    );
  }
  if (measured.entryCssGzipBytes > budget.entryCssGzipBytes) {
    failures.push(
      `entry CSS gzip ${measured.entryCssGzipBytes} exceeds ${budget.entryCssGzipBytes} bytes`,
    );
  }
  return { ok: failures.length === 0, failures };
}

export function assertBundleDependencyProvenance(
  repoRoot = fileURLToPath(new URL('..', import.meta.url)),
) {
  const nodeModulesPath = join(repoRoot, 'node_modules');
  let nodeModulesStat;
  try {
    nodeModulesStat = lstatSync(nodeModulesPath);
  } catch (error) {
    throw new Error(
      `Cannot measure the UI bundle without this worktree's own node_modules (${nodeModulesPath}). Run npm ci in this worktree.`,
      { cause: error },
    );
  }
  if (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) {
    throw new Error(
      `Refusing to measure the UI bundle: node_modules must be a real directory owned by this worktree, not a symlink (${nodeModulesPath}).`,
    );
  }

  let provenance;
  try {
    provenance = assertWorkspacePackageProvenance({ repositoryRoot: repoRoot });
  } catch (error) {
    throw new Error(
      `Refusing to measure the UI bundle because workspace dependency provenance is invalid. Run npm ci in this worktree. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const contracts = provenance.packages.find(
    ({ name }) => name === '@kontourai/station-contracts',
  );
  if (!contracts)
    throw new Error(
      'Refusing to measure the UI bundle: workspace dependency provenance did not include @kontourai/station-contracts.',
    );
  return { contractsPath: contracts.resolvedRoot };
}

/** Every `<tagName ...>` open tag in `html`, in document order. */
function findTags(html, tagName) {
  return html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'g')) ?? [];
}

/**
 * Reads a root-relative asset path (e.g. `/assets/index-abc123.js`) out of a
 * single already-matched tag's `attr="..."` attribute, stripping any query
 * string. Throws rather than returning `undefined` for any shape this gate
 * cannot interpret (missing attribute, non-root-relative path, an external
 * URL) — per station#1218 AC2, an asset graph the gate can't parse must fail
 * the gate, never silently drop out of the sum.
 */
function requireAssetPath(tag, attr) {
  const raw = tag.match(new RegExp(`${attr}="([^"]*)"`))?.[1];
  if (!raw) {
    throw new Error(
      `Built index.html has a <${tag.replace(/^<(\S+).*$/s, '$1')}> tag missing its ${attr} attribute (${tag}). Cannot measure the initial payload.`,
    );
  }
  const match = raw.match(/^\/([^?]+)/);
  if (!match) {
    throw new Error(
      `Built index.html references "${raw}" via ${attr}, which is not a root-relative path this gate knows how to measure (${tag}).`,
    );
  }
  return match[1];
}

function sumGzipBytes(outputDir, files) {
  return files.reduce(
    (sum, file) =>
      sum + gzipSync(readFileSync(join(outputDir, file))).byteLength,
    0,
  );
}

export function measureEntryBundle(outputDir) {
  const html = readFileSync(join(outputDir, 'index.html'), 'utf8');

  const scriptTags = findTags(html, 'script').filter((tag) =>
    /\bsrc="/.test(tag),
  );
  const linkTags = findTags(html, 'link');
  const stylesheetTags = linkTags.filter((tag) =>
    /\brel="stylesheet"/.test(tag),
  );
  const modulepreloadTags = linkTags.filter((tag) =>
    /\brel="modulepreload"/.test(tag),
  );

  if (scriptTags.length === 0 || stylesheetTags.length === 0) {
    throw new Error(
      'Built index.html must reference at least one entry script and one stylesheet.',
    );
  }

  const scripts = scriptTags.map((tag) => requireAssetPath(tag, 'src'));
  const stylesheets = stylesheetTags.map((tag) =>
    requireAssetPath(tag, 'href'),
  );
  const modulepreloads = modulepreloadTags.map((tag) =>
    requireAssetPath(tag, 'href'),
  );

  // Dedupe: the same chunk can appear as both a <script src> and a
  // modulepreload link. Count its bytes once, not once per reference.
  const entryJsFiles = Array.from(new Set([...scripts, ...modulepreloads]));
  const entryCssFiles = Array.from(new Set(stylesheets));

  // Gzip each file individually and sum, matching what a browser actually
  // receives (independent gzip streams, one per HTTP response) rather than
  // concatenating sources and gzipping once, which would report an
  // unrealistically good number by letting the compressor share a
  // dictionary across files no browser ever receives as a single stream.
  const entryJsGzipBytes = sumGzipBytes(outputDir, entryJsFiles);
  const entryCssGzipBytes = sumGzipBytes(outputDir, entryCssFiles);

  return {
    entryJsFiles,
    entryJsGzipBytes,
    entryCssFiles,
    entryCssGzipBytes,
    assetCount: entryJsFiles.length + entryCssFiles.length,
  };
}

const STARTUP_READINESS_ENTRY_MARKERS = Object.freeze([
  'station:startup-readiness-trigger:v1',
  'bundled_server_status',
  'commit_startup_readiness',
  'commit_startup_recovery_ui',
  'station://startup-readiness-retry',
]);

/**
 * The packaged desktop keeps its WebView alive behind a native cover until
 * this renderer trigger asks the host to prove the exact sidecar identity.
 * Every command and retry marker must therefore be present in the initial
 * JavaScript payload; a lazy asset cannot be a prerequisite for reveal.
 */
export function assertStartupReadinessInInitialPayload(
  outputDir,
  measured = measureEntryBundle(outputDir),
) {
  const initialJavaScript = measured.entryJsFiles
    .map((file) => readFileSync(join(outputDir, file), 'utf8'))
    .join('\n');
  const missing = STARTUP_READINESS_ENTRY_MARKERS.filter(
    (marker) => !initialJavaScript.includes(marker),
  );
  if (missing.length > 0) {
    throw new Error(
      `Desktop startup readiness must be executable from the initial UI payload; missing ${missing.join(', ')}.`,
    );
  }
}

export function shouldEnforceUiBundleBudget(env = process.env) {
  return env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !== '1';
}

/**
 * Ceilings are set-to-actual in the canonical verification environment. A
 * foreign build environment (the container image build: git-less, /app
 * paths) legitimately drifts a few gzip bytes, and a zero-slack ceiling
 * cannot arbitrate two measuring environments — observe mode measures and
 * reports there without failing, leaving enforcement to the canonical lane.
 */
export function uiBundleBudgetObserveOnly(env = process.env) {
  return env.STATION_UI_BUNDLE_BUDGET === 'observe';
}

if (process.argv[1]?.endsWith('ui-bundle-budget.mjs')) {
  if (!shouldEnforceUiBundleBudget()) {
    console.log(
      'Reference diagnostic UI build: ordinary first-paint bundle budget is not applicable.',
    );
  } else {
    const provenance = assertBundleDependencyProvenance();
    const outputDir = process.env.STATION_BUILD_UI_DIR || 'dist-ui';
    const budget = JSON.parse(
      readFileSync(new URL('./ui-bundle-budget.json', import.meta.url), 'utf8'),
    );
    const measured = measureEntryBundle(outputDir);
    assertStartupReadinessInInitialPayload(outputDir, measured);
    const result = evaluateBundleBudget(measured, budget);
    console.log(
      `Initial UI bundle (${measured.assetCount} assets summed: ${measured.entryJsFiles.length} JS, ${measured.entryCssFiles.length} CSS): ` +
        `JS ${measured.entryJsGzipBytes}/${budget.entryJsGzipBytes} gzip bytes; CSS ${measured.entryCssGzipBytes}/${budget.entryCssGzipBytes}.`,
    );
    console.log(`Bundle dependency provenance: ${provenance.contractsPath}`);
    if (!result.ok && uiBundleBudgetObserveOnly()) {
      console.log(
        `OBSERVE: over-ceiling in a foreign build environment (${result.failures.join('; ')}); ` +
          'ceilings are enforced only in the canonical verification environment.',
      );
    } else if (!result.ok) {
      console.error(result.failures.join('\n'));
      // The ceilings track ACTUAL size, so a legitimate feature WILL trip this.
      // Say what to do here, because the alternative is that whoever trips it
      // learns the rule from a colleague who happens to be watching — and the
      // failure reaches them wherever they are, which no message can.
      console.error(
        [
          '',
          'This is the payload a browser downloads, parses and runs before a user sees',
          'anything — paid on every cold load, by every user, on whatever connection they',
          'have. The ceiling exists to make that cost visible while reuse is still cheap',
          'to choose, not to be reconciled. Ask what a user gets for these bytes before',
          'you ask whether you may raise the number.',
          '',
          'These ceilings are set to actual, not to a target — growing them is legitimate',
          'when a change genuinely adds weight, and it is the LAST of the three steps',
          'below, not the first. The rule is that the bytes get owned:',
          '',
          '  1. Confirm the growth is yours: build this tree and the merge-base in the SAME',
          '     worktree with its OWN node_modules. Never symlink node_modules from another',
          "     worktree — @kontourai/* resolve through it into that tree's packages/ and you",
          '     will measure a plausible, wrong number (station#2776).',
          '  2. Look for waste first, and for something to reuse. The usual cause is eager',
          '     weight, not feature code: a root barrel is a chunk-placement magnet, so',
          '     anything a lazy view imports THROUGH the barrel is hoisted into the entry',
          '     chunk. Deep-import at the EAGER importers — doing it at a lazy consumer',
          '     while the barrel still re-exports measures 0 bytes. Then ask the DRY',
          '     questions, because they are the ones that shrink the tree rather than',
          '     relocating it: does a primitive for this already ship (see the state',
          '     primitives and shell skeletons in AGENTS.md)? Does the first paint need',
          '     this surface at all, or can it lazy-load? Is there a dead sibling next to',
          '     the live one you can delete in the same change?',
          '  3. If the residual is genuinely the feature, raise the ceiling by YOUR measured',
          '     cost, in YOUR pull request, with the number in the commit message.',
          '',
          'Do not raise it to absorb bytes you have not attributed: an unowned raise gets',
          'consumed within hours and the next lane inherits the red as if it were theirs.',
        ].join('\n'),
      );
      process.exitCode = 1;
    }
  }
}
