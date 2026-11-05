import {
  useFeaturePreviewsQuery,
  useIntegrationStatusQuery,
} from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import { Button } from '../../components/Button';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { errorText } from '../../utils/errorText';

export function ProjectRepositoryAccess({
  authority,
  stationName,
  github,
}: {
  authority: ApiRequestScope;
  stationName: string;
  github: boolean;
}) {
  const previews = useFeaturePreviewsQuery(authority.apiBase, {
    enabled: github,
    keepPreviousData: false,
  });
  const preview = previews.data?.find(
    (item) => item.id === 'repository-auth-details',
  );
  const metadataEnabled = !previews.isError && preview?.enabled === true;
  const status = useIntegrationStatusQuery(authority.apiBase, {
    requestScope: authority,
    includeGithubAuthentication: metadataEnabled,
    enabled: github && !previews.isPending && !previews.isError,
  });
  const previewOff =
    status.error instanceof StationHttpError &&
    status.error.code === 'feature_preview_disabled';
  const authentication =
    metadataEnabled && !status.isError
      ? status.data?.connections.find(
          (connection) => connection.provider === 'github',
        )?.authentication
      : undefined;
  const read = status.data?.connections
    .find((connection) => connection.provider === 'github')
    ?.actions.find(
      (action) =>
        action.action === 'read' &&
        action.computedBy === 'github.gh-auth-status',
    );
  const signIn =
    authentication?.state ??
    (!status.isError && read?.state === 'unverified'
      ? 'signed-in'
      : !status.isError && read?.state === 'failed'
        ? 'failed'
        : 'unknown');
  return (
    <section
      className="project-repositories__access"
      aria-label={`Source and Station access on ${stationName}`}
    >
      <div className="project-repositories__heading">
        <h4>Source and Station access</h4>
        {github && (
          <Button
            variant="secondary"
            disabled={
              status.isFetching || previews.isPending || previews.isError
            }
            onClick={() => void status.refetch()}
          >
            Check sign-in
          </Button>
        )}
      </div>
      <p>Git may use a different SSH key or credential helper.</p>
      {github &&
      (previews.isPending || status.isPending) &&
      !previews.isError ? (
        <SkeletonBlock
          count={1}
          label={`Checking GitHub sign-in on ${stationName}`}
        />
      ) : null}
      {github && (previewOff || (preview && !metadataEnabled)) && (
        <p className="project-sources__hint">
          Enable Repository sign-in details in Settings → Advanced → Feature
          previews.
        </p>
      )}
      {github && previews.isError && (
        <ErrorState
          variant="compact"
          title="Sign-in settings unavailable"
          description={errorText(previews.error)}
          action={
            <Button onClick={() => void previews.refetch()}>
              Retry sign-in settings
            </Button>
          }
        />
      )}
      {github && status.isError && !previewOff ? (
        <ErrorState
          variant="compact"
          title="GitHub sign-in details unavailable"
          description={
            status.error instanceof StationHttpError &&
            status.error.status === 403
              ? 'Only this Station’s operator can view its sign-in details.'
              : errorText(status.error)
          }
          action={
            <Button onClick={() => void status.refetch()}>
              Retry sign-in check
            </Button>
          }
        />
      ) : null}
      <dl className="project-repositories__details">
        <dt>Credential location</dt>
        <dd>{stationName}</dd>
        {github ? (
          <>
            <dt>GitHub CLI sign-in</dt>
            <dd>
              {signIn === 'signed-in'
                ? 'Signed in'
                : signIn === 'failed'
                  ? 'Needs attention'
                  : 'Not confirmed'}
            </dd>
            <dt>Account</dt>
            <dd>{authentication?.account ?? 'Not reported'}</dd>
            <dt>Reported token scopes</dt>
            <dd>
              {authentication?.scopes === undefined
                ? 'Not reported'
                : authentication.scopes.length
                  ? authentication.scopes.join(', ')
                  : 'None reported'}
            </dd>
            {authentication && (
              <>
                <dt>Checked</dt>
                <dd>{new Date(authentication.observedAt).toLocaleString()}</dd>
              </>
            )}
          </>
        ) : (
          <>
            <dt>Provider sign-in</dt>
            <dd>Not reported by this Station</dd>
          </>
        )}
        <dt>Repository permissions</dt>
        <dd>Not checked by this sign-in check</dd>
        <dt>Project or repository sign-in</dt>
        <dd>Not available in this view</dd>
      </dl>
      {github && (
        <details className="project-sources__diagnostics">
          <summary>Sign-in help for {stationName}</summary>
          <p>Run on {stationName}:</p>
          <code>gh auth status --hostname github.com</code>
          <p>To sign in or replace the account, run:</p>
          <code>gh auth login --hostname github.com</code>
          <p>This view cannot start sign-in on another machine.</p>
        </details>
      )}
    </section>
  );
}
