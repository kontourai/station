import type { ProjectS3Source } from '@kontourai/station-contracts/project';
import {
  useAttachProjectS3SourceMutation,
  useDisconnectProjectS3SourceMutation,
  useProjectS3CapabilitiesQuery,
  useProjectS3ObjectQuery,
  useProjectS3ObjectsQuery,
  useProjectS3ProfilesQuery,
  useProjectS3SourcesQuery,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageSection } from '../../components/PageSection';
import { SkeletonBlock } from '../../components/state';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { userFacingErrorMessage } from '../../utils/errorText';

export function ProjectS3Sources({
  slug,
  projectId,
  authority,
}: {
  slug: string;
  projectId: string;
  authority: ApiRequestScope;
}) {
  const capabilities = useProjectS3CapabilitiesQuery(authority);
  if (capabilities.data?.enabled !== true) return null;
  return (
    <ProjectS3SourceControls
      slug={slug}
      projectId={projectId}
      authority={authority}
      canManage={
        !capabilities.isError &&
        !capabilities.isFetching &&
        capabilities.data.canManage
      }
      canRead={!capabilities.isError && !capabilities.isFetching}
    />
  );
}

function ProjectS3SourceControls({
  slug,
  projectId,
  authority,
  canManage,
  canRead,
}: {
  slug: string;
  projectId: string;
  authority: ApiRequestScope;
  canManage: boolean;
  canRead: boolean;
}) {
  const sources = useProjectS3SourcesQuery(authority, slug, projectId, canRead);
  const profiles = useProjectS3ProfilesQuery(authority, canManage);
  const attach = useAttachProjectS3SourceMutation(authority, slug);
  const disconnect = useDisconnectProjectS3SourceMutation(authority, slug);
  const [sourceId, setSourceId] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [object, setObject] = useState<{ key: string; etag: string }>();
  const [selected, setSelected] = useState<ProjectS3Source>();
  const [requestId, setRequestId] = useState(() => randomCorrelationId());
  const [form, setForm] = useState({
    displayName: '',
    profile: '',
    accountId: '',
    region: '',
    bucket: '',
    prefix: '',
  });
  const [share, setShare] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const currentSource =
    canRead && !sources.isError && !sources.isFetching
      ? sources.data?.find((source) => source.id === sourceId)
      : undefined;
  const objects = useProjectS3ObjectsQuery(
    authority,
    slug,
    sourceId,
    cursor,
    Boolean(currentSource),
  );
  const content = useProjectS3ObjectQuery(
    authority,
    slug,
    sourceId,
    object,
    Boolean(currentSource),
  );
  const busy = attach.isPending || disconnect.isPending;
  const { DiscardModal } = useUnsavedGuard(
    Object.values(form).some(Boolean) && !uncertain,
  );
  const change = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setShare(false);
  };
  async function add() {
    if (
      !canManage ||
      busy ||
      !share ||
      uncertain ||
      profiles.isError ||
      profiles.isFetching ||
      !profiles.data?.profiles.includes(form.profile)
    )
      return;
    setError(undefined);
    try {
      await attach.mutateAsync({
        ...form,
        id: requestId,
        expectedProjectId: projectId,
        shareWithProject: true,
      });
      setForm({
        displayName: '',
        profile: '',
        accountId: '',
        region: '',
        bucket: '',
        prefix: '',
      });
      setShare(false);
      setRequestId(randomCorrelationId());
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
      setUncertain(true);
    }
  }
  async function refresh() {
    if (!canRead || busy || sources.isFetching) return;
    const result = await sources.refetch();
    if (!result.isError) {
      setUncertain(false);
      if (result.data?.some((source) => source.id === requestId)) {
        setForm({
          displayName: '',
          profile: '',
          accountId: '',
          region: '',
          bucket: '',
          prefix: '',
        });
        setShare(false);
        setRequestId(randomCorrelationId());
      }
      setError(undefined);
    }
  }
  return (
    <PageSection
      title="S3 prefixes (experimental)"
      description="Read selected text objects without mounting, importing or indexing the bucket. This feature still needs real AWS acceptance verification."
    >
      <div className="project-sources__form">
        {!canRead ? (
          <p>
            Source permissions are refreshing or unavailable. Refresh the
            connection before reading.
          </p>
        ) : sources.isError ? (
          <p role="alert">{userFacingErrorMessage(sources.error)}</p>
        ) : sources.isPending ? (
          <SkeletonBlock count={1} label="Loading S3 sources" />
        ) : (
          <ul className="project-sources__list">
            {sources.data?.map((source) => (
              <li key={source.id}>
                <div>
                  <strong>{source.displayName}</strong>
                  <p>
                    <code>
                      s3://{source.bucket}/{source.prefix}
                    </code>
                  </p>
                  <p>
                    Bucket owner {source.accountId} · {source.region}
                  </p>
                  <p>Read only. Access is checked when listing or reading.</p>
                </div>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setSourceId(source.id);
                    setCursor(undefined);
                    setObject(undefined);
                  }}
                >
                  Browse prefix
                </Button>
                {canManage && (
                  <Button disabled={busy} onClick={() => setSelected(source)}>
                    Disconnect S3 source
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <Button
          disabled={!canRead || sources.isFetching || busy}
          onClick={() => void refresh()}
        >
          Refresh S3 sources
        </Button>
        {uncertain && (
          <p role="alert">
            Attachment could not be confirmed. Refresh sources before starting
            another selection; no attachment is resent automatically.
          </p>
        )}
        {currentSource && (
          <section aria-label="S3 object browser">
            <h3>{currentSource.displayName}</h3>
            {objects.isFetching ? (
              <p>Listing the selected prefix…</p>
            ) : objects.isError ? (
              <p role="alert">{userFacingErrorMessage(objects.error)}</p>
            ) : (
              <>
                <p>
                  One page, at most 50 objects. This is not a complete bucket
                  inventory.
                </p>
                <ul>
                  {objects.data?.objects.map((item) => (
                    <li key={`${item.key}:${item.etag}`}>
                      <span>
                        {item.key} · {item.bytes} bytes
                      </span>
                      <Button
                        disabled={
                          !/\.(md|markdown|txt)$/i.test(item.key) ||
                          item.bytes <= 0 ||
                          item.bytes > 262144
                        }
                        onClick={() =>
                          setObject({ key: item.key, etag: item.etag })
                        }
                      >
                        Read {item.key}
                      </Button>
                    </li>
                  ))}
                </ul>
                {objects.data?.continuationToken && (
                  <Button
                    onClick={() => {
                      setCursor(objects.data!.continuationToken);
                      setObject(undefined);
                    }}
                  >
                    Next object page
                  </Button>
                )}
                <Button
                  onClick={() => {
                    setCursor(undefined);
                    setObject(undefined);
                    if (cursor === undefined) void objects.refetch();
                  }}
                >
                  Refresh first page
                </Button>
              </>
            )}
            {object &&
              (content.isFetching ? (
                <p>Reading the selected object…</p>
              ) : content.isError ? (
                <p role="alert">
                  {userFacingErrorMessage(content.error)} List the prefix again
                  before selecting a changed object.
                </p>
              ) : content.data ? (
                <>
                  <p>
                    Citation: <code>{content.data.citation}</code>
                  </p>
                  <p>
                    SHA-256: <code>{content.data.object.sha256}</code>
                  </p>
                  <pre
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {content.data.text}
                  </pre>
                  <p>
                    Live read at {content.data.observedAt}. No copy was
                    imported.
                  </p>
                </>
              ) : null)}
          </section>
        )}
        {canManage && (
          <>
            <h3>Attach a read-only prefix</h3>
            <p>
              The AWS profile stays on the Station host. Attachment stores your
              selection; it does not establish bucket access until a listing or
              read succeeds.
            </p>
            {profiles.isError && (
              <p role="alert">{userFacingErrorMessage(profiles.error)}</p>
            )}
            <label>
              AWS profile
              <select
                value={form.profile}
                disabled={
                  busy || uncertain || profiles.isFetching || profiles.isError
                }
                onChange={(event) => change('profile', event.target.value)}
              >
                <option value="">Choose a host AWS profile</option>
                {profiles.data?.profiles.map((profile) => (
                  <option key={profile} value={profile}>
                    {profile}
                  </option>
                ))}
              </select>
            </label>
            {(
              [
                'displayName',
                'accountId',
                'region',
                'bucket',
                'prefix',
              ] as const
            ).map((field) => (
              <label key={field}>
                {
                  {
                    displayName: 'Source name',
                    accountId: 'Expected bucket-owner account ID',
                    region: 'AWS region',
                    bucket: 'Bucket name',
                    prefix: 'Prefix (ending in /)',
                  }[field]
                }
                <input
                  value={form[field]}
                  disabled={busy || uncertain}
                  onChange={(event) => change(field, event.target.value)}
                />
              </label>
            ))}
            <label>
              <input
                type="checkbox"
                checked={share}
                disabled={busy || uncertain}
                onChange={(event) => setShare(event.target.checked)}
              />
              Let this Project’s members and Agents read this prefix using the
              selected host AWS profile.
            </label>
            <Button
              disabled={
                busy ||
                uncertain ||
                !share ||
                !Object.values(form).every((value) => value.trim()) ||
                profiles.isError ||
                profiles.isFetching
              }
              onClick={() => void add()}
            >
              Attach S3 prefix
            </Button>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <ConfirmModal
        isOpen={Boolean(selected)}
        title="Disconnect S3 source?"
        message="This removes active access to this prefix through the registration. Original S3 objects stay intact. Any copies previously imported or saved elsewhere remain there."
        confirmLabel="Disconnect"
        confirmDisabled={
          !canManage || busy || sources.isError || sources.isFetching
        }
        onCancel={() => setSelected(undefined)}
        onConfirm={() => {
          if (
            !canManage ||
            !selected ||
            busy ||
            sources.isError ||
            sources.isFetching
          )
            return;
          void disconnect
            .mutateAsync(selected)
            .then(() => {
              setSelected(undefined);
              setSourceId(undefined);
              setObject(undefined);
            })
            .catch((cause) => setError(userFacingErrorMessage(cause)));
        }}
      />
      <DiscardModal />
    </PageSection>
  );
}
