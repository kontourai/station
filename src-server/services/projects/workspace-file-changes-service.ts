import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import {
  WORKSPACE_FILE_CHANGES_MAX_BYTES,
  type WorkspaceFileChanges,
} from '@kontourai/station-contracts/workspace-file-preview';
import { execGit } from '../../utils/git-exec.js';
import { checkRepositoryConfig } from './git-repository-config.js';
import type { WorkspaceFilePreviewService } from './workspace-file-preview-service.js';

const GIT_QUICK_TIMEOUT_MS = 10_000;
const GIT_DIFF_TIMEOUT_MS = 30_000;

type GitRunner = (
  args: string[],
  cwd: string,
  maxBuffer?: number,
) => Promise<string>;

const defaultRunner: GitRunner = async (args, cwd, maxBuffer) =>
  (
    await execGit(args, {
      cwd,
      encoding: 'utf-8',
      timeout: args[0] === 'diff' ? GIT_DIFF_TIMEOUT_MS : GIT_QUICK_TIMEOUT_MS,
      ...(maxBuffer ? { maxBuffer } : {}),
    })
  ).stdout;

function exceededBuffer(error: unknown): boolean {
  return (
    error instanceof Error &&
    /maxBuffer/i.test(`${error.message} ${(error as { code?: unknown }).code}`)
  );
}

/**
 * One previewed file's changes against HEAD, for the File Preview's Changes
 * view. It reads exactly one pathspec in the repository that contains the
 * file, under the same read refusal (#2363) the coding diff route applies:
 * a repository whose own config defines a filter or diff driver is not run
 * `git diff` against, because `diff` would run it. `--no-ext-diff` and
 * `--no-textconv` keep the operator's global drivers out too.
 */
export class WorkspaceFileChangesService {
  constructor(
    private readonly preview: Pick<
      WorkspaceFilePreviewService,
      'changesTarget'
    >,
    private readonly git: GitRunner = defaultRunner,
    private readonly checkConfig: typeof checkRepositoryConfig = checkRepositoryConfig,
  ) {}

  /** Throws on a path the preview would refuse; the route answers 400. */
  async changes(
    workingDirectory: string,
    path: string,
  ): Promise<WorkspaceFileChanges | null> {
    const located = this.preview.changesTarget(workingDirectory, path);
    if (!located) return null;
    const cwd = located.existingAncestor;
    let top: string;
    try {
      top = realpathSync(
        (await this.git(['rev-parse', '--show-toplevel'], cwd)).trim(),
      );
    } catch {
      return { state: 'not-a-repository' };
    }
    const fromTop = relative(top, located.target);
    if (!fromTop || fromTop.startsWith(`..${sep}`) || fromTop === '..')
      return { state: 'not-a-repository' };
    const verdict = await this.checkConfig(top, 'read');
    if (!verdict.ok)
      return {
        state: 'refused',
        reason:
          verdict.code === 'repository-config-refused'
            ? `This repository's own configuration defines programs git diff would run (${verdict.keys.join(', ')}), so Station does not diff it.`
            : "git could not read this repository's configuration.",
      };
    try {
      await this.git(
        ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
        top,
      );
    } catch {
      return { state: 'no-commits' };
    }
    // `top` and `literal`: the path is the file's own name from the
    // repository root, never a glob a file name could smuggle in.
    const pathspec = `:(top,literal)${fromTop.split(sep).join('/')}`;
    let patch: string;
    try {
      patch = await this.git(
        [
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          'HEAD',
          '--',
          pathspec,
        ],
        top,
        WORKSPACE_FILE_CHANGES_MAX_BYTES + 1,
      );
    } catch (error) {
      if (exceededBuffer(error))
        return {
          state: 'oversized',
          limitBytes: WORKSPACE_FILE_CHANGES_MAX_BYTES,
        };
      throw error;
    }
    if (Buffer.byteLength(patch, 'utf8') > WORKSPACE_FILE_CHANGES_MAX_BYTES)
      return {
        state: 'oversized',
        limitBytes: WORKSPACE_FILE_CHANGES_MAX_BYTES,
      };
    if (patch.trim()) return { state: 'changed', base: 'HEAD', patch };
    const untracked = await this.git(
      ['ls-files', '--others', '--', pathspec],
      top,
    );
    return untracked.trim()
      ? { state: 'untracked' }
      : { state: 'unchanged', base: 'HEAD' };
  }
}
