import { readSync } from 'node:fs';
import { stopLiveGitProcessGroups } from '../../../../utils/git-exec.ts';
import { codingDiffRoutes } from './coding-worktree-diff.ts';

// Stop only this child's Git groups. Give route finally blocks a short turn to
// dispose snapshots, then bound shutdown even if an interrupted read stalls.
function stopChild(code) {
  stopLiveGitProcessGroups();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}
process.once('SIGTERM', () => stopChild(143));
process.once('SIGINT', () => stopChild(130));
process.once('exit', () => {
  stopLiveGitProcessGroups();
});

// A process boundary, not a second route implementation: the real handler
// receives the same Project/path request used by the in-process route tests.
const bytes = Buffer.alloc(16 * 1024 + 1);
let length = 0;
while (length < bytes.length) {
  const count = readSync(0, bytes, length, bytes.length - length, null);
  if (count === 0) break;
  length += count;
}
if (length > 16 * 1024) throw new Error('Diff bridge input exceeds its bound');
const input = bytes.subarray(0, length).toString('utf8');
const { root } = JSON.parse(input);
if (typeof root !== 'string' || !root)
  throw new Error('Diff bridge requires its temporary root');
const response = await codingDiffRoutes(root).request(
  `/git/diff?projectSlug=project-alpha&path=${encodeURIComponent(root)}`,
);
process.stdout.write(
  JSON.stringify({ status: response.status, body: await response.json() }),
);
