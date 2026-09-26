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

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
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

export async function buildLearningGuide({ check = false } = {}) {
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean).sort();
  const files = new Set(
    tracked.filter((file) => /\.(md|mdx|markdown)$/i.test(file)),
  );
  if (!files.size)
    throw new Error('Learning inventory contains no tracked Markdown.');
  const revision = git(['rev-parse', 'HEAD']);
  const sourceFiles = new Set(tracked);
  const catalog = JSON.parse(
    await readFile(path.join(root, 'docs/learn/atlas.json'), 'utf8'),
  );
  const modules = extractModules(
    await readFile(path.join(root, moduleMap), 'utf8'),
  );
  validateCatalog(catalog, modules, files);
  const documents = [];
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
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
      digest: createHash('sha256').update(source).digest('hex'),
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
  const data = {
    revision,
    dirty: Boolean(git(['status', '--porcelain'])),
    builtAt: new Date().toISOString(),
    groups: catalog.groups,
    modules: modules.map(({ text, ...module }) => ({
      ...module,
      ...renderLearningDocument(text, moduleMap, files, revision, sourceFiles),
    })),
    documents,
    sourcePaths: [
      ...new Set([
        ...files,
        ...documents.flatMap((doc) =>
          [...doc.html.matchAll(/href="sources\/([^"#]+)\.txt"/g)].map(
            (match) => decodeURIComponent(match[1]),
          ),
        ),
      ]),
    ].sort(),
  };
  if (!check) {
    const output = path.join(root, '.kontourai/docs-learning');
    await mkdir(output, { recursive: true });
    for (const asset of ['index.html', 'atlas.css', 'atlas.js'])
      await copyFile(
        path.join(root, 'docs/learn', asset),
        path.join(output, asset),
      );
    await writeFile(
      path.join(output, 'diagrams.js'),
      await buildDiagramBundle(),
    );
    await writeFile(
      path.join(output, 'atlas-data.json'),
      `${JSON.stringify(data)}\n`,
    );
    await writeFile(
      path.join(output, 'inventory.json'),
      `${JSON.stringify({ revision, documents: documents.map(({ path: file, digest, review }) => ({ path: file, digest, review })) }, null, 2)}\n`,
    );
    for (const file of data.sourcePaths) {
      if (!sourceFiles.has(file))
        throw new Error(`Untracked source snapshot: ${file}`);
      const destination = path.join(output, 'sources', `${file}.txt`);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, file), destination);
    }
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
