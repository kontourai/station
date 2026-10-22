import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import {
  useCreateKnowledgeRootMutation,
  useDeleteKnowledgeRootMutation,
  useKnowledgeAdaptersQuery,
  useKnowledgeRootsQuery,
  useValidateKnowledgeRootMutation,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageSection } from '../../components/PageSection';
import { userFacingErrorMessage } from '../../utils/errorText';

export function ProjectKnowledgeSources({
  slug,
  authority,
}: {
  slug: string;
  authority: ApiRequestScope;
}) {
  const roots = useKnowledgeRootsQuery({
    requestScope: authority,
    requireRequestScope: true,
  });
  const adapters = useKnowledgeAdaptersQuery({
    requestScope: authority,
    requireRequestScope: true,
  });
  const create = useCreateKnowledgeRootMutation(authority);
  const validate = useValidateKnowledgeRootMutation(authority);
  const disconnect = useDeleteKnowledgeRootMutation(authority);
  const [path, setPath] = useState('');
  const [adapterId, setAdapterId] = useState('kit-default-store');
  const [name, setName] = useState('');
  const [checked, setChecked] = useState<{ path: string; adapterId: string }>();
  const [selected, setSelected] = useState<KnowledgeStoreRoot>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const busy = create.isPending || disconnect.isPending || validate.isPending;
  const projectRoots =
    roots.data?.filter(
      (root) =>
        root.scope.kind === 'project' && root.scope.projectSlug === slug,
    ) ?? [];
  async function add(existing: boolean) {
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await create.mutateAsync({
        scope: { kind: 'project', projectSlug: slug },
        adapterId: existing ? adapterId : 'kit-default-store',
        ...(existing ? { storeRoot: path } : {}),
        ...(name.trim() ? { displayName: name.trim() } : {}),
      });
      setNotice(
        `Registered ${result.displayName}. Open Project knowledge to add or browse records.`,
      );
      setChecked(undefined);
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
    }
  }
  async function check() {
    setError(undefined);
    setChecked(undefined);
    const candidate = { path, adapterId };
    try {
      const result = await validate.mutateAsync({ adapterId, storeRoot: path });
      if (result.ok) setChecked(candidate);
      else setError(result.reason ?? 'This store could not be validated.');
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
    }
  }
  return (
    <PageSection
      title="Knowledge stores"
      description="Create a Station-managed store or connect a supported store on the Station host. Registration alone does not confirm indexing or Agent access."
    >
      {roots.isPending ? (
        <p>Loading sources…</p>
      ) : roots.isError ? (
        <div role="alert">
          <p>{userFacingErrorMessage(roots.error)}</p>
          <Button onClick={() => void roots.refetch()}>Retry sources</Button>
        </div>
      ) : (
        <>
          {projectRoots.length ? (
            <ul className="project-sources__list">
              {projectRoots.map((root) => (
                <li key={root.id}>
                  <div>
                    <strong>{root.displayName}</strong>
                    <p>{root.adapterId}</p>
                    <code>{root.storeRoot}</code>
                  </div>
                  <Button
                    disabled={busy || root.adapterId === 'conversation-store'}
                    onClick={() => {
                      setSelected(root);
                      disconnect.reset();
                    }}
                  >
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p>No knowledge stores registered for this project.</p>
          )}
          <Button
            disabled={busy || roots.isFetching}
            onClick={() => void roots.refetch()}
          >
            Refresh sources
          </Button>
          <div className="project-sources__form">
            <label>
              Source name (optional)
              <input
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {projectRoots.some(
              (root) => root.adapterId === 'kit-default-store',
            ) ? (
              <p>
                A default-format store is already connected. Use it from Project
                knowledge, or connect another store path below.
              </p>
            ) : (
              <Button
                disabled={busy || roots.isFetching}
                pending={create.isPending}
                onClick={() => void add(false)}
              >
                Create managed store
              </Button>
            )}
            <h3>Connect a store path</h3>
            {adapters.isError ? (
              <div role="alert">
                <p>{userFacingErrorMessage(adapters.error)}</p>
                <Button onClick={() => void adapters.refetch()}>
                  Retry store formats
                </Button>
              </div>
            ) : (
              <label>
                Store format
                <select
                  value={adapterId}
                  disabled={busy || adapters.isPending}
                  onChange={(event) => {
                    setAdapterId(event.target.value);
                    setChecked(undefined);
                  }}
                >
                  {adapters.data
                    ?.filter((adapter) => adapter.id !== 'conversation-store')
                    .map((adapter) => (
                      <option key={adapter.id} value={adapter.id}>
                        {adapter.displayName}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label>
              Path on the Station host
              <input
                value={path}
                disabled={busy}
                onChange={(event) => {
                  setPath(event.target.value);
                  setChecked(undefined);
                }}
              />
            </label>
            <div className="project-sources__actions">
              <Button
                disabled={
                  busy ||
                  !path.trim() ||
                  !adapters.data?.some((adapter) => adapter.id === adapterId)
                }
                pending={validate.isPending}
                onClick={() => void check()}
              >
                Check source
              </Button>
              <Button
                disabled={
                  busy ||
                  checked?.path !== path ||
                  checked?.adapterId !== adapterId
                }
                onClick={() => void add(true)}
              >
                Connect store
              </Button>
            </div>
            {checked?.path === path && checked?.adapterId === adapterId && (
              <p role="status">
                Source accepted for registration. This does not confirm that the
                path exists or that records can be read.
              </p>
            )}
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <ConfirmModal
        isOpen={Boolean(selected)}
        title="Disconnect knowledge source?"
        message={`Disconnect ${selected?.displayName ?? 'this source'} from Station's registry. Its files remain on the host.`}
        confirmLabel="Disconnect"
        pending={disconnect.isPending}
        error={
          disconnect.isError
            ? userFacingErrorMessage(disconnect.error)
            : undefined
        }
        onCancel={() => setSelected(undefined)}
        onConfirm={() => {
          if (!selected) return;
          void disconnect
            .mutateAsync({ rootId: selected.id, expectedRoot: selected })
            .then(() => setSelected(undefined))
            .catch(() => {});
        }}
      />
    </PageSection>
  );
}
