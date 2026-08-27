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
            'The binding authority changed, but the integration configuration did not. Retry to converge both sides.',
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
          ? `Bound ${result.envName} to ${result.binding.name}.`
          : `Unbound ${result.envName} from ${result.binding.name}.`,
      );
      setSelectedBindingId('');
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : `Could not ${operation} this secret environment.`,
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
      aria-label="Bind a secret environment"
    >
      <div className="agent-editor__section-header">
        <h3 className="agent-editor__section-title">
          Secret environment binding
        </h3>
        <p className="agent-editor__section-desc">
          Choose an already-declared environment name and an operator binding.
          This action records both sides; it never reveals material.
        </p>
      </div>
      {requireSave ? (
        <p role="status">
          Save or discard unsaved integration edits before changing a secret
          binding.
        </p>
      ) : loading ? (
        <SkeletonBlock count={1} label="Loading binding configuration" />
      ) : error ? (
        <div role="alert">
          <p>Binding configuration could not be loaded: {error.message}</p>
          <Button size="sm" onClick={() => void retryQueries()}>
            Retry binding configuration
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
            Binding{' '}
            <select
              value={bindingId}
              onChange={(event) => setSelectedBindingId(event.target.value)}
            >
              <option value="">Choose binding</option>
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
              Configured binding: {selected?.name ?? configuredBindingId}
            </p>
          ) : (
            <p role="status">No binding is configured for {envName}.</p>
          )}
          {configuredBindingId && selected && !bound && (
            <p role="alert">
              Unbind the configured binding before selecting a different one.
            </p>
          )}
          <Button
            variant="primary"
            pending={pending}
            pendingLabel="Applying…"
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
            {bound ? 'Unbind' : 'Bind'}
          </Button>
          {message && <p role="status">{message}</p>}
          {retry && (
            <button
              type="button"
              className="editor-btn"
              disabled={pending}
              onClick={() => void run(retry)}
            >
              Retry {retry.operation}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
