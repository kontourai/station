import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { renderLearningDocument } from './lib/learning-markdown.mjs';
import { createLearningSourceReader } from './lib/learning-source-reader.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const MARKDOWN_FILE = /\.(?:md|mdx|markdown)$/i;

export function parseTrackedMarkdownFiles(output) {
  return output.split('\0').filter(Boolean).sort();
}

function git(root, args) {
  return execFileSyncBounded('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

export function listTrackedMarkdownFiles(root = process.cwd()) {
  const files = parseTrackedMarkdownFiles(git(root, ['ls-files', '-z'])).filter(
    (file) => MARKDOWN_FILE.test(file),
  );
  if (files.length === 0)
    throw new Error('Tracked Markdown discovery returned no files.');
  return files;
}

/** Validate already-rendered input so a generated snapshot never rereads its prose. */
export async function findBrokenRenderedMarkdownLinks({
  documents,
  files = [...documents.keys()],
  targetExists,
}) {
  const failures = [];
  for (const file of files) {
    const document = documents.get(file);
    if (!document) throw new Error(`Markdown source was not rendered: ${file}`);
    for (const id of document.duplicateAnchors)
      failures.push({
        file,
        label: id,
        target: `#${id}`,
        reason: 'duplicate anchor',
      });
    for (const { destination, ...link } of document.links) {
      if (destination.kind === 'external') continue;
      if (destination.kind === 'invalid') {
        failures.push({ file, ...link, reason: destination.reason });
        continue;
      }
      const target = documents.get(destination.file);
      if (!target && !(await targetExists(destination.file))) {
        failures.push({ file, ...link, reason: 'missing target' });
      } else if (MARKDOWN_FILE.test(destination.file)) {
        if (!target)
          failures.push({
            file,
            ...link,
            reason: 'Markdown target is not in the snapshot',
          });
        else if (
          destination.fragment &&
          !target.anchors.includes(destination.fragment)
        )
          failures.push({
            file,
            ...link,
            reason: `missing anchor #${destination.fragment}`,
          });
      }
    }
  }
  return failures;
}

export function assertMarkdownLinks(failures) {
  if (failures.length === 0) return;
  const detail = failures
    .map(
      ({ file, line, label, reason, target }) =>
        `- ${file}${line ? `:${line}` : ''}: [${label}](${target}) — ${reason}`,
    )
    .join('\n');
  throw new Error(`Broken local Markdown links:\n${detail}`);
}

export async function findBrokenMarkdownLinks({
  files,
  root = process.cwd(),
  revision = 'main',
  sourceFiles = files,
}) {
  const reader = createLearningSourceReader(root);
  const tracked = new Set(sourceFiles);
  const markdown = new Set(
    [...tracked].filter((file) => MARKDOWN_FILE.test(file)),
  );
  const documents = new Map();
  const missing = new Set();
  async function render(file) {
    if (documents.has(file) || missing.has(file)) return;
    let source;
    try {
      source = reader.read(file).toString('utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.add(file);
      return;
    }
    documents.set(
      file,
      renderLearningDocument(source, file, markdown, revision, tracked),
    );
  }
  for (const file of files) {
    await render(file);
    if (!documents.has(file))
      throw new Error(`Missing Markdown source: ${file}`);
  }
  // A selected source may link to Markdown outside the selected check scope.
  // Render that target for its actual IDs, but do not recursively widen scope.
  for (const file of files)
    for (const { destination } of documents.get(file).links)
      if (destination.kind === 'local' && MARKDOWN_FILE.test(destination.file))
        await render(destination.file);
  return findBrokenRenderedMarkdownLinks({
    documents,
    files,
    targetExists: (file) => reader.exists(file),
  });
}

export async function checkMarkdownLinks(options) {
  assertMarkdownLinks(await findBrokenMarkdownLinks(options));
}

if (invokedDirectly(import.meta.url)) {
  // `--json` prints `{ checkedFiles, failures, error }` on stdout, so a
  // caller (or a test) asserts fields and the exit status rather than the
  // wording of the human report (#2927).
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const selected = args.filter((arg) => arg !== '--json');
  const report = (value) =>
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const root = process.cwd();
    const files =
      selected.length > 0 ? selected : listTrackedMarkdownFiles(root);
    const failures = await findBrokenMarkdownLinks({
      files,
      root,
      revision: git(root, ['rev-parse', 'HEAD']).trim(),
      sourceFiles: parseTrackedMarkdownFiles(git(root, ['ls-files', '-z'])),
    });
    if (json) report({ checkedFiles: files.length, failures, error: null });
    else {
      assertMarkdownLinks(failures);
      console.log(
        `Validated local paths and rendered anchors in ${files.length} Markdown files.`,
      );
    }
    if (failures.length > 0) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) report({ checkedFiles: null, failures: [], error: message });
    else console.error(message);
    process.exitCode = 1;
  }
}
