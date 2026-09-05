import { execFileSync } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const docsRoot = path.join(repoRoot, 'docs');
const pagesRoot = path.join(docsRoot, 'pages');
const distRoot = path.join(repoRoot, 'dist-pages');
const publicDocsManifest = path.join(pagesRoot, 'public-docs.json');
const repositoryUrl = 'https://github.com/kontourai/station';
const RESTRICTED_PUBLIC_DOC_ROOTS = new Set([
  'adr',
  'architecture',
  'design',
  'patterns',
  'plans',
  'reference',
  'strategy',
]);
const EXPLICIT_PUBLIC_REFERENCE_SOURCES = new Set([
  'reference/contributor-commands.md',
  'reference/product-laws.md',
]);
const PUBLIC_SOURCE = /^(?:user|guides)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

export function isAllowedPublicDocSource(source) {
  const root = source.split('/', 1)[0];
  if (!RESTRICTED_PUBLIC_DOC_ROOTS.has(root)) return true;
  return EXPLICIT_PUBLIC_REFERENCE_SOURCES.has(source);
}

function sourceIsTracked(source, root) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', source], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await rm(distRoot, { force: true, recursive: true });
  await mkdir(distRoot, { recursive: true });
  await copyPagesAssets();
  const publicDocs = await loadPublicDocs();

  const docs = [];
  for (const publicDoc of publicDocs) {
    const file = path.join(docsRoot, publicDoc.source);
    const source = await readFile(file, 'utf8');
    const relativePath = publicDoc.source;
    const outputPath = path.join(
      distRoot,
      'docs',
      relativePath.replace(/\.md$/, '.html'),
    );
    const title = extractTitle(source, relativePath);
    const description = extractDescription(source);
    const html = renderMarkdown(source);
    await writeDocPage(outputPath, title, html, relativePath);
    docs.push({
      description,
      outputPath,
      relativePath,
      section: publicDoc.section,
      title,
    });
  }

  await writeDocsIndex(docs);
  await writeFile(
    path.join(distRoot, 'robots.txt'),
    'User-agent: *\nAllow: /\n',
    'utf8',
  );
  console.log(
    `Built GitHub Pages site with ${docs.length} public docs in dist-pages/`,
  );
}

async function copyPagesAssets() {
  const entries = await readdir(pagesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === 'README.md' || entry.name === 'public-docs.json') {
      continue;
    }
    await copyFile(
      path.join(pagesRoot, entry.name),
      path.join(distRoot, entry.name),
    );
  }
}

/**
 * Seams are declared, not inferred: defaulting `lstatPath` to `lstat` types
 * the seam as that function's whole overload set (including the promise
 * return), so a test stub answering the one question this code asks — "does
 * this path resolve, and is it a symlink?" — is rejected. TS2345 under
 * `typecheck:scripts`, invisible to a bare `tsc --noEmit`.
 *
 * @param {{
 *   manifestPath?: string,
 *   root?: string,
 *   isTracked?: (source: string, root: string) => boolean,
 *   lstatPath?: (path: string) => { isSymbolicLink(): boolean } | Promise<{ isSymbolicLink(): boolean }>,
 *   realpathPath?: (path: string) => string | Promise<string>,
 * }} [input]
 */
export async function loadPublicDocs({
  manifestPath = publicDocsManifest,
  root = docsRoot,
  isTracked = sourceIsTracked,
  lstatPath = lstat,
  realpathPath = realpath,
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.documents)) {
    throw new Error(
      'Public docs manifest must use schemaVersion 1 and documents[]',
    );
  }

  const seen = new Set();
  return Promise.all(
    manifest.documents.map(async (document, index) => {
      const source = document?.source;
      const section = document?.section;
      if (
        typeof source !== 'string' ||
        source.length === 0 ||
        source.includes('\\') ||
        path.posix.normalize(source) !== source ||
        path.posix.isAbsolute(source) ||
        source.startsWith('../') ||
        source.startsWith('pages/') ||
        !source.endsWith('.md') ||
        (!PUBLIC_SOURCE.test(source) &&
          !EXPLICIT_PUBLIC_REFERENCE_SOURCES.has(source)) ||
        !isAllowedPublicDocSource(source)
      ) {
        throw new Error(`Invalid public docs source at documents[${index}]`);
      }
      if (
        typeof section !== 'string' ||
        section.trim() !== section ||
        !section
      ) {
        throw new Error(`Invalid public docs section at documents[${index}]`);
      }
      if (seen.has(source)) {
        throw new Error(`Duplicate public docs source: ${source}`);
      }
      seen.add(source);

      const sourcePath = path.resolve(root, source);
      const relative = path.relative(root, sourcePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Public docs source escapes docs root: ${source}`);
      }
      if (!isTracked(source, root))
        throw new Error(`Public docs source is not git-tracked: ${source}`);
      const sourceStat = await lstatPath(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
        throw new Error(`Public docs source is not a regular file: ${source}`);
      const [realRoot, realSource] = await Promise.all([
        realpathPath(root),
        realpathPath(sourcePath),
      ]);
      const resolvedRelative = path.relative(realRoot, realSource);
      if (
        resolvedRelative.startsWith('..') ||
        path.isAbsolute(resolvedRelative)
      ) {
        throw new Error(`Public docs source escapes docs root: ${source}`);
      }
      await readFile(realSource, 'utf8');
      return { section, source };
    }),
  );
}

function extractTitle(source, fallback) {
  const match = source.match(/^#\s+(.+)$/m);
  return stripMarkdown(
    match?.[1] ?? fallback.replace(/\.md$/, '').replaceAll('/', ' / '),
  );
}

function extractDescription(source) {
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .filter((line) => !line.startsWith('>'))
    .filter((line) => !line.startsWith('|'))
    .filter((line) => !line.startsWith('```'));
  const candidate = lines.find((line) => /[a-zA-Z]/.test(line));
  return stripMarkdown(candidate ?? 'Station documentation');
}

export function renderMarkdown(source) {
  const lines = source.split('\n');
  const html = [];
  let inFence = false;
  let inTable = false;
  let tableRows = [];
  // Markdown wraps prose across source lines; a wrapped paragraph or list
  // item is one block, not one block per line. Open blocks collect their
  // continuation lines until a blank line or another block starts. Lists
  // nest by indentation: a deeper item opens a list inside the current <li>.
  let listStack = [];
  let openItem = null;
  let paragraph = [];

  const flushItemText = () => {
    if (openItem === null) return;
    html.push(`<li>${renderInline(openItem.join(' '))}`);
    openItem = null;
  };

  const closeCurrentItem = () => {
    flushItemText();
    const level = listStack[listStack.length - 1];
    if (level?.itemOpen) {
      html.push('</li>');
      level.itemOpen = false;
    }
  };

  const popListLevel = () => {
    closeCurrentItem();
    html.push(`</${listStack[listStack.length - 1].tag}>`);
    listStack.pop();
    const parent = listStack[listStack.length - 1];
    if (parent?.itemOpen) {
      html.push('</li>');
      parent.itemOpen = false;
    }
  };

  const closeList = () => {
    while (listStack.length > 0) popListLevel();
  };

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const closeTable = () => {
    if (!inTable) return;
    html.push(renderTable(tableRows));
    tableRows = [];
    inTable = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (/^\s*```/.test(line)) {
      closeParagraph();
      closeList();
      closeTable();
      if (inFence) {
        html.push('</code></pre>');
        inFence = false;
      } else {
        html.push('<pre><code>');
        inFence = true;
      }
      continue;
    }

    if (inFence) {
      html.push(escapeHtml(rawLine));
      continue;
    }

    if (isTableLine(line)) {
      closeParagraph();
      closeList();
      inTable = true;
      tableRows.push(line);
      continue;
    }
    closeTable();

    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const listItem = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (listItem) {
      closeParagraph();
      const indent = listItem[1].length;
      const tag = /^\d/.test(listItem[2]) ? 'ol' : 'ul';
      const top = listStack[listStack.length - 1];
      if (top && indent > top.indent) {
        flushItemText();
        html.push(`<${tag}>`);
        listStack.push({ indent, itemOpen: false, tag });
      } else if (top) {
        while (
          listStack.length > 1 &&
          indent < listStack[listStack.length - 1].indent
        ) {
          popListLevel();
        }
        closeCurrentItem();
        if (listStack[listStack.length - 1].tag !== tag) {
          closeList();
        }
      }
      if (listStack.length === 0) {
        html.push(`<${tag}>`);
        listStack.push({ indent, itemOpen: false, tag });
      }
      listStack[listStack.length - 1].itemOpen = true;
      openItem = [listItem[3]];
      continue;
    }

    if (line.startsWith('>')) {
      closeParagraph();
      closeList();
      html.push(
        `<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`,
      );
      continue;
    }

    if (openItem !== null) {
      openItem.push(line.trim());
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  closeParagraph();
  closeList();
  closeTable();
  if (inFence) html.push('</code></pre>');
  return html.join('\n');
}

function isTableLine(line) {
  return line.startsWith('|') && line.endsWith('|') && line.includes('|');
}

function renderTable(rows) {
  const filtered = rows.filter(
    (row) => !/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|$/.test(row),
  );
  if (filtered.length === 0) return '';
  const [header, ...body] = filtered.map((row) =>
    row
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim()),
  );
  const headerHtml = header
    .map((cell) => `<th>${renderInline(cell)}</th>`)
    .join('');
  const bodyHtml = body
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`,
    )
    .join('\n');
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

export function renderInline(value) {
  const escaped = escapeHtml(value);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
      const normalized = href.endsWith('.md')
        ? href.replace(/\.md$/, '.html')
        : href.replace(/\.md#/, '.html#');
      const safeHref = /^(?:https?:|mailto:|#|\/|\.\.?\/)/i.test(normalized)
        ? normalized
        : '#';
      return `<a href="${escapeAttribute(safeHref)}">${label}</a>`;
    });
}

function stripMarkdown(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .trim();
}

async function writeDocPage(outputPath, title, body, sourcePath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const depthToRoot = path.relative(path.dirname(outputPath), distRoot) || '.';
  const cssPath = path
    .join(depthToRoot, 'styles.css')
    .replaceAll(path.sep, '/');
  const docsIndexPath = path
    .join(depthToRoot, 'docs', 'index.html')
    .replaceAll(path.sep, '/');
  const homePath = path
    .join(depthToRoot, 'index.html')
    .replaceAll(path.sep, '/');
  await writeFile(
    outputPath,
    pageShell({
      body: `
        <div class="docs-layout">
          <aside class="docs-nav">
            <a href="${escapeAttribute(homePath)}">Home</a>
            <a href="${escapeAttribute(docsIndexPath)}">Docs index</a>
            <a href="${escapeAttribute(`${repositoryUrl}/blob/main/docs/${sourcePath}`)}">Edit on GitHub</a>
          </aside>
          <article class="docs-content">
            ${body}
          </article>
        </div>
      `,
      cssPath,
      docsHref: docsIndexPath,
      homeHref: homePath,
      platformHref: `${homePath}#platform`,
      title: `${title} | Station Docs`,
    }),
    'utf8',
  );
}

export function renderDocsIndexSections(docs) {
  const bySection = new Map();
  for (const doc of docs) {
    bySection.set(doc.section, [...(bySection.get(doc.section) ?? []), doc]);
  }

  return [...bySection.entries()]
    .map(([section, sectionDocs]) => {
      const cards = sectionDocs
        .map((doc) => {
          const href = doc.relativePath
            .replace(/\.md$/, '.html')
            .replaceAll(path.sep, '/');
          return `<a class="doc-card" href="${escapeAttribute(`./${href}`)}"><strong>${escapeHtml(doc.title)}</strong><span>${escapeHtml(doc.description)}</span></a>`;
        })
        .join('\n');
      return `<h2>${escapeHtml(titleCase(section))}</h2><div class="doc-list">${cards}</div>`;
    })
    .join('\n');
}

async function writeDocsIndex(docs) {
  const sections = renderDocsIndexSections(docs);

  await mkdir(path.join(distRoot, 'docs'), { recursive: true });
  await writeFile(
    path.join(distRoot, 'docs', 'index.html'),
    pageShell({
      body: `
        <div class="docs-layout">
          <aside class="docs-nav">
            <a href="../index.html">Home</a>
            <a href="./index.html">Docs index</a>
            <a href="${repositoryUrl}/tree/main/docs">Docs source</a>
          </aside>
          <article class="docs-content">
            <p class="eyebrow">Documentation</p>
            <h1>Use Station.</h1>
            <p>These product and end-user documents are the intentional public projection of Station's repository documentation.</p>
            ${sections}
          </article>
        </div>
      `,
      cssPath: '../styles.css',
      docsHref: './index.html',
      homeHref: '../index.html',
      platformHref: '../index.html#platform',
      title: 'Station Documentation',
    }),
    'utf8',
  );
}

function pageShell({ body, cssPath, docsHref, homeHref, platformHref, title }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${escapeAttribute(cssPath)}" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="${escapeAttribute(homeHref)}">Station</a>
      <nav aria-label="Primary">
        <a href="${escapeAttribute(platformHref)}">Platform</a>
        <a href="${escapeAttribute(docsHref)}">Docs</a>
        <a href="${escapeAttribute(repositoryUrl)}">GitHub</a>
      </nav>
    </header>
    <main>${body}</main>
    <footer>
      <span>Station</span>
      <a href="${escapeAttribute(repositoryUrl)}">GitHub</a>
    </footer>
  </body>
</html>`;
}

function titleCase(value) {
  return value
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
