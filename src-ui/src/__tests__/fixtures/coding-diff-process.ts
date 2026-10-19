import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { codingDiffRepositoryFixture } from '../../../../src-server/routes/projects/__tests__/fixtures/coding-worktree-diff-repository';

export { THREE_NEW_FILES } from '../../../../src-server/routes/projects/__tests__/fixtures/coding-worktree-diff-repository';

/** Node-only route work stays in a child; this UI-compiled client knows only
 * the test repository and JSON response, never server runtime types/imports. */
export function codingDiffProcessFixture(directory: string) {
  const repository = codingDiffRepositoryFixture(directory);
  const stationRoot = resolve(import.meta.dirname, '../../../..');
  const runner = resolve(
    stationRoot,
    'src-server/routes/projects/__tests__/fixtures/coding-worktree-diff-process.mjs',
  );
  const request = async () => {
    const before = repository.state();
    const raw = execFileSync(process.execPath, ['--import', 'tsx', runner], {
      cwd: stationRoot,
      input: JSON.stringify({ root: repository.root }),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45_000,
      maxBuffer: 12 * 1024 * 1024,
    });
    const result = JSON.parse(raw) as { status: number; body: unknown };
    const after = repository.state();
    if (before.index !== after.index || before.status !== after.status) {
      throw new Error('Public diff read changed the fixture index or status');
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { ...repository, request };
}
