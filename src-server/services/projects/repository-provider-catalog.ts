import { normalizeGitOrigin } from '@kontourai/station-contracts/git-remote-identity';
import type {
  RepositoryProvider,
  RepositoryProviderPage,
  RepositoryProviderSelection,
} from '@kontourai/station-contracts/project';
import { z } from 'zod/v3';
import { execGitContextCommand } from '../../utils/git-exec.js';

const PAGE_SIZE = 30;
const userSchema = z.object({
  id: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]),
  login: z.string().min(1).max(200).optional(),
  username: z.string().min(1).max(200).optional(),
});
const githubSchema = z
  .array(
    z.object({
      id: z.number().int().nonnegative(),
      full_name: z.string().min(1).max(500),
      html_url: z.string().url(),
      clone_url: z.string().url(),
      ssh_url: z.string().min(1),
      default_branch: z.string().max(256).nullable(),
      private: z.boolean(),
    }),
  )
  .max(PAGE_SIZE);
const gitlabSchema = z
  .array(
    z.object({
      id: z.number().int().nonnegative(),
      path_with_namespace: z.string().min(1).max(500),
      web_url: z.string().url(),
      http_url_to_repo: z.string().url(),
      ssh_url_to_repo: z.string().min(1),
      default_branch: z.string().max(256).nullable(),
      visibility: z.enum(['private', 'internal', 'public']),
    }),
  )
  .max(PAGE_SIZE);

export class RepositoryProviderUnavailable extends Error {
  constructor(readonly provider: RepositoryProvider) {
    super('Repository provider is unavailable or needs host sign-in.');
  }
}
type Transport = (
  command: 'gh' | 'glab',
  args: string[],
) => Promise<{ stdout: string }>;
const hostTransport: Transport = (command, args) =>
  execGitContextCommand(command, args, {
    timeout: 7000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });

function checkedRepository(
  provider: RepositoryProvider,
  repository: RepositoryProviderSelection,
): RepositoryProviderSelection {
  const host = provider === 'github' ? 'github.com' : 'gitlab.com';
  const expected = `${host}/${repository.fullName.toLowerCase()}`;
  const web = new URL(repository.webUrl);
  const https = new URL(repository.httpsCloneUrl);
  const hasControls = [
    repository.webUrl,
    repository.httpsCloneUrl,
    repository.sshCloneUrl,
  ].some((value) =>
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ),
  );
  if (
    hasControls ||
    web.protocol !== 'https:' ||
    https.protocol !== 'https:' ||
    web.hostname !== host ||
    https.hostname !== host ||
    web.username ||
    web.password ||
    web.search ||
    web.hash ||
    https.username ||
    https.password ||
    https.search ||
    https.hash ||
    web.port ||
    https.port ||
    !repository.sshCloneUrl.startsWith(`git@${host}:`) ||
    repository.sshCloneUrl.includes('\n') ||
    normalizeGitOrigin(repository.httpsCloneUrl) !== expected ||
    normalizeGitOrigin(repository.sshCloneUrl) !== expected ||
    normalizeGitOrigin(repository.webUrl) !== expected
  )
    throw new Error(
      'Provider repository transport does not match its identity.',
    );
  return repository;
}

/** Uses the same neutral, hardened CLI ownership as the forge PR adapters. No token is read or retained. */
export class RepositoryProviderCatalog {
  constructor(private readonly transport: Transport = hostTransport) {}
  async list(
    provider: RepositoryProvider,
    page: number,
    assertCurrent: () => void,
  ): Promise<RepositoryProviderPage> {
    const host = provider === 'github' ? 'github.com' : 'gitlab.com';
    const command = provider === 'github' ? 'gh' : 'glab';
    z.number().int().min(1).max(1000).parse(page);
    const call = async (endpoint: string) => {
      assertCurrent();
      const result = await this.transport(command, [
        'api',
        endpoint,
        '--hostname',
        host,
      ]);
      assertCurrent();
      if (Buffer.byteLength(result.stdout) > 512 * 1024)
        throw new Error('Provider page exceeds its bound.');
      return JSON.parse(result.stdout);
    };
    try {
      const before = userSchema.parse(await call('user'));
      const raw = await call(
        provider === 'github'
          ? `user/repos?per_page=${PAGE_SIZE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`
          : `projects?membership=true&per_page=${PAGE_SIZE}&page=${page}&order_by=last_activity_at&sort=desc`,
      );
      const repositories: RepositoryProviderSelection[] =
        provider === 'github'
          ? githubSchema.parse(raw).map((repo) => ({
              id: String(repo.id),
              fullName: repo.full_name,
              webUrl: repo.html_url,
              httpsCloneUrl: repo.clone_url,
              sshCloneUrl: repo.ssh_url,
              ...(repo.default_branch
                ? { defaultBranch: repo.default_branch }
                : {}),
              visibility: repo.private ? 'private' : 'public',
            }))
          : gitlabSchema.parse(raw).map((repo) => ({
              id: String(repo.id),
              fullName: repo.path_with_namespace,
              webUrl: repo.web_url,
              httpsCloneUrl: repo.http_url_to_repo,
              sshCloneUrl: repo.ssh_url_to_repo,
              ...(repo.default_branch
                ? { defaultBranch: repo.default_branch }
                : {}),
              visibility: repo.visibility,
            }));
      for (const repository of repositories)
        checkedRepository(provider, repository);
      const after = userSchema.parse(await call('user'));
      const login = after.login ?? after.username;
      if (!login || String(before.id) !== String(after.id))
        throw new Error(
          'Host provider account changed during repository discovery.',
        );
      assertCurrent();
      return {
        provider,
        account: { id: String(after.id), login },
        repositories,
        page,
        hasMore: repositories.length === PAGE_SIZE,
        observedAt: new Date().toISOString(),
      };
    } catch {
      throw new RepositoryProviderUnavailable(provider);
    }
  }
}
