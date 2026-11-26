import { resolve } from 'node:path';
import type { ObservedSessionWorkspace } from '@kontourai/station-contracts/workspace-isolation';
import { execGit } from '../../utils/git-exec.js';
import { isCanonicalPathWithin } from '../../utils/path-containment.js';
import { readProjectRepository } from './git-read-repository.js';
import { listVerifiedWorktrees } from './verified-worktrees.js';

interface Workspace {
  projectRoot: string;
  cwd: string;
  base?: { ref: string; commit: string };
}

const LIMIT = 200;
const TTL = 120_000;
const RETAIN_FOR = 15 * 60_000;
const TIMEOUT = 2_500;

async function observe(
  workspace: Workspace,
): Promise<ObservedSessionWorkspace | undefined> {
  const { projectRoot, cwd, base } = workspace;
  const result = await readProjectRepository(
    projectRoot,
    cwd,
    {
      timeoutMs: TIMEOUT,
      registeredWorktrees: () => listVerifiedWorktrees(projectRoot, TIMEOUT),
    },
    async (repo) => {
      if (
        isCanonicalPathWithin(repo.top, projectRoot) &&
        repo.top !== resolve(projectRoot)
      )
        return undefined;
      const git = (args: string[]) =>
        execGit([...repo.repoArgs, ...args], {
          cwd: repo.top,
          encoding: 'utf-8',
          timeout: TIMEOUT,
          maxBuffer: 1024 * 1024,
        }).then(({ stdout }) => stdout);
      const branch = await git(['branch', '--show-current']).then((stdout) =>
        stdout.trim(),
      );
      const workspace: ObservedSessionWorkspace = branch ? { branch } : {};
      if (!base || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base.commit))
        return workspace;
      const diff = await git([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--numstat',
        '-z',
        base.commit,
        '--',
      ]).catch(() => undefined);
      if (diff === undefined) return workspace;
      let insertions = 0;
      let deletions = 0;
      let files = 0;
      for (const entry of diff.split('\u0000')) {
        if (!entry) continue;
        const [added, removed] = entry.split('	', 2);
        if (!/^\d+$/.test(added ?? '') || !/^\d+$/.test(removed ?? ''))
          return workspace;
        insertions += Number(added);
        deletions += Number(removed);
        files += 1;
      }
      workspace.diffStat = {
        insertions,
        deletions,
        files,
        baseRef: base.ref,
        observedAt: new Date().toISOString(),
      };
      return workspace;
    },
  );
  return result.ok ? result.value : undefined;
}

export class SessionDiffStatSnapshots {
  private readonly entries = new Map<
    string,
    {
      workspace: Workspace;
      requestedAt: number;
      at?: number;
      facts?: ObservedSessionWorkspace;
    }
  >();
  private refreshing = false;

  get(id: string, workspace: Workspace): ObservedSessionWorkspace | undefined {
    const now = Date.now();
    const prior = this.entries.get(id);
    const entry =
      prior &&
      prior.workspace.cwd === workspace.cwd &&
      prior.workspace.projectRoot === workspace.projectRoot &&
      prior.workspace.base?.commit === workspace.base?.commit
        ? prior
        : { workspace, requestedAt: now };
    entry.requestedAt = now;
    this.entries.delete(id);
    this.entries.set(id, entry);
    if (this.entries.size > LIMIT) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return entry.at && now - entry.at < TTL * 3 ? entry.facts : undefined;
  }

  async refresh(now: number, allowed: () => boolean): Promise<void> {
    if (this.refreshing || !allowed()) return;
    this.refreshing = true;
    try {
      for (const [id, entry] of this.entries) {
        if (now - entry.requestedAt >= RETAIN_FOR) this.entries.delete(id);
      }
      const due = [...this.entries.values()]
        .filter((entry) => now - (entry.at ?? 0) >= TTL)
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
        .slice(0, 4);
      for (const entry of due) {
        if (!allowed()) break;
        entry.facts = await observe(entry.workspace).catch(() => undefined);
        entry.at = now;
      }
    } finally {
      this.refreshing = false;
    }
  }
}
