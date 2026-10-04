import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { headingId } from './documentation-model.mjs';
import { isLearningSourcePath } from './learning-source-reader.mjs';

const repository = 'https://github.com/kontourai/station';
const textSourceExtension =
  /\.(?:[cm]?[jt]sx?|rs|swift|go|kt|kts|java|c|cc|cpp|cxx|h|hpp|m|mm|cs|fsx?|jsonc?|jsonl|sarif|ya?ml|toml|xml|plist|entitlements|xcprivacy|xcconfig|pbxproj|xcworkspacedata|xcsettings|xcscheme|storyboard|gradle|properties|pro|lock|mod|sum|ini|conf|cfg|sh|bash|zsh|fish|ps1|bat|cmd|nsh|py|rb|sql|graphql|proto|css|scss|html|svg|mdx?|markdown|txt|csv|patch)$/i;
const textSourceNames = new Set([
  'Dockerfile',
  'Containerfile',
  'Makefile',
  'GNUmakefile',
  'Caddyfile',
  'Podfile',
  'Gemfile',
  'justfile',
  'Justfile',
  'gradlew',
  'station',
  'CODEOWNERS',
  'SPDX-LICENSE',
  '.dockerignore',
  '.editorconfig',
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.gitkeep',
  '.gitleaksignore',
  '.npmrc',
  '.nvmrc',
  '.yarnrc',
]);

function isTextSource(file) {
  const name = path.posix.basename(file);
  return (
    textSourceExtension.test(name) ||
    textSourceNames.has(name) ||
    /^(?:LICENSE|COPYING|NOTICE)(?:-[A-Z0-9.-]+)?$/.test(name) ||
    /^\.githooks\/[^/.]+$/.test(file)
  );
}

function sourceSnapshotHref(file) {
  return `sources/${file.split('/').map(encodeURIComponent).join('/')}.txt`;
}

/** The reader and link gate share which references belong to this snapshot. */
function resolveLearningLink(
  href,
  document,
  files,
  revision,
  sourceFiles = new Set(),
) {
  const safe = defaultUrlTransform(href);
  try {
    for (const ref of ['main', revision]) {
      const prefix = `${repository}/blob/${ref}/`;
      if (!safe.startsWith(prefix)) continue;
      const [pathname, ...fragmentParts] = safe.slice(prefix.length).split('#');
      const file = decodeURIComponent(pathname.split('?')[0]);
      if (!isLearningSourcePath(file))
        return { kind: 'invalid', reason: 'unsafe repository path' };
      if (files.has(file) || (sourceFiles.has(file) && isTextSource(file)))
        return {
          kind: 'local',
          file,
          fragment: decodeURIComponent(fragmentParts.join('#')),
        };
    }
    if (!safe || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(safe))
      return { kind: 'external', href: safe };
    const [pathname, ...fragmentParts] = safe.split('#');
    const decoded = decodeURIComponent(pathname.split('?')[0]);
    if (/[\\:\0]/.test(decoded))
      return { kind: 'invalid', reason: 'unsafe repository path' };
    const destination = decoded
      ? path.posix.normalize(
          path.posix.join(path.posix.dirname(document), decoded),
        )
      : document;
    if (
      decoded.startsWith('/') ||
      destination === '..' ||
      destination.startsWith('../') ||
      path.posix.isAbsolute(destination)
    )
      return { kind: 'invalid', reason: 'outside repository' };
    return {
      kind: 'local',
      file: destination,
      fragment: decodeURIComponent(fragmentParts.join('#')),
    };
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return { kind: 'invalid', reason: 'invalid URL encoding' };
  }
}

export function learningHref(
  href,
  document,
  files,
  revision,
  sourceFiles = new Set(),
) {
  const target = resolveLearningLink(
    href,
    document,
    files,
    revision,
    sourceFiles,
  );
  if (target.kind === 'external') return target.href;
  if (target.kind === 'invalid') return '';
  const { file, fragment } = target;
  if (files.has(file))
    return `#doc=${encodeURIComponent(file)}${fragment ? `&section=${encodeURIComponent(fragment)}` : ''}`;
  if (sourceFiles.has(file) && isTextSource(file))
    return sourceSnapshotHref(file);
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  return `${repository}/blob/${revision}/${encoded}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`;
}

function textOf(node) {
  return node.value ?? (node.children ?? []).map(textOf).join('');
}

const SAFE_ANCHOR_ID = /^[A-Za-z][A-Za-z\d_.:-]*$/;

/** Admit only empty anchor declarations, never arbitrary raw HTML or attributes. */
function remarkExplicitAnchors() {
  return (tree) => {
    function visit(parent) {
      if (!parent.children) return;
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index];
        if (node.type === 'html') {
          const match =
            /^<(a|span)\s+(id|name)\s*=\s*(["'])([A-Za-z][A-Za-z\d_.:-]*)\3\s*>(?:\s*<\/\1>)?\s*$/i.exec(
              node.value,
            );
          if (
            match &&
            (match[2].toLowerCase() === 'id' || match[1].toLowerCase() === 'a')
          ) {
            const closed = new RegExp(`<\\/${match[1]}>\\s*$`, 'i').test(
              node.value,
            );
            const next = parent.children[index + 1];
            const paired =
              next?.type === 'html' &&
              new RegExp(`^<\\/${match[1]}>$`, 'i').test(next.value);
            if (closed || paired) {
              parent.children.splice(index, paired && !closed ? 2 : 1, {
                type: 'paragraph',
                children: [],
                data: { hName: 'span', hProperties: { id: match[4] } },
                position: node.position,
              });
              continue;
            }
          }
        }
        visit(node);
      }
    }
    visit(tree);
  };
}

export function renderLearningDocument(
  source,
  document,
  files,
  revision,
  sourceFiles = new Set(),
  media = new Map(),
) {
  const headings = [];
  const links = [];
  const anchors = new Set();
  const duplicateAnchors = [];
  const used = new Set();
  const observeIds = () => (tree) => {
    function visit(node) {
      const id = node.properties?.id;
      if (typeof id === 'string') {
        if (anchors.has(id)) duplicateAnchors.push(id);
        anchors.add(id);
        used.add(id);
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(tree);
  };
  const components = {};
  for (let level = 1; level <= 6; level++) {
    components[`h${level}`] = ({ node, children }) => {
      const title = textOf(node);
      // Preserve parser-generated IDs such as GFM's footnote label. Reserve
      // explicit anchors first so heading suffixes cannot create duplicate IDs.
      const declared = node.properties?.id;
      const base =
        typeof declared === 'string' && SAFE_ANCHOR_ID.test(declared)
          ? declared
          : headingId(title);
      let id = base;
      if (declared !== base) {
        let suffix = 0;
        while (used.has(id)) id = `${base}-${++suffix}`;
      }
      used.add(id);
      anchors.add(id);
      headings.push({ id, level, title });
      return createElement(`h${level}`, { id }, children);
    };
  }
  const mediaByUrl = new Map(
    [...media.values()].map((capture) => [capture.url, capture]),
  );
  components.img = ({ alt, src }) => {
    const capture = mediaByUrl.get(src);
    if (!capture)
      return createElement('a', { href: src }, alt || 'Referenced image');
    return createElement(
      'span',
      { className: 'learning-capture' },
      capture.kind === 'video'
        ? createElement('video', {
            controls: true,
            preload: 'none',
            src,
            'aria-label': alt || capture.alt,
          })
        : createElement(
            'a',
            { href: src, target: '_blank', rel: 'noreferrer' },
            createElement('img', {
              src,
              alt: alt || capture.alt,
              loading: 'lazy',
              decoding: 'async',
            }),
          ),
      createElement('span', { className: 'capture-caption' }, capture.caption),
      createElement(
        'span',
        { className: 'capture-evidence' },
        `${capture.scenario}. ${capture.evidence}`,
      ),
      createElement(
        'span',
        { className: 'capture-revision' },
        capture.historyChanges !== undefined
          ? `Captured at ${capture.capturedRevision.slice(0, 12)}; source reviews are recorded in append-only notes.${capture.historyUnavailable ? ` ${capture.historyUnavailable}` : ` Review history since ${capture.reviewBaseline?.slice(0, 12) ?? 'the ledger baseline'}.`}`
          : `Captured at ${capture.capturedRevision.slice(0, 12)}; sources reviewed at ${[
              ...new Set(
                capture.sources.map((source) => source.revision.slice(0, 12)),
              ),
            ].join(', ')}.`,
      ),
      capture.changed.length
        ? createElement(
            'strong',
            { className: 'capture-stale' },
            'Visual review needed: supporting code has changed.',
          )
        : null,
    );
  };
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
              href: isTextSource(String(children))
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
        remarkPlugins: [remarkGfm, remarkExplicitAnchors],
        rehypePlugins: [observeIds],
        components,
        urlTransform: (href, key, node) => {
          if (
            (key === 'href' && node.tagName === 'a') ||
            (key === 'src' && node.tagName === 'img')
          )
            links.push({
              target: href,
              label: textOf(node),
              ...(node.position?.start.line
                ? { line: node.position.start.line }
                : {}),
              destination: resolveLearningLink(
                href,
                document,
                files,
                revision,
                sourceFiles,
              ),
            });
          const destination = resolveLearningLink(
            href,
            document,
            files,
            revision,
            sourceFiles,
          );
          if (destination.kind === 'local' && media.has(destination.file))
            return media.get(destination.file).url;
          return learningHref(href, document, files, revision, sourceFiles);
        },
      },
      source,
    ),
  );
  return { html, headings, anchors: [...anchors], duplicateAnchors, links };
}
