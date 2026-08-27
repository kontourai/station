#!/usr/bin/env node
// station#4464: the screenshot feedback loop's comparator. Two modes:
//
//   node scripts/screenshot-diff.mjs baseline [--gallery=<dir>] [--out=<file>] [--allow-partial] [--force-replace]
//   node scripts/screenshot-diff.mjs diff     [--gallery=<dir>] [--baseline=<file>] [--diff-dir=<dir>] [--screens=a,b]
//
// (also exposed as `npm run screenshot:baseline` / `npm run screenshot:diff`)
//
// Exact comparison, not perceptual. An earlier dHash/Hamming-distance design
// was rejected on measurement: re-run noise on live-data screens reached up
// to 71/256 bits — well past any real regression signal — because two
// always-visible chrome regions (the header connection chip, the sidebar
// build stamp) and unmocked live data made even a pixel-identical rebuild
// "changed". The fix belongs in the CAPTURE (tests/screenshots.spec.ts hides
// both chrome regions and seeds live-data routes; `animations: 'disabled'`
// freezes CSS transitions) so two captures of the same build decode to
// IDENTICAL pixels — at which point exact comparison is strictly simpler and
// strictly more trustworthy than any threshold.
//
// Baseline artifacts (both committed):
//   - `tests/screenshots.baseline.json` — small, diffable manifest: per
//     screen, width/height and the sha256 of its DECODED RGBA pixel buffer
//     (not the PNG bytes — immune to encoder/compression drift). This is
//     the fast path: an unchanged screen never touches its reference image.
//   - `tests/screenshots.baseline/<name>.png` — the reference image itself,
//     read only when a screen's hash disagrees, to localize exactly which
//     pixels moved.
//
// PNG decoding uses `pngjs` (a plain-JS decoder, no native bindings). It was
// already resolvable in this tree as a transitive dependency of
// `packages/cli`'s `qrcode` dependency; it is declared here as an explicit
// root devDependency rather than relied on as an undeclared phantom import.
// No pixelmatch: a per-pixel exact-equality loop plus a red/dimmed overlay
// is sufficient for the localization payoff this design wants.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

export const DEFAULT_GALLERY_DIR = 'gallery';
export const DEFAULT_BASELINE_PATH = 'tests/screenshots.baseline.json';
export const DEFAULT_DIFF_DIR_NAME = 'diffs';
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// --- argument parsing -------------------------------------------------

export function parseScreenshotDiffArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'baseline' && mode !== 'diff') {
    throw new Error(
      `Usage: screenshot-diff.mjs <baseline|diff> [options]\n` +
        `  baseline [--gallery=<dir>] [--out=<file>] [--allow-partial] [--force-replace]\n` +
        `  diff     [--gallery=<dir>] [--baseline=<file>] [--diff-dir=<dir>] [--screens=a,b]`,
    );
  }
  const options = {
    mode,
    gallery: DEFAULT_GALLERY_DIR,
    baseline: DEFAULT_BASELINE_PATH,
    allowPartial: false,
    forceReplace: false,
    screens: null,
    diffDir: null,
  };
  for (const arg of rest) {
    if (arg === '--allow-partial') {
      options.allowPartial = true;
      continue;
    }
    if (arg === '--force-replace') {
      options.forceReplace = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq === -1) {
      throw new Error(`Unrecognized option '${arg}'.`);
    }
    const flag = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    switch (flag) {
      case '--gallery':
        if (!value) throw new Error('--gallery requires a value.');
        options.gallery = value;
        break;
      case '--baseline':
      case '--out':
        if (!value) throw new Error(`${flag} requires a value.`);
        options.baseline = value;
        break;
      case '--diff-dir':
        if (!value) throw new Error('--diff-dir requires a value.');
        options.diffDir = value;
        break;
      case '--screens': {
        const names = value
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
        if (names.length === 0) {
          throw new Error('--screens requires at least one screen name.');
        }
        options.screens = names;
        break;
      }
      default:
        throw new Error(`Unrecognized option '${flag}'.`);
    }
  }
  return options;
}

// --- pixel hashing -------------------------------------------------------

export function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

export function pixelSha256(rgbaData) {
  return createHash('sha256').update(rgbaData).digest('hex');
}

/** width/height + sha256 of the DECODED pixel buffer for a PNG file's bytes. */
export function hashScreenshot(buffer) {
  const png = decodePng(buffer);
  return {
    width: png.width,
    height: png.height,
    sha256: pixelSha256(png.data),
  };
}

function isValidSha256Hex(value) {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

// --- visual diff image ---------------------------------------------------

/** Per-pixel exact-equality diff: red for a changed pixel, a dimmed
 * grayscale of the current pixel otherwise (keeps layout as context without
 * competing with the red highlight). Returns the encoded PNG buffer plus
 * the count of differing pixels. */
export function buildDiffImage(baselineData, currentData, width, height) {
  const diff = new PNG({ width, height });
  let differing = 0;
  const total = width * height;
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    const same =
      baselineData[o] === currentData[o] &&
      baselineData[o + 1] === currentData[o + 1] &&
      baselineData[o + 2] === currentData[o + 2] &&
      baselineData[o + 3] === currentData[o + 3];
    if (same) {
      const luma =
        0.299 * currentData[o] +
        0.587 * currentData[o + 1] +
        0.114 * currentData[o + 2];
      const dimmed = Math.round(luma * 0.35);
      diff.data[o] = dimmed;
      diff.data[o + 1] = dimmed;
      diff.data[o + 2] = dimmed;
      diff.data[o + 3] = 255;
    } else {
      differing += 1;
      diff.data[o] = 255;
      diff.data[o + 1] = 0;
      diff.data[o + 2] = 0;
      diff.data[o + 3] = 255;
    }
  }
  return { buffer: PNG.sync.write(diff), differing, total };
}

// --- baseline manifest + companion image directory ------------------------

/** `tests/screenshots.baseline.json` -> `tests/screenshots.baseline/` — the
 * companion directory of reference PNGs, sibling to the manifest. */
export function baselineImagesDir(baselinePath) {
  const dir = dirname(baselinePath);
  const base = basename(baselinePath).replace(/\.json$/, '');
  return join(dir, base);
}

function readCaptureManifest(galleryDir) {
  const capturePath = join(galleryDir, 'capture.json');
  if (!existsSync(capturePath)) {
    throw new Error(
      `No capture manifest at ${capturePath}. Run the screenshot suite first ` +
        `(npm run test:e2e:screenshot).`,
    );
  }
  const manifest = JSON.parse(readFileSync(capturePath, 'utf8'));
  if (!Array.isArray(manifest?.screens)) {
    throw new Error(`${capturePath} is not a valid capture manifest.`);
  }
  if (manifest.selection !== null && manifest.selection !== undefined) {
    if (
      !Array.isArray(manifest.selection) ||
      !manifest.selection.every((name) => typeof name === 'string')
    ) {
      throw new Error(`${capturePath} has a malformed 'selection' field.`);
    }
  }
  for (const entry of manifest.screens) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      typeof entry.file !== 'string'
    ) {
      throw new Error(`${capturePath} has a malformed screen entry.`);
    }
  }
  return manifest;
}

/** Reads + validates the baseline manifest. A corrupt sha256 (wrong length,
 * uppercase, non-hex) throws immediately rather than ever being compared —
 * a broken value must never silently read as either a match or a
 * non-match by accident of string equality. */
function readBaselineManifest(baselinePath) {
  if (!existsSync(baselinePath)) return { schemaVersion: 2, screens: [] };
  const manifest = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (!Array.isArray(manifest?.screens)) {
    throw new Error(`${baselinePath} is not a valid baseline manifest.`);
  }
  for (const entry of manifest.screens) {
    if (!entry || typeof entry.name !== 'string') {
      throw new Error(`${baselinePath} has a malformed screen entry.`);
    }
    if (entry.volatile === true) continue;
    if (!isValidSha256Hex(entry.sha256)) {
      throw new Error(
        `${baselinePath} entry '${entry.name}' has a corrupt or missing sha256 ` +
          `(must be exactly 64 lowercase hex characters).`,
      );
    }
    if (
      !Number.isInteger(entry.width) ||
      entry.width <= 0 ||
      !Number.isInteger(entry.height) ||
      entry.height <= 0
    ) {
      throw new Error(
        `${baselinePath} entry '${entry.name}' has an invalid width/height.`,
      );
    }
  }
  return manifest;
}

function writeBaselineManifest(baselinePath, entriesByName) {
  const screens = [...entriesByName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  // No Date.now()/random content: identical pixels must produce a
  // byte-identical manifest so the committed file only churns on real change.
  const manifest = { schemaVersion: 2, screens };
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// --- baseline mode --------------------------------------------------------

export function runBaseline(options, { log = console.log } = {}) {
  const galleryDir = resolve(options.gallery);
  const capture = readCaptureManifest(galleryDir);
  const isFullRun =
    capture.selection === null || capture.selection === undefined;
  const failed = capture.screens.filter((screen) => !screen.ok);

  if (!options.allowPartial && (!isFullRun || failed.length > 0)) {
    const reasons = [];
    if (!isFullRun) {
      reasons.push(
        `a targeted run (selection: ${JSON.stringify(capture.selection)})`,
      );
    }
    if (failed.length > 0) {
      reasons.push(
        `${failed.length} failed screen(s): ${failed.map((s) => s.name).join(', ')}`,
      );
    }
    throw new Error(
      `Refusing to write a baseline from ${reasons.join(' and ')}. ` +
        `Pass --allow-partial to update only the captured screens' entries.`,
    );
  }

  // A capture is only ever REPLACE-eligible when it is genuinely complete
  // (full coverage, nothing failed) — not merely because --allow-partial was
  // passed. A redundant --allow-partial on an actually-full, all-ok run
  // still replaces; a genuinely partial/failed run always merges (that is
  // the only thing --allow-partial exists to permit).
  const shouldReplace = isFullRun && failed.length === 0;

  const existing = readBaselineManifest(options.baseline);
  const existingByName = new Map(existing.screens.map((s) => [s.name, s]));
  const imagesDir = baselineImagesDir(options.baseline);
  mkdirSync(imagesDir, { recursive: true });

  const nextByName = shouldReplace ? new Map() : new Map(existingByName);
  let updated = 0;
  let preservedVolatile = 0;

  for (const screen of capture.screens) {
    if (!screen.ok) continue; // never clobber with a broken/absent tile
    const existingEntry = existingByName.get(screen.name);
    if (existingEntry?.volatile === true) {
      // Hand-curated exception: carry it forward untouched. Never store an
      // image for it either — diff mode must never read one.
      nextByName.set(screen.name, existingEntry);
      preservedVolatile += 1;
      continue;
    }
    const buffer = readFileSync(join(galleryDir, screen.file));
    const { width, height, sha256 } = hashScreenshot(buffer);
    nextByName.set(screen.name, { name: screen.name, width, height, sha256 });
    writeFileSync(join(imagesDir, `${screen.name}.png`), buffer);
    updated += 1;
  }

  if (shouldReplace) {
    // A REPLACE that would drop more than half of an existing, non-empty
    // baseline is far more likely to be an accident — an empty/mis-scoped
    // capture (station#4464 review: an empty SCREENS list makes every
    // screen "new", exit 0, and REPLACE-eligible), or a baseline-conflict
    // resolution that collapsed the manifest array — than an intentional
    // mass retirement of screens. Refuse before any destructive action
    // (stale-image deletion below, or the manifest write) unless the
    // caller explicitly opts in.
    const existingCount = existingByName.size;
    const nextCount = nextByName.size;
    if (
      existingCount > 0 &&
      nextCount < existingCount / 2 &&
      !options.forceReplace
    ) {
      throw new Error(
        `Refusing to REPLACE ${options.baseline}: this capture would drop ` +
          `${existingCount - nextCount} of ${existingCount} existing baseline ` +
          `entries (down to ${nextCount}) — more than half. If this is ` +
          `intentional (a real mass screen retirement), pass --force-replace. ` +
          `Otherwise this usually means the capture is empty or mis-scoped.`,
      );
    }

    // REPLACE also drops stale reference images for screens no longer in
    // the manifest (renamed/retired screens), so the companion directory
    // never accumulates orphans a full-run baseline no longer claims.
    const keep = new Set(
      [...nextByName.values()]
        .filter((entry) => entry.volatile !== true)
        .map((entry) => `${entry.name}.png`),
    );
    for (const file of existsSync(imagesDir) ? readdirSync(imagesDir) : []) {
      if (!keep.has(file)) rmSync(join(imagesDir, file), { force: true });
    }
  }

  const manifest = writeBaselineManifest(options.baseline, nextByName);
  log(
    `[screenshot-diff] wrote ${options.baseline} (${shouldReplace ? 'replaced' : 'merged'}): ` +
      `${updated} hashed, ${preservedVolatile} preserved volatile, ${manifest.screens.length} total entries.`,
  );
  return {
    updated,
    preservedVolatile,
    total: manifest.screens.length,
    replaced: shouldReplace,
  };
}

// --- diff mode --------------------------------------------------------

export function runDiff(options, { log = console.log } = {}) {
  const galleryDir = resolve(options.gallery);
  const capture = readCaptureManifest(galleryDir);
  if (!existsSync(options.baseline)) {
    throw new Error(
      `No baseline manifest at ${options.baseline}. Run 'npm run screenshot:baseline' first.`,
    );
  }
  const baseline = readBaselineManifest(options.baseline);
  const baselineByName = new Map(baseline.screens.map((s) => [s.name, s]));
  const captureByName = new Map(capture.screens.map((s) => [s.name, s]));
  const imagesDir = baselineImagesDir(options.baseline);
  const diffDir = resolve(
    options.diffDir ?? join(galleryDir, DEFAULT_DIFF_DIR_NAME),
  );

  // An UNSCOPED diff over a PARTIAL gallery would otherwise silently compare
  // only the captured subset while still printing "OK" as though the whole
  // gallery had been checked. Refuse instead of let that slide.
  if (
    !options.screens &&
    capture.selection !== null &&
    capture.selection !== undefined
  ) {
    throw new Error(
      `Refusing an unscoped diff over a partial gallery (selection: ${JSON.stringify(capture.selection)}). ` +
        `Pass --screens=${capture.selection.join(',')} to explicitly diff just this subset.`,
    );
  }

  let scopeNames;
  if (options.screens) {
    // station#4464 arbiter fix: validity is membership in THIS RUN'S
    // CAPTURE, never a union with the baseline — a name the current
    // capture.json doesn't even mention can never be diffed, no matter
    // what the baseline says about it. (The prior union-based check let
    // every valid-but-uncaptured name "pass" as an exit-0 informational row.)
    const unknown = options.screens.filter((name) => !captureByName.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `--screens requested unknown screen(s): ${unknown.join(', ')} ` +
          `(not present in ${join(galleryDir, 'capture.json')}).`,
      );
    }
    scopeNames = [...new Set(options.screens)];
  } else {
    // Unscoped: the union of what the baseline expects and what this run
    // captured, so a screen that vanished from the gallery entirely (not
    // even an !ok row) is still named as missing rather than silently
    // dropped from the report.
    scopeNames = [
      ...new Set([...baselineByName.keys(), ...captureByName.keys()]),
    ];
  }
  scopeNames.sort((a, b) => a.localeCompare(b));

  const rows = [];
  let comparisons = 0;
  let unchangedCount = 0;
  let changedCount = 0;
  let newCount = 0;
  let volatileCount = 0;
  let capturedFailedCount = 0;
  let missingCount = 0;

  for (const name of scopeNames) {
    const baselineEntry = baselineByName.get(name);
    const captureEntry = captureByName.get(name);

    if (!captureEntry) {
      // Only reachable in unscoped mode (scoped mode already rejected any
      // name absent from the capture up front).
      rows.push({
        name,
        status: 'missing-from-gallery',
        detail: 'not captured in this run',
      });
      missingCount += 1;
      continue;
    }

    if (!captureEntry.ok) {
      // A failed capture is a FAILURE of this run, never merely
      // informational — it means the screen never got compared at all.
      rows.push({
        name,
        status: 'capture-failed',
        detail: captureEntry.error ?? 'capture failed',
      });
      capturedFailedCount += 1;
      continue;
    }

    if (baselineEntry?.volatile === true) {
      // Hand-curated, last-resort exception: named loudly, never silently
      // folded into "unchanged".
      rows.push({
        name,
        status: 'skipped-volatile',
        detail:
          baselineEntry.reason ??
          'marked volatile in the baseline; never compared',
      });
      volatileCount += 1;
      continue;
    }

    if (!baselineEntry) {
      rows.push({ name, status: 'new', detail: 'no baseline entry' });
      newCount += 1;
      continue;
    }

    const buffer = readFileSync(join(galleryDir, captureEntry.file));
    const decoded = decodePng(buffer);
    const sha256 = pixelSha256(decoded.data);
    comparisons += 1;

    if (
      decoded.width !== baselineEntry.width ||
      decoded.height !== baselineEntry.height
    ) {
      rows.push({
        name,
        status: 'changed',
        detail: `dimensions ${baselineEntry.width}x${baselineEntry.height} -> ${decoded.width}x${decoded.height}`,
      });
      changedCount += 1;
      continue;
    }

    if (sha256 === baselineEntry.sha256) {
      rows.push({
        name,
        status: 'unchanged',
        detail: `sha256 ${sha256.slice(0, 12)}…`,
      });
      unchangedCount += 1;
      continue;
    }

    changedCount += 1;
    const referencePath = join(imagesDir, `${name}.png`);
    if (!existsSync(referencePath)) {
      rows.push({
        name,
        status: 'changed',
        detail: `sha256 mismatch; no reference image at ${referencePath} for a pixel diff`,
      });
      continue;
    }
    const baselineDecoded = decodePng(readFileSync(referencePath));
    const {
      buffer: diffBuffer,
      differing,
      total,
    } = buildDiffImage(
      baselineDecoded.data,
      decoded.data,
      decoded.width,
      decoded.height,
    );
    mkdirSync(diffDir, { recursive: true });
    const diffPath = join(diffDir, `${name}.diff.png`);
    writeFileSync(diffPath, diffBuffer);
    const pct = ((differing / total) * 100).toFixed(1);
    rows.push({
      name,
      status: 'changed',
      detail: `changed (${differing} pixel(s), ${pct}%) — diff: ${diffPath}`,
    });
  }

  renderTable(rows, log);

  const failing = capturedFailedCount + missingCount + changedCount;
  log(
    `[screenshot-diff] ${comparisons} compared (unchanged=${unchangedCount}, changed=${changedCount}), ` +
      `${newCount} new, ${volatileCount} skipped (volatile), ` +
      `${capturedFailedCount} capture-failed, ${missingCount} missing-from-gallery.`,
  );

  if (failing > 0) {
    // Named `failing`, not `changed`: it deliberately covers every
    // exit-driving status (changed / capture-failed / missing-from-gallery),
    // not only visual regressions — a caller checking "did anything actually
    // change" should filter this by `status === 'changed'` itself.
    const problems = rows.filter((row) =>
      ['changed', 'capture-failed', 'missing-from-gallery'].includes(
        row.status,
      ),
    );
    log(
      `[screenshot-diff] FAILED (${problems.length}): ${problems.map((r) => r.name).join(', ')}`,
    );
    return { exitCode: 1, rows, comparisons, failing: problems };
  }

  // Never say OK on a VACUOUS scope — a comparison must have actually run.
  // Reaching here with `failing === 0` and `comparisons === 0` means every
  // scoped row was 'new' and/or 'skipped-volatile': nothing was ever
  // decoded or hashed against anything. That is exactly the shape an empty
  // or emptied baseline produces (station#4464 review: an empty
  // `tests/screenshots.baseline.json` — e.g. from a mishandled merge
  // conflict, or a REPLACE run over an empty capture — makes every screen
  // read as "new", which used to exit 0 and print "OK"). An all-volatile
  // scope is the same shape and gets the same refusal; a genuinely empty
  // scope (`rows.length === 0`, nothing to check at all) is not — there is
  // nothing to have silently skipped.
  if (comparisons === 0 && rows.length > 0) {
    log(
      `[screenshot-diff] REFUSED: 0 actual comparisons across ${rows.length} ` +
        `scoped screen(s) (${newCount} new, ${volatileCount} volatile) — ` +
        `nothing was actually verified, so this can never report OK. Check ` +
        `that ${options.baseline} is not empty/corrupt and that --screens ` +
        `(if used) names screens the baseline actually has entries for.`,
    );
    return { exitCode: 1, rows, comparisons, failing: [] };
  }

  log(
    `[screenshot-diff] OK: ${comparisons}/${comparisons} compared screen(s) unchanged` +
      `${newCount || volatileCount ? ` (plus ${newCount} new, ${volatileCount} volatile, informational)` : ''}.`,
  );
  return { exitCode: 0, rows, comparisons, failing: [] };
}

function renderTable(rows, log) {
  if (rows.length === 0) {
    log('[screenshot-diff] no screens in scope.');
    return;
  }
  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const statusWidth = Math.max(6, ...rows.map((r) => r.status.length));
  const pad = (value, width) => value.padEnd(width, ' ');
  log(`${pad('screen', nameWidth)}  ${pad('status', statusWidth)}  detail`);
  for (const row of rows) {
    log(
      `${pad(row.name, nameWidth)}  ${pad(row.status, statusWidth)}  ${row.detail}`,
    );
  }
}

// --- entry point -------------------------------------------------------

async function main(argv) {
  const options = parseScreenshotDiffArgs(argv);
  if (options.mode === 'baseline') {
    runBaseline(options);
    return 0;
  }
  return runDiff(options).exitCode;
}

// station#4464 arbiter fix: match the repo's own idiom (scripts/run-e2e-suite.mjs)
// instead of a bare pathname compare, which silently no-ops on a path
// containing spaces.
const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(
        `[screenshot-diff] ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    },
  );
}
