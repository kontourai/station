import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HREF = /\shref=["']([^"']+)["']/g;
const EXTERNAL_TARGET = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

export async function findGeneratedHtmlFiles({ root = process.cwd() } = {}) {
  const repositoryRoot = path.resolve(root);
  const pagesRoot = path.join(repositoryRoot, 'dist-pages');
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        files.push(path.relative(repositoryRoot, fullPath));
      }
    }
  }

  await visit(pagesRoot);
  return files.sort();
}

/**
 * @param {{ files?: string[], root?: string }} [options]
 */
export async function findBrokenGeneratedPageLinks({
  files,
  root = process.cwd(),
} = {}) {
  const repositoryRoot = path.resolve(root);
  const pagesRoot = path.join(repositoryRoot, 'dist-pages');
  const failures = [];
  const selectedFiles = files ?? (await findGeneratedHtmlFiles({ root }));

  for (const file of selectedFiles) {
    const sourcePath = path.resolve(repositoryRoot, file);
    const source = await readFile(sourcePath, 'utf8');

    for (const match of source.matchAll(HREF)) {
      const href = match[1].trim();
      if (!href || EXTERNAL_TARGET.test(href)) continue;

      const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]);
      const resolved = path.resolve(path.dirname(sourcePath), pathname);
      const relative = path.relative(pagesRoot, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        failures.push({ file, href, reason: 'outside generated site' });
        continue;
      }

      try {
        await access(resolved);
      } catch {
        failures.push({ file, href, reason: 'missing generated target' });
      }
    }
  }

  return failures;
}

/**
 * @param {{ files?: string[], root?: string }} [options]
 */
export async function checkGeneratedPageLinks(options = {}) {
  const failures = await findBrokenGeneratedPageLinks(options);
  if (failures.length === 0) return;

  const detail = failures
    .map(({ file, href, reason }) => `- ${file}: ${href} — ${reason}`)
    .join('\n');
  throw new Error(`Broken generated Pages links:\n${detail}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.slice(2);
  const selectedFiles =
    files.length > 0 ? files : await findGeneratedHtmlFiles();

  try {
    await checkGeneratedPageLinks({ files: selectedFiles });
    console.log(
      `Validated generated links in ${selectedFiles.length} public pages.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
