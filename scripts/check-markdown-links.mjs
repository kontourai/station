import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKDOWN_LINK = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
const EXTERNAL_TARGET = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

export function parseTrackedMarkdownFiles(output) {
  return output.split('\0').filter(Boolean).sort();
}

export function listTrackedMarkdownFiles(root = process.cwd()) {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.md', '*.mdx'],
    { cwd: root, encoding: 'utf8' },
  );
  const files = parseTrackedMarkdownFiles(output);
  if (files.length === 0) {
    throw new Error('Tracked Markdown discovery returned no files.');
  }
  return files;
}

function relativeTarget(rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/g, '');
  if (!target || target.startsWith('#') || EXTERNAL_TARGET.test(target)) {
    return null;
  }

  const withoutTitle = target.match(/^(\S+)(?:\s+["'].*["'])?$/)?.[1] ?? target;
  const pathname = withoutTitle.split(/[?#]/, 1)[0];
  return pathname ? decodeURIComponent(pathname) : null;
}

export async function findBrokenMarkdownLinks({ files, root = process.cwd() }) {
  const repositoryRoot = path.resolve(root);
  const failures = [];

  for (const file of files) {
    const sourcePath = path.resolve(repositoryRoot, file);
    const source = await readFile(sourcePath, 'utf8');

    for (const match of source.matchAll(MARKDOWN_LINK)) {
      const target = relativeTarget(match[2]);
      if (!target) continue;

      const resolved = path.resolve(path.dirname(sourcePath), target);
      const relative = path.relative(repositoryRoot, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        failures.push({
          file,
          label: match[1],
          target,
          reason: 'outside repository',
        });
        continue;
      }

      try {
        await access(resolved);
      } catch {
        failures.push({
          file,
          label: match[1],
          target,
          reason: 'missing target',
        });
      }
    }
  }

  return failures;
}

export async function checkMarkdownLinks({ files, root = process.cwd() }) {
  const failures = await findBrokenMarkdownLinks({ files, root });
  if (failures.length === 0) return;

  const detail = failures
    .map(
      ({ file, label, reason, target }) =>
        `- ${file}: [${label}](${target}) — ${reason}`,
    )
    .join('\n');
  throw new Error(`Broken relative Markdown links:\n${detail}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.slice(2);

  try {
    const selectedFiles = files.length > 0 ? files : listTrackedMarkdownFiles();
    await checkMarkdownLinks({ files: selectedFiles });
    console.log(
      `Validated relative links in ${selectedFiles.length} Markdown files.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
