import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

// Keep Git's per-path rename-aware lookup used by Changesets. Run a small
// bounded pool so a large versioning commit does not serialize every walk.
const CONCURRENCY = 3;
const git = promisify(execFile);
const { before, files } = JSON.parse(readFileSync(0, 'utf8'));
const results = [];
let next = 0;
const workers = Array.from(
  { length: Math.min(CONCURRENCY, files.length) },
  async () => {
    for (let index = next++; index < files.length; index = next++) {
      const { stdout } = await git(
        'git',
        [
          'log',
          '--diff-filter=AC',
          '--follow',
          '--max-count=1',
          '--pretty=format:%H:%p',
          before,
          '--',
          files[index],
        ],
        { windowsHide: true, maxBuffer: 64 * 1024 },
      );
      results[index] = stdout.trim();
    }
  },
);

// Report failure only after the launched Git children have settled.
const settled = await Promise.allSettled(workers);
for (const result of settled) {
  if (result.status === 'rejected') throw result.reason;
}
process.stdout.write(JSON.stringify(results));
