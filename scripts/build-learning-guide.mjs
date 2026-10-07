import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  assertMarkdownLinks,
  findBrokenRenderedMarkdownLinks,
} from './check-markdown-links.mjs';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import {
  assertDocumentationFresh,
  formatFreshnessAdvisory,
  freshnessRequirement,
  resolveDocumentationFreshness,
} from './lib/documentation-freshness.mjs';
import { extractModules, validateCatalog } from './lib/documentation-model.mjs';
import { compileDocumentationReviews } from './lib/documentation-review.mjs';
import { publishImmutableSnapshot } from './lib/immutable-snapshot.mjs';
import { renderLearningDocument } from './lib/learning-markdown.mjs';
import {
  compileLearningMedia,
  LEARNING_MEDIA_MANIFEST,
} from './lib/learning-media.mjs';
import { createLearningSourceReader } from './lib/learning-source-reader.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { bindingFile } from './lib/review-binding.mjs';
import { readReviewState } from './lib/review-ledger-store.mjs';

export {
  learningHref,
  renderLearningDocument,
} from './lib/learning-markdown.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleMap = 'docs/architecture/module-map.md';

function git(args, cwd = root) {
  return execFileSyncBounded('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trimEnd();
}

export async function buildDiagramBundle() {
  const reader = createLearningSourceReader(root);
  const result = await build({
    stdin: {
      contents: reader.read('docs/learn/diagrams.js').toString('utf8'),
      resolveDir: path.join(root, 'docs/learn'),
      sourcefile: 'docs/learn/diagrams.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    minify: true,
  });
  return result.outputFiles[0].text;
}

export function learningClientData(data) {
  return {
    ...data,
    documents: data.documents.map(
      ({ html: _html, search: _search, ...doc }) => ({
        ...doc,
        contentUrl: `documents/${doc.path.split('/').map(encodeURIComponent).join('/')}.json`,
      }),
    ),
    modules: data.modules.map(({ html: _html, ...module }) => ({
      ...module,
      contentUrl: `modules/${module.id}.json`,
    })),
  };
}

/**
 * @param {{ check?: boolean, root?: string, freshness?: ReturnType<typeof resolveDocumentationFreshness> }} [options]
 * `check` refuses stale reviews and captures under the shared freshness
 * policy (scoped to the change by default); a normal build marks them
 * `needs-review` instead.
 */
export async function buildLearningGuide({
  check = false,
  root: inputRoot = root,
  freshness,
} = {}) {
  const reader = createLearningSourceReader(inputRoot);
  const tracked = git(['ls-files', '-z'], inputRoot)
    .split('\0')
    .filter(Boolean)
    .sort();
  const files = new Set(
    tracked.filter((file) => /\.(md|mdx|markdown)$/i.test(file)),
  );
  if (!files.size)
    throw new Error('Learning inventory contains no tracked Markdown.');
  const revision = git(['rev-parse', 'HEAD'], inputRoot);
  const sourceFiles = new Set(tracked);
  // Review hashes, rendering, and published evidence must use the same read.
  const capturedSources = new Map();
  async function captureSource(file) {
    if (!sourceFiles.has(file))
      throw new Error(`Untracked source snapshot: ${file}`);
    if (!capturedSources.has(file))
      capturedSources.set(file, reader.read(file));
    return capturedSources.get(file);
  }
  const policy = check
    ? (freshness ?? resolveDocumentationFreshness({ root: inputRoot }))
    : undefined;
  if (policy?.sourceDrops?.length)
    assertDocumentationFresh({ policy, blocking: policy.sourceDrops });
  // One read of the ledger directory and capture manifest (#2936).
  const reviewState = readReviewState(inputRoot);
  if (reviewState.ledger.historyUnavailable) {
    if (policy?.mode === 'strict')
      throw new Error(
        `Strict documentation freshness cannot judge freshness. ${reviewState.ledger.historyUnavailable}`,
      );
    console.warn(reviewState.ledger.historyUnavailable);
  }
  const media = reviewState.media
    ? await compileLearningMedia(
        reviewState.media,
        sourceFiles,
        captureSource,
        {
          requireFresh: policy && freshnessRequirement(policy, 'capture'),
          reportMissing: Boolean(policy),
        },
      )
    : new Map();
  const catalog = JSON.parse(
    (await captureSource('docs/learn/atlas.json')).toString('utf8'),
  );
  const modules = extractModules(
    (await captureSource(moduleMap)).toString('utf8'),
  );
  validateCatalog(catalog, modules, files);
  const documents = [];
  const renderedDocuments = new Map();
  for (const file of files) {
    const bytes = await captureSource(file);
    const source = bytes.toString('utf8');
    const rendered = renderLearningDocument(
      source,
      file,
      files,
      revision,
      sourceFiles,
      media,
    );
    renderedDocuments.set(file, rendered);
    documents.push({
      path: file,
      title: rendered.headings[0]?.title ?? file,
      digest: createHash('sha256').update(bytes).digest('hex'),
      review: 'Semantic review not established by this build',
      search: source.toLowerCase(),
      html: rendered.html,
      headings: rendered.headings,
    });
  }
  const trackedTargets = new Set(sourceFiles);
  trackedTargets.add('.');
  for (const file of sourceFiles) {
    let directory = path.posix.dirname(file);
    while (directory !== '.') {
      trackedTargets.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  assertMarkdownLinks(
    await findBrokenRenderedMarkdownLinks({
      documents: renderedDocuments,
      targetExists: (file) =>
        trackedTargets.has(file.replace(/\/+$/, '') || '.') &&
        reader.exists(file),
    }),
  );
  for (const group of catalog.groups) {
    for (const reference of group.docs) {
      const [file, anchor] = reference.split('#');
      if (
        anchor &&
        !renderedDocuments
          .get(file)
          ?.anchors.includes(decodeURIComponent(anchor))
      )
        throw new Error(`Missing learning section: ${reference}`);
    }
  }
  const reviews = await compileDocumentationReviews(
    reviewState.ledger,
    new Map(documents.map((doc) => [doc.path, doc.digest])),
    sourceFiles,
    captureSource,
    {
      requireFresh: policy && freshnessRequirement(policy, 'review'),
      reportMissing: Boolean(policy),
    },
  );
  if (policy) {
    const advisory = formatFreshnessAdvisory(
      policy,
      [
        ...[...media.values()].map((capture) => ({
          ...capture,
          kind: 'capture',
        })),
        ...[...reviews.values()].map((review) => ({
          ...review,
          kind: 'review',
        })),
      ].filter((entry) => entry.changed.length),
    );
    if (advisory) console.warn(advisory);
  }
  const renderedModules = modules.map(({ text, ...module }) => {
    const { html, headings } = renderLearningDocument(
      text,
      moduleMap,
      files,
      revision,
      sourceFiles,
      media,
    );
    return {
      ...module,
      digest: createHash('sha256').update(text).digest('hex'),
      html,
      headings,
    };
  });
  const sourcePaths = [
    ...new Set([
      ...files,
      ...(sourceFiles.has(LEARNING_MEDIA_MANIFEST)
        ? [LEARNING_MEDIA_MANIFEST]
        : []),
      // A check reports untracked recorded sources as stale; they have no
      // bytes to snapshot.
      ...[...media.values()].flatMap((capture) =>
        capture.sources
          .map((source) => bindingFile(source.path))
          .filter((file) => sourceFiles.has(file)),
      ),
      ...[...reviews.values()].flatMap((review) =>
        review.sources
          .map((source) => bindingFile(source.path))
          .filter((file) => sourceFiles.has(file)),
      ),
      ...[...documents, ...renderedModules].flatMap((doc) =>
        [...doc.html.matchAll(/href="sources\/([^"#]+)\.txt"/g)].map((match) =>
          decodeURIComponent(match[1]),
        ),
      ),
    ]),
  ].sort();
  /** @type {Record<string, string>} */
  const sourceSnapshots = {};
  for (const file of sourcePaths) {
    const digest = createHash('sha256')
      .update(await captureSource(file))
      .digest('hex');
    sourceSnapshots[file] =
      media.get(file)?.url ??
      `sources/${digest}/${file.split('/').map(encodeURIComponent).join('/')}.txt`;
  }
  function bindSourceLinks(html) {
    return html.replace(
      /href="sources\/([^"#]+)\.txt"/g,
      (_match, encoded) =>
        `href="${sourceSnapshots[decodeURIComponent(encoded)]}"`,
    );
  }
  const snapshots = documents.map((doc) => {
    const snapshot = {
      ...doc,
      html: bindSourceLinks(doc.html),
      sourceUrl: sourceSnapshots[doc.path],
      reviewRecord: reviews.get(doc.path) ?? null,
    };
    const evidence = (snapshot.reviewRecord?.sources ?? []).map(
      ({ path: file }) => sourceSnapshots[bindingFile(file)],
    );
    return {
      ...snapshot,
      snapshotDigest: createHash('sha256')
        .update(JSON.stringify([snapshot, evidence]))
        .digest('hex'),
    };
  });
  const owner = snapshots.find((doc) => doc.path === moduleMap);
  const data = {
    revision,
    dirty: Boolean(git(['status', '--porcelain'], inputRoot)),
    builtAt: new Date().toISOString(),
    groups: catalog.groups,
    modules: renderedModules.map((module) => {
      const snapshot = { ...module, html: bindSourceLinks(module.html) };
      return {
        ...snapshot,
        snapshotDigest: createHash('sha256')
          .update(JSON.stringify([snapshot, owner.snapshotDigest]))
          .digest('hex'),
      };
    }),
    documents: snapshots,
    sourceSnapshots,
    captures: [...media.values()],
  };
  if (!check) {
    const output = path.join(inputRoot, '.kontourai/docs-learning');
    await mkdir(output, { recursive: true });
    for (const file of sourcePaths)
      await publishImmutableSnapshot(
        path.join(output, decodeURIComponent(sourceSnapshots[file])),
        capturedSources.get(file),
      );
    for (const capture of media.values())
      await publishImmutableSnapshot(
        path.join(output, decodeURIComponent(capture.url)),
        await captureSource(capture.path),
      );
    for (const asset of ['index.html', 'atlas.css', 'atlas.js'])
      await writeFile(
        path.join(output, asset),
        await captureSource(`docs/learn/${asset}`),
      );
    await writeFile(
      path.join(output, 'diagrams.js'),
      await buildDiagramBundle(),
    );
    const clientData = learningClientData(data);
    for (const [index, doc] of data.documents.entries()) {
      const destination = path.join(
        output,
        decodeURIComponent(clientData.documents[index].contentUrl),
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(
        destination,
        JSON.stringify({
          path: doc.path,
          digest: doc.digest,
          snapshotDigest: doc.snapshotDigest,
          html: doc.html,
          headings: doc.headings,
        }),
      );
    }
    await mkdir(path.join(output, 'modules'), { recursive: true });
    for (const module of data.modules)
      await writeFile(
        path.join(output, 'modules', `${module.id}.json`),
        JSON.stringify(module),
      );
    await writeFile(
      path.join(output, 'search-index.json'),
      JSON.stringify(
        data.documents.map(({ path: file, search }) => ({
          path: file,
          search,
        })),
      ),
    );
    await writeFile(
      path.join(output, 'inventory.json'),
      `${JSON.stringify({ revision, documents: snapshots.map(({ path: file, digest, review, reviewRecord }) => ({ path: file, digest, review, reviewRecord })) }, null, 2)}\n`,
    );
    await writeFile(
      path.join(output, 'atlas-data.json'),
      `${JSON.stringify(clientData)}\n`,
    );
  }
  console.log(
    `${check ? 'Validated' : 'Built'} learning atlas: ${catalog.groups.length} branches, ${modules.length} module sections, ${documents.length} Markdown documents. Semantic audit status remains separate.`,
  );
  return data;
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--check'))
      throw new Error('Usage: build-learning-guide.mjs [--check]');
    await buildLearningGuide({ check: args.includes('--check') });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
