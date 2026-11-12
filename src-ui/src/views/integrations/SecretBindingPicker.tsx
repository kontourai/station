import type { SecretBindingConsumerOutcome } from '@kontourai/station-sdk/secret-bindings';
import {
  useBindSecretBindingMutation,
  useIntegrationSecretBindingQuery,
  useRefreshSecretBindingState,
  useSecretBindingsQuery,
  useUnbindSecretBindingMutation,
} from '@kontourai/station-sdk/secret-bindings-query';
import { useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { SkeletonBlock } from '../../components/state';
import { userFacingErrorMessage } from '../../utils/errorText';

type Operation = 'bind' | 'unbind';
type Retry = {
  operation: Operation;
  bindingId: string;
  envName: string;
  expectedRevision: number;
};

/** Structured writer: the raw MCP JSON editor never receives binding ids. */
export function SecretBindingPicker({
  integrationId,
  envNames,
  requireSave,
}: {
  integrationId: string;
  envNames: string[];
  requireSave: boolean;
}) {
  const {
    data: bindings = [],
    error: bindingsError,
    isLoading: bindingsLoading,
    refetch: refetchBindings,
  } = useSecretBindingsQuery({ retry: false });
  const {
    data: integrationBindings,
    error: integrationBindingsError,
    isLoading: integrationBindingsLoading,
    refetch: refetchIntegrationBindings,
  } = useIntegrationSecretBindingQuery(integrationId, { retry: false });
  const [envName, setEnvName] = useState(envNames[0] ?? '');
  const [selectedBindingId, setSelectedBindingId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<Retry | null>(null);
  const bind = useBindSecretBindingMutation();
  const unbind = useUnbindSecretBindingMutation();
  const invalidateBindingState = useRefreshSecretBindingState(integrationId);
  const configuredBindingIds = integrationBindings?.secretEnvBindingIds ?? {};
  const configuredBindingId = configuredBindingIds[envName];
  const bindingId = selectedBindingId || configuredBindingId || '';
  const selected = useMemo(
    () => bindings.find((binding) => binding.id === bindingId),
    [bindingId, bindings],
  );
  const bound = Boolean(selected && configuredBindingId === selected.id);
  const pending = bind.isPending || unbind.isPending;
  const loading = bindingsLoading || integrationBindingsLoading;
  const error = bindingsError ?? integrationBindingsError;
  const retryQueries = async () => {
    await Promise.all([refetchBindings(), refetchIntegrationBindings()]);
  };
  const refreshAuthoritativeState = async () => {
    await invalidateBindingState();
    await retryQueries();
  };
  const run = async ({
    operation,
    bindingId: nextBindingId,
    envName: nextEnvName,
    expectedRevision,
  }: Retry) => {
    setMessage(null);
    setRetry(null);
    try {
      const input = {
        id: nextBindingId,
        integrationId,
        envName: nextEnvName,
        expectedRevision,
      };
      const result: SecretBindingConsumerOutcome =
        operation === 'bind'
          ? await bind.mutateAsync(input)
          : await unbind.mutateAsync(input);
      // A safe partial still changes the binding authority. Always reload both
      // it and the integration's exact config projection before describing the
      // outcome, rather than keeping an action label inferred from grants.
      await refreshAuthoritativeState();
      if (result.outcome === 'safe-partial') {
        setMessage(
          result.configurationError ??
            (operation === 'bind'
              ? "The secret was linked, but the tool server wasn't updated. Retry to finish."
              : "The secret was unlinked, but the tool server wasn't updated. Retry to finish."),
        );
        setRetry({
          operation,
          bindingId: result.binding.id,
          envName: result.envName,
          expectedRevision: result.binding.revision,
        });
        return;
      }
      setMessage(
        operation === 'bind'
          ? `Linked ${result.envName} to ${result.binding.name}.`
          : `Unlinked ${result.envName} from ${result.binding.name}.`,
      );
      setSelectedBindingId('');
    } catch (error) {
      setMessage(
        error instanceof Error
          ? userFacingErrorMessage(error)
          : `Couldn’t ${linkVerb(operation)} this secret.`,
      );
      setRetry({
        operation,
        bindingId: nextBindingId,
        envName: nextEnvName,
        expectedRevision,
      });
    }
  };

  if (envNames.length === 0) return null;
  return (
    <section
      className="agent-editor__section"
      aria-label="Link a secret to an environment variable"
    >
      <div className="agent-editor__section-header">
        <h3 className="agent-editor__section-title">Linked secret</h3>
        <p className="agent-editor__section-desc">
          Choose an environment variable and the secret that supplies it. Secret
          values are never shown.
        </p>
      </div>
      {requireSave ? (
        <p role="status">
          Save or discard unsaved integration edits before changing a linked
          secret.
        </p>
      ) : loading ? (
        <SkeletonBlock count={1} label="Loading linked secrets" />
      ) : error ? (
        <div role="alert">
          <p>
            Linked secrets couldn’t be loaded: {userFacingErrorMessage(error)}
          </p>
          <Button size="sm" onClick={() => void retryQueries()}>
            Retry loading
          </Button>
        </div>
      ) : (
        <div className="integration-binding-picker">
          <label>
            Environment{' '}
            <select
              value={envName}
              onChange={(event) => {
                setEnvName(event.target.value);
                setSelectedBindingId('');
                setMessage(null);
                setRetry(null);
              }}
            >
              {envNames.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label>
            Secret{' '}
            <select
              value={bindingId}
              onChange={(event) => setSelectedBindingId(event.target.value)}
            >
              <option value="">Choose a secret</option>
              {bindings
                .filter((binding) => !binding.revokedAt)
                .map((binding) => (
                  <option key={binding.id} value={binding.id}>
                    {binding.name} ({binding.availability.backend})
                  </option>
                ))}
            </select>
          </label>
          {configuredBindingId ? (
            <p role="status">
              Linked secret: {selected?.name ?? configuredBindingId}
            </p>
          ) : (
            <p role="status">No secret is linked to {envName}.</p>
          )}
          {configuredBindingId && selected && !bound && (
            <p role="alert">
              Unlink the current secret before choosing a different one.
            </p>
          )}
          <Button
            variant="primary"
            pending={pending}
            pendingLabel={bound ? 'Unlinking…' : 'Linking…'}
            disabled={
              !selected || pending || (Boolean(configuredBindingId) && !bound)
            }
            onClick={() => {
              if (!selected) return;
              void run({
                operation: bound ? 'unbind' : 'bind',
                bindingId: selected.id,
                envName,
                expectedRevision: selected.revision,
              });
            }}
          >
            {bound ? 'Unlink' : 'Link'}
          </Button>
          {message && <p role="status">{message}</p>}
          {retry && (
            <button
              type="button"
              className="editor-btn"
              disabled={pending}
              onClick={() => void run(retry)}
            >
              Retry {linkVerb(retry.operation)}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** The operation names stay the SDK's; the person reads link wording. */
function linkVerb(operation: 'bind' | 'unbind'): 'link' | 'unlink' {
  return operation === 'bind' ? 'link' : 'unlink';
}
