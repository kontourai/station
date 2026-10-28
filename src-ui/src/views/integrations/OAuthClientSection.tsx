import type { IntegrationViewModel } from '@kontourai/station-sdk';
import {
  useBindOAuthClientSecretMutation,
  useIntegrationSecretBindingQuery,
  useRefreshSecretBindingState,
  useSecretBindingsQuery,
  useUnbindOAuthClientSecretMutation,
} from '@kontourai/station-sdk/secret-bindings-query';
import { Badge } from '@kontourai/ui/react';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { userFacingErrorMessage } from '../../utils/errorText';

type OAuthClient = NonNullable<IntegrationViewModel['oauthClient']>;

/**
 * "Use your own OAuth client" for a remote integration: a pre-registered
 * client ID, its secret through a secret binding, default scopes, and an optional
 * Client ID Metadata Document URL. Opens by itself when one is configured or
 * the server needs one.
 */
export function OAuthClientSection({
  editForm,
  isNew,
  locked,
  requireSave,
  onUpdate,
}: {
  editForm: IntegrationViewModel;
  isNew: boolean;
  locked: boolean;
  requireSave: boolean;
  onUpdate: (
    updater: (form: IntegrationViewModel) => IntegrationViewModel,
  ) => void;
}) {
  const clientRequired =
    editForm.probe?.authorization?.state === 'client-id-required';
  const [expanded, setExpanded] = useState(
    clientRequired || Boolean(editForm.oauthClient),
  );
  const ids = {
    region: useId(),
    clientId: useId(),
    scopes: useId(),
    url: useId(),
  };
  const client = editForm.oauthClient ?? {};
  const update = (patch: Partial<OAuthClient>) =>
    onUpdate((form) => {
      const next: OAuthClient = { ...(form.oauthClient ?? {}), ...patch };
      for (const key of Object.keys(next) as (keyof OAuthClient)[])
        if (next[key] === undefined) delete next[key];
      const { oauthClient: _previous, ...rest } = form;
      return Object.keys(next).length > 0
        ? { ...rest, oauthClient: next }
        : rest;
    });

  return (
    <section className="agent-editor__section" aria-label="OAuth client">
      <div className="agent-editor__section-header">
        <DisclosureToggle
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
          controls={ids.region}
        >
          Use your own OAuth client
        </DisclosureToggle>
        {clientRequired && <Badge value="Client ID required" tone="caution" />}
      </div>
      {expanded && (
        <div id={ids.region}>
          <p className="agent-editor__section-desc">
            For servers that do not register clients automatically, such as
            Gmail.
          </p>
          <div className="editor-field">
            <label className="editor-label" htmlFor={ids.clientId}>
              Client ID
            </label>
            <input
              id={ids.clientId}
              className="editor-input"
              autoComplete="off"
              spellCheck={false}
              value={client.clientId ?? ''}
              disabled={locked}
              onChange={(event) =>
                update({ clientId: event.target.value.trim() || undefined })
              }
            />
          </div>
          <OAuthClientSecretBinding
            integrationId={editForm.id}
            unavailable={isNew || requireSave}
          />
          <div className="editor-field">
            <label className="editor-label" htmlFor={ids.scopes}>
              Default scopes
            </label>
            <input
              id={ids.scopes}
              className="editor-input"
              autoComplete="off"
              spellCheck={false}
              placeholder="Server default"
              value={client.scopes?.join(' ') ?? ''}
              disabled={locked}
              onChange={(event) => {
                const scopes = event.target.value.split(/\s+/).filter(Boolean);
                update({ scopes: scopes.length > 0 ? scopes : undefined });
              }}
            />
            <p className="editor-field-hint">
              Prefilled at sign-in; each person can change them.
            </p>
          </div>
          <div className="editor-field">
            <label className="editor-label" htmlFor={ids.url}>
              Client metadata URL
            </label>
            <input
              id={ids.url}
              className="editor-input"
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://"
              value={client.clientMetadataUrl ?? ''}
              disabled={locked}
              onChange={(event) =>
                update({
                  clientMetadataUrl: event.target.value.trim() || undefined,
                })
              }
            />
            <p className="editor-field-hint">
              Used only when there is no client ID and the server accepts it.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

/** The secret lives in a secret binding; this control never sees its value. */
function OAuthClientSecretBinding({
  integrationId,
  unavailable,
}: {
  integrationId: string;
  unavailable: boolean;
}) {
  const selectId = useId();
  const bindings = useSecretBindingsQuery({
    retry: false,
    enabled: !unavailable,
  });
  const configured = useIntegrationSecretBindingQuery(integrationId, {
    retry: false,
    enabled: !unavailable,
  });
  const bind = useBindOAuthClientSecretMutation();
  const unbind = useUnbindOAuthClientSecretMutation();
  const refresh = useRefreshSecretBindingState(integrationId);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const boundId = configured.data?.oauthClientSecretBindingId;
  const bound = bindings.data?.find((binding) => binding.id === boundId);
  const selected = bindings.data?.find((binding) => binding.id === selectedId);
  const pending = bind.isPending || unbind.isPending;

  const run = async (operation: 'bind' | 'unbind') => {
    const target = operation === 'bind' ? selected : bound;
    if (!target) return;
    setError(null);
    try {
      const input = {
        id: target.id,
        integrationId,
        expectedRevision: target.revision,
      };
      const result =
        operation === 'bind'
          ? await bind.mutateAsync(input)
          : await unbind.mutateAsync(input);
      await refresh();
      if (result.outcome === 'safe-partial')
        setError(result.configurationError ?? 'Retry to finish this change.');
      setSelectedId('');
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
    }
  };

  return (
    <div className="editor-field">
      <label className="editor-label" htmlFor={selectId}>
        Client secret
      </label>
      {unavailable ? (
        <p className="editor-field-hint">
          Save the integration to choose a secret binding.
        </p>
      ) : bindings.isLoading || configured.isLoading ? (
        <SkeletonBlock count={1} label="Loading secret bindings" />
      ) : bindings.isError || configured.isError ? (
        <ErrorState
          variant="compact"
          title="Could not load secret bindings"
          description={userFacingErrorMessage(
            bindings.error ?? configured.error,
          )}
          action={
            <Button
              size="sm"
              onClick={() => {
                void bindings.refetch();
                void configured.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : boundId ? (
        <div className="editor-kv-row">
          <Badge value={bound?.name ?? boundId} tone="positive" />
          <Button
            variant="secondary"
            pending={unbind.isPending}
            pendingLabel="Removing…"
            disabled={pending || !bound}
            onClick={() => void run('unbind')}
          >
            Remove
          </Button>
        </div>
      ) : (
        <div className="editor-kv-row">
          <select
            id={selectId}
            className="editor-select"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            <option value="">None (public client)</option>
            {(bindings.data ?? [])
              .filter(
                (binding) =>
                  !binding.revokedAt &&
                  (!binding.owner || binding.owner.kind === 'instance'),
              )
              .map((binding) => (
                <option key={binding.id} value={binding.id}>
                  {binding.name} ({binding.availability.backend})
                </option>
              ))}
          </select>
          <Button
            pending={bind.isPending}
            pendingLabel="Binding…"
            disabled={!selected || pending}
            onClick={() => void run('bind')}
          >
            Bind
          </Button>
        </div>
      )}
      {error && (
        <ErrorState
          variant="compact"
          title="Secret binding change failed"
          description={error}
        />
      )}
    </div>
  );
}
