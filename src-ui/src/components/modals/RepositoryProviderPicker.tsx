import type {
  RepositoryProvider,
  RepositoryProviderPage,
} from '@kontourai/station-contracts/project';
import { getJson, readEnvelopeOrThrow } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { userFacingErrorMessage } from '../../utils/errorText';
import { Button } from '../Button';

export function RepositoryProviderPicker({
  scope,
  onChoose,
}: {
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  onChoose: (url: string, branch: string | undefined) => void;
}) {
  const [provider, setProvider] = useState<RepositoryProvider>();
  const [page, setPage] = useState(1);
  const [protocol, setProtocol] = useState<'https' | 'ssh'>('https');
  const protocolId = useId();
  const catalog = useQuery({
    queryKey: [
      'repository-provider',
      scope.apiBase,
      scope.authorityKey,
      provider,
      page,
    ],
    enabled: Boolean(provider),
    retry: false,
    staleTime: 0,
    queryFn: async () => {
      if (!provider || !scope.isCurrent())
        throw new Error('Station access changed. Choose the repository again.');
      const response = await getJson(
        `${scope.apiBase}/api/projects/repository-providers/${provider}?page=${page}`,
        { requestScope: scope },
      );
      const data = await readEnvelopeOrThrow<RepositoryProviderPage>(response);
      if (!data || !scope.isCurrent())
        throw new Error('Repository account could not be confirmed.');
      return data;
    },
  });
  return (
    <section aria-label="Choose a hosted repository">
      <div className="project-sources__actions">
        <Button
          type="button"
          onClick={() => {
            setProvider('github');
            setPage(1);
          }}
        >
          Choose from GitHub
        </Button>
        <Button
          type="button"
          onClick={() => {
            setProvider('gitlab');
            setPage(1);
          }}
        >
          Choose from GitLab
        </Button>
      </div>
      {provider && (
        <>
          <p>
            Uses the {provider === 'github' ? 'GitHub gh' : 'GitLab glab'}{' '}
            account signed in on this Station. Clone access is checked
            separately using the host's Git credentials.
          </p>
          {catalog.isFetching ? (
            <p role="status">Reading accessible repositories…</p>
          ) : catalog.isError ? (
            <p role="alert">{userFacingErrorMessage(catalog.error)}</p>
          ) : catalog.data ? (
            <>
              <p>
                Signed in as {catalog.data.account.login}. Page{' '}
                {catalog.data.page}, observed {catalog.data.observedAt}.
              </p>
              <label htmlFor={protocolId}>Clone protocol</label>
              <select
                id={protocolId}
                className="editor-input"
                value={protocol}
                onChange={(event) =>
                  setProtocol(event.target.value === 'ssh' ? 'ssh' : 'https')
                }
              >
                <option value="https">HTTPS</option>
                <option value="ssh">SSH</option>
              </select>
              <ul>
                {catalog.data.repositories.map((repository) => (
                  <li key={repository.id}>
                    <strong>{repository.fullName}</strong> ·{' '}
                    {repository.visibility}
                    {repository.defaultBranch
                      ? ` · ${repository.defaultBranch}`
                      : ''}
                    <Button
                      type="button"
                      onClick={() => {
                        if (
                          catalog.isError ||
                          catalog.isFetching ||
                          !scope.isCurrent()
                        )
                          return;
                        onChoose(
                          protocol === 'ssh'
                            ? repository.sshCloneUrl
                            : repository.httpsCloneUrl,
                          repository.defaultBranch,
                        );
                      }}
                    >
                      Use {repository.fullName}
                    </Button>
                  </li>
                ))}
              </ul>
              {!catalog.data.repositories.length && (
                <p>
                  No repositories on this page. Paste a Git URL if the
                  repository is outside this account listing.
                </p>
              )}
              {catalog.data.hasMore && (
                <Button
                  type="button"
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next repositories
                </Button>
              )}
              {page > 1 && (
                <Button
                  type="button"
                  onClick={() => setPage((current) => current - 1)}
                >
                  Previous repositories
                </Button>
              )}
            </>
          ) : null}
          <Button
            type="button"
            disabled={catalog.isFetching}
            onClick={() => void catalog.refetch()}
          >
            Refresh repositories
          </Button>
        </>
      )}
    </section>
  );
}
