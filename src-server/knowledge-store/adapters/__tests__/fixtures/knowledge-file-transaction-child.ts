import { writeFileSync } from 'node:fs';
import { KnowledgeFileTransactions } from '../../shared/file-transactions.js';

const [root, mode, readyPath, releasePath] = process.argv.slice(2);
if (!root || !mode) throw new Error('root and mode are required');

let publications = 0;
const crashAfter =
  mode === 'crash-after-first-publish' ||
  mode === 'crash-backslash-after-publish'
    ? 1
    : mode === 'crash-after-final-publish'
      ? 2
      : undefined;
const files = new KnowledgeFileTransactions(root, {
  afterFilePublish:
    crashAfter === undefined
      ? undefined
      : () => {
          publications += 1;
          if (publications === crashAfter) process.exit(23);
        },
});

if (
  mode === 'crash-after-first-publish' ||
  mode === 'crash-after-final-publish'
) {
  await files.mutate('child-crash', () => {
    files.writeText(`${root}/record.md`, 'new-record');
    files.writeText(`${root}/index.json`, 'new-index');
  });
} else if (mode === 'crash-backslash-after-publish') {
  await files.mutate('child-backslash-crash', () => {
    files.writeText(`${root}/foo\\bar.md`, 'after');
  });
} else if (mode === 'hold-lock') {
  await files.mutate('child-hold', async () => {
    if (!readyPath) throw new Error('readyPath is required');
    if (!releasePath) throw new Error('releasePath is required');
    writeFileSync(readyPath, 'ready', 'utf8');
    while (!(await import('node:fs')).existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    files.writeText(`${root}/child.txt`, 'child');
  });
} else if (mode === 'write-external') {
  if (!readyPath) throw new Error('readyPath is required');
  if (!releasePath) throw new Error('releasePath is required');
  writeFileSync(readyPath, 'ready', 'utf8');
  while (!(await import('node:fs')).existsSync(releasePath)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  writeFileSync(`${root}/legacy.json`, 'changed', 'utf8');
} else {
  throw new Error(`unknown mode: ${mode}`);
}
