import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  extractModules,
  headingId,
  validateCatalog,
} from './lib/documentation-model.mjs';
import { compileDocumentationReviews } from './lib/documentation-review.mjs';
import { publishImmutableSnapshot } from './lib/immutable-snapshot.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleMap = 'docs/architecture/module-map.md';
const repository = 'https://github.com/kontourai/station';
const textSource =
  /\.(?:[cm]?[jt]sx?|rs|json|ya?ml|toml|sh|py|css|html|mdx?|markdown)$/i;

function sourceSnapshotHref(file) {
  return `sources/${file.split('/').map(encodeURIComponent).join('/')}.txt`;
}

export function learningHref(
  href,
  document,
  files,
  revision,
  sourceFiles = new Set(),
) {
  const safe = defaultUrlTransform(href);
  for (const ref of ['main', revision]) {
    const prefix = `${repository}/blob/${ref}/`;
    if (!safe.startsWith(prefix)) continue;
    const [pathname, fragment = ''] = safe.slice(prefix.length).split('#');
    const file = decodeURIComponent(pathname);
    if (files.has(file))
      return `#doc=${encodeURIComponent(file)}${fragment ? `&section=${encodeURIComponent(decodeURIComponent(fragment))}` : ''}`;
    if (sourceFiles.has(file) && textSource.test(file))
      return sourceSnapshotHref(file);
  }
  if (!safe || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(safe)) return safe;
  const [pathname, fragment = ''] = safe.split('#');
  const destination = pathname
    ? path.posix.normalize(
        path.posix.join(
          path.posix.dirname(document),
          decodeURIComponent(pathname),
        ),
      )
    : document;
  if (destination.startsWith('../') || path.posix.isAbsolute(destination))
    return '';
  if (files.has(destination))
    return `#doc=${encodeURIComponent(destination)}${fragment ? `&section=${encodeURIComponent(fragment)}` : ''}`;
  if (sourceFiles.has(destination) && textSource.test(destination))
    return sourceSnapshotHref(destination);
  const encoded = destination.split('/').map(encodeURIComponent).join('/');
  return `${repository}/blob/${revision}/${encoded}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`;
}

function textOf(node) {
  return node.value ?? (node.children ?? []).map(textOf).join('');
}

export function renderLearningDocument(
  source,
  document,
  files,
  revision,
  sourceFiles = new Set(),
) {
  const headings = [];
  const seen = new Map();
  const components = {};
  for (let level = 1; level <= 6; level++) {
    components[`h${level}`] = ({ node, children }) => {
      const title = textOf(node);
      const base = headingId(title);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      headings.push({ id, level, title });
      return createElement(`h${level}`, { id }, children);
    };
  }
  components.img = ({ alt, src }) =>
    createElement('a', { href: src }, alt || 'Referenced image');
  components.code = ({ className, children }) =>
    className === 'language-mermaid'
      ? createElement(
          'span',
          null,
          createElement(
            'span',
            { className: 'diagram-label' },
            'Diagram source',
          ),
          createElement('code', { className }, children),
        )
      : sourceFiles.has(String(children))
        ? createElement(
            'a',
            {
              href: textSource.test(String(children))
                ? sourceSnapshotHref(String(children))
                : `${repository}/blob/${revision}/${String(children).split('/').map(encodeURIComponent).join('/')}`,
            },
            createElement('code', null, children),
          )
        : createElement('code', { className }, children);
  const html = renderToStaticMarkup(
    createElement(
      Markdown,
      {
        remarkPlugins: [remarkGfm],
        components,
        urlTransform: (href) =>
          learningHref(href, document, files, revision, sourceFiles),
      },
      source,
    ),
  );
  return { html, headings };
}

function git(args, cwd = root) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trimEnd();
}

export async function buildDiagramBundle() {
  const result = await build({
    entryPoints: [path.join(root, 'docs/learn/diagrams.js')],
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

export async function buildLearningGuide({
  check = false,
  root: inputRoot = root,
} = {}) {
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
      capturedSources.set(file, await readFile(path.join(inputRoot, file)));
    return capturedSources.get(file);
  }
  const catalog = JSON.parse(
    (await captureSource('docs/learn/atlas.json')).toString('utf8'),
  );
  const modules = extractModules(
    (await captureSource(moduleMap)).toString('utf8'),
  );
  validateCatalog(catalog, modules, files);
  const documents = [];
  for (const file of files) {
    const bytes = await captureSource(file);
    const source = bytes.toString('utf8');
    const rendered = renderLearningDocument(
      source,
      file,
      files,
      revision,
      sourceFiles,
    );
    documents.push({
      path: file,
      title: rendered.headings[0]?.title ?? file,
      digest: createHash('sha256').update(bytes).digest('hex'),
      review: 'Semantic review not established by this build',
      search: source.toLowerCase(),
      ...rendered,
    });
  }
  for (const group of catalog.groups) {
    for (const reference of group.docs) {
      const [file, anchor] = reference.split('#');
      if (
        anchor &&
        !documents
          .find((doc) => doc.path === file)
          ?.headings.some((heading) => heading.id === anchor)
      )
        throw new Error(`Missing learning section: ${reference}`);
    }
  }
  const reviews = await compileDocumentationReviews(
    JSON.parse(
      (await captureSource('docs/learn/review-ledger.json')).toString('utf8'),
    ),
    new Map(documents.map((doc) => [doc.path, doc.digest])),
    sourceFiles,
    captureSource,
    { requireFresh: check },
  );
  const renderedModules = modules.map(({ text, ...module }) => ({
    ...module,
    digest: createHash('sha256').update(text).digest('hex'),
    ...renderLearningDocument(text, moduleMap, files, revision, sourceFiles),
  }));
  const sourcePaths = [
    ...new Set([
      ...files,
      ...[...reviews.values()].flatMap((review) =>
        review.sources.map((source) => source.path),
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
      ({ path: file }) => sourceSnapshots[file],
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
  };
  if (!check) {
    const output = path.join(inputRoot, '.kontourai/docs-learning');
    await mkdir(output, { recursive: true });
    for (const file of sourcePaths)
      await publishImmutableSnapshot(
        path.join(output, decodeURIComponent(sourceSnapshots[file])),
        capturedSources.get(file),
      );
    for (const asset of ['index.html', 'atlas.css', 'atlas.js'])
      await copyFile(
        path.join(inputRoot, 'docs/learn', asset),
        path.join(output, asset),
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
