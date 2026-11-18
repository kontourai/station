import type { RepositoryProvider } from '@kontourai/station-contracts/project';
import {
  type ApiRequestScope,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import { useActiveStationName } from '../../hooks/useActiveStationName';
import { openExternalLink } from '../../platform/openExternalLink';
import { Button } from '../Button';
import { TerminalCommandAction } from '../TerminalCommandAction';

const setup = {
  github: {
    name: 'GitHub',
    install: 'https://cli.github.com/',
  },
  gitlab: {
    name: 'GitLab',
    install: 'https://docs.gitlab.com/cli/',
  },
} as const;

export function RepositoryProviderRecovery({
  provider,
  authority,
  error,
  onRetry,
}: {
  provider: RepositoryProvider;
  authority: ApiRequestScope;
  error: unknown;
  onRetry: () => void;
}) {
  const stationName = useActiveStationName() ?? 'the connected Station';
  const providerSetup = setup[provider];
  const code = error instanceof StationHttpError ? error.code : undefined;
  if (error instanceof StationHttpError && error.status === 403)
    return (
      <p role="alert">Ask this Station’s operator to add the repository.</p>
    );
  return (
    <div className="content-stack">
      {code === 'repository_cli_missing' ? (
        <>
          <p role="alert">
            {providerSetup.name} CLI is missing on {stationName}.
          </p>
          <Button
            variant="secondary"
            onClick={() => void openExternalLink(providerSetup.install)}
          >
            Set up {providerSetup.name} CLI
          </Button>
        </>
      ) : (
        <>
          <p role="alert">
            {code === 'repository_sign_in_required'
              ? `Sign in to ${providerSetup.name} on ${stationName}, then retry.`
              : 'Could not list repositories. Retry or use Git URL.'}
          </p>
          {code === 'repository_sign_in_required' && (
            <TerminalCommandAction
              provider={provider}
              authority={authority}
              stationName={stationName}
            />
          )}
        </>
      )}
      <Button variant="secondary" onClick={onRetry}>
        Retry repositories
      </Button>
    </div>
  );
}
