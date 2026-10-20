#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { baselineImagesDir, runDiff } from './screenshot-diff.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const digest = (value) => hash(JSON.stringify(canonical(value)));

/** Review identity only: callers still retain this run's comparator verdict. */
export function buildGalleryReviewEvidence({
  gallery,
  baseline,
  context,
  previous,
}) {
  if (
    !context.sourceSha ||
    !context.runUrl ||
    !context.renderer ||
    !context.captureContract
  )
    throw new Error(
      'sourceSha, runUrl, verified renderer and captureContract are required',
    );
  if (
    !/^[a-f0-9]{40}$/.test(context.sourceSha) ||
    !/^[a-f0-9]{64}$/.test(context.captureContract)
  )
    throw new Error(
      'sourceSha and captureContract must be full SHA fingerprints',
    );
  const observed = new Map();
  const readObserved = (file) => {
    const bytes = readFileSync(file);
    observed.set(file, hash(bytes));
    return bytes;
  };
  const root = realpathSync(gallery);
  const capture = JSON.parse(
    readObserved(join(root, 'capture.json')).toString('utf8'),
  );
  const reference = JSON.parse(readObserved(baseline).toString('utf8'));
  for (const screen of [...capture.screens, ...reference.screens]) {
    if (
      typeof screen.name !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(screen.name)
    )
      throw new Error('invalid screen name');
  }
  const screens = capture.screens
    .map((screen) => {
      if (!screen.ok) return { ...screen };
      const file = realpathSync(resolve(root, screen.file));
      if (!file.startsWith(`${root}${sep}`))
        throw new Error('capture image escapes gallery');
      const bytes = readObserved(file);
      const png = PNG.sync.read(bytes);
      const { sha256: claimedHash, ...metadata } = screen;
      const pngSha256 = hash(bytes);
      if (claimedHash && claimedHash !== pngSha256)
        throw new Error(`capture PNG digest mismatch: ${screen.name}`);
      if (screen.rasterDiagnostic?.file) {
        const auxiliary = realpathSync(
          resolve(root, screen.rasterDiagnostic.file),
        );
        if (!auxiliary.startsWith(`${root}${sep}`))
          throw new Error('auxiliary image escapes gallery');
        if (hash(readObserved(auxiliary)) !== screen.rasterDiagnostic.sha256)
          throw new Error(`auxiliary PNG digest mismatch: ${screen.name}`);
      }
      return {
        ...metadata,
        pngSha256,
        rgbaSha256: hash(png.data),
        width: png.width,
        height: png.height,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const referenceImages = reference.screens
    .map((screen) => {
      const file = join(
        baselineImagesDir(baseline),
        `${screen.name}${screen.volatile ? '.reference' : ''}.png`,
      );
      return {
        name: screen.name,
        sha256: existsSync(file) ? hash(readObserved(file)) : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const result = runDiff({ gallery: root, baseline }, { log: () => {} });
  for (const [file, sha256] of observed) {
    if (hash(readFileSync(file)) !== sha256)
      throw new Error('Gallery evidence changed during comparison');
  }
  const signature = {
    referenceImages,
    renderer: context.renderer,
    captureContract: context.captureContract,
    baseline: reference,
    selection: capture.selection ?? null,
    screens,
    statuses: result.rows.map(({ name, status }) => ({ name, status })),
  };
  const reviewKey = digest(signature);
  const priorReview = previous?.review;
  const complete =
    result.comparisons > 0 &&
    !result.rows.some((row) =>
      ['capture-failed', 'missing-from-gallery'].includes(row.status),
    );
  const linkedReview =
    complete &&
    previous?.reviewKey === reviewKey &&
    priorReview?.owner &&
    priorReview?.disposition &&
    priorReview?.evidenceUrl
      ? priorReview
      : null;
  return {
    schemaVersion: 1,
    sourceSha: context.sourceSha,
    runUrl: context.runUrl,
    reviewKey,
    signature,
    comparator: { exitCode: result.exitCode, rows: signature.statuses },
    linkedReview,
    instruction: linkedReview
      ? 'Same visual evidence; retain this exact-run verdict and link the prior owner disposition. No source, merge-candidate or promotion qualification transfers.'
      : 'Review this evidence and record owner, disposition and evidenceUrl. Separate product defects, rendering nondeterminism and missing baseline coverage.',
  };
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = Object.fromEntries(
      process.argv.slice(2).map((arg) => {
        const at = arg.indexOf('=');
        if (!arg.startsWith('--') || at < 0)
          throw new Error(
            'Use --gallery= --baseline= --context= --out= [--previous=]',
          );
        return [arg.slice(2, at), arg.slice(at + 1)];
      }),
    );
    const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
    const report = buildGalleryReviewEvidence({
      gallery: args.gallery,
      baseline: args.baseline ?? 'tests/screenshots.baseline.json',
      context: readJson(args.context),
      previous: args.previous ? readJson(args.previous) : undefined,
    });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(report.instruction);
    process.exitCode = report.comparator.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
