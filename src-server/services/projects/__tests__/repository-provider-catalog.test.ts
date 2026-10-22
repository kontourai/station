import { expect, test, vi } from 'vitest';
import { RepositoryProviderCatalog } from '../repository-provider-catalog.js';

const github = {
  id: 7,
  full_name: 'team/private-repo',
  html_url: 'https://github.com/team/private-repo',
  clone_url: 'https://github.com/team/private-repo.git',
  ssh_url: 'git@github.com:team/private-repo.git',
  default_branch: 'trunk',
  private: true,
};
const gitlab = {
  id: 8,
  path_with_namespace: 'team/subgroup/private-repo',
  web_url: 'https://gitlab.com/team/subgroup/private-repo',
  http_url_to_repo: 'https://gitlab.com/team/subgroup/private-repo.git',
  ssh_url_to_repo: 'git@gitlab.com:team/subgroup/private-repo.git',
  default_branch: 'main',
  visibility: 'private',
};

test.each(['github', 'gitlab'] as const)(
  '%s uses real provider fields for private visibility, identity and explicit clone transports',
  async (provider) => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 42,
          login: 'operator',
          username: 'operator',
        }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([provider === 'github' ? github : gitlab]),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 42,
          login: 'operator',
          username: 'operator',
        }),
      });
    const result = await new RepositoryProviderCatalog(transport).list(
      provider,
      2,
      () => {},
    );
    expect(result.account).toEqual({ id: '42', login: 'operator' });
    expect(result.repositories[0]).toMatchObject({
      visibility: 'private',
      httpsCloneUrl:
        provider === 'github' ? github.clone_url : gitlab.http_url_to_repo,
      sshCloneUrl:
        provider === 'github' ? github.ssh_url : gitlab.ssh_url_to_repo,
    });
    expect(result.repositories[0]).not.toHaveProperty('token');
    expect(transport.mock.calls[1]![1][1]).toContain('page=2');
    expect(transport.mock.calls[1]![1][1]).toContain('per_page=30');
    expect(transport.mock.calls[1]![0]).toBe(
      provider === 'github' ? 'gh' : 'glab',
    );
    expect(transport.mock.calls[1]![1]).toContain(
      provider === 'github' ? 'github.com' : 'gitlab.com',
    );
  },
);

test('an account switch during provider listing withholds the repositories', async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce({ stdout: '{"id":42,"login":"alice"}' })
    .mockResolvedValueOnce({ stdout: JSON.stringify([github]) })
    .mockResolvedValueOnce({ stdout: '{"id":43,"login":"bob"}' });
  await expect(
    new RepositoryProviderCatalog(transport).list('github', 1, () => {}),
  ).rejects.toThrow('unavailable');
});

test('revocation during the first provider call stops further credential use', async () => {
  let allowed = true;
  const transport = vi.fn(async () => {
    allowed = false;
    return { stdout: '{"id":42,"login":"alice"}' };
  });
  await expect(
    new RepositoryProviderCatalog(transport).list('github', 1, () => {
      if (!allowed) throw new Error('Authority ended');
    }),
  ).rejects.toThrow('unavailable');
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each([
  { ...github, clone_url: 'https://token@github.com/team/private-repo.git' },
  { ...github, clone_url: 'https://other.invalid/team/private-repo.git' },
  { ...github, ssh_url: 'git@github.com:other/private-repo.git' },
  { ...github, ssh_url: 'https://github.com/team/private-repo.git' },
])(
  'mismatched or credential-bearing transports never reach selection',
  async (repository) => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '{"id":42,"login":"alice"}' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([repository]) })
      .mockResolvedValueOnce({ stdout: '{"id":42,"login":"alice"}' });
    await expect(
      new RepositoryProviderCatalog(transport).list('github', 1, () => {}),
    ).rejects.toThrow('unavailable');
  },
);

test('oversized provider pages and command diagnostics are not reflected to the browser', async () => {
  for (const output of [
    JSON.stringify([{ ...github, additionalMetadata: 'x'.repeat(512 * 1024) }]),
    JSON.stringify(Array.from({ length: 31 }, () => github)),
  ]) {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '{"id":42,"login":"alice"}' })
      .mockResolvedValueOnce({ stdout: output })
      .mockResolvedValueOnce({ stdout: '{"id":42,"login":"alice"}' });
    await expect(
      new RepositoryProviderCatalog(transport).list('github', 1, () => {}),
    ).rejects.toThrow(
      'Repository provider is unavailable or needs host sign-in.',
    );
  }
  const transport = vi
    .fn()
    .mockRejectedValue(
      new Error('private diagnostic with credential material'),
    );
  const error = await new RepositoryProviderCatalog(transport)
    .list('github', 1, () => {})
    .catch((error) => error);
  expect(String(error)).not.toContain('credential material');
});
