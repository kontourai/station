import type { TelemetryDestinationGrant } from '@kontourai/station-contracts/secret-binding';
import {
  useTelemetrySecretBindingGrantMutation,
  useTelemetrySecretBindingsQuery,
} from '@kontourai/station-sdk/secret-bindings-query';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { userFacingErrorMessage } from '../../utils/errorText';

export function TelemetryDestinationGrants() {
  const authority = useHostRequestAuthorityScope();
  return authority ? (
    <GrantsForAuthority
      key={`${authority.apiBase}:${authority.authorityKey}`}
      authority={authority}
    />
  ) : (
    <p role="status">Connect to this Station to manage telemetry key grants.</p>
  );
}

function GrantsForAuthority({
  authority,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const options = { requestScope: authority };
  const query = useTelemetrySecretBindingsQuery(authority.apiBase, options);
  const mutation = useTelemetrySecretBindingGrantMutation(
    authority.apiBase,
    options,
  );
  const prefix = useId();
  const [bindingId, setBindingId] = useState('');
  const [transport, setTransport] =
    useState<TelemetryDestinationGrant['transport']>('product');
  const [destination, setDestination] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const { DiscardModal } = useUnsavedGuard(
    Boolean(destination || transport !== 'product'),
  );
  const bindings =
    query.data?.filter(
      (binding) =>
        !binding.revokedAt &&
        (!binding.owner || binding.owner.kind === 'instance'),
    ) ?? [];
  const selected = bindings.find((binding) => binding.id === bindingId);
  const available = !query.isError && !query.isFetching && Boolean(query.data);

  const run = async (
    operation: 'bind' | 'unbind',
    grant: TelemetryDestinationGrant,
  ) => {
    if (!available || !selected || mutation.isPending) return;
    setMessage(null);
    try {
      await mutation.mutateAsync({
        id: selected.id,
        operation,
        expectedRevision: selected.revision,
        ...grant,
      });
      setMessage(
        operation === 'bind'
          ? 'Telemetry destination granted.'
          : 'Telemetry destination grant removed.',
      );
      setDestination('');
      setTransport('product');
    } catch (error) {
      setMessage(userFacingErrorMessage(error));
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run('bind', {
      kind: 'instance-telemetry-destination',
      transport,
      destination: destination.trim(),
    });
  };

  return (
    <section aria-labelledby={`${prefix}-heading`}>
      <h3 id={`${prefix}-heading`}>Telemetry destination grants</h3>
      <p className="agent-editor__section-desc">
        Allow an instance-owned key reference at one product receiver or
        collector address. Saving a telemetry address or choosing a reference
        does not grant this authority.
      </p>
      {query.isError ? (
        <p role="alert">
          Telemetry key references are unavailable.{' '}
          {userFacingErrorMessage(query.error)}
        </p>
      ) : query.isFetching ? (
        <p role="status">Refreshing telemetry key references…</p>
      ) : bindings.length === 0 ? (
        <p role="status">
          Create an instance-owned reference above before granting a telemetry
          destination.
        </p>
      ) : (
        <form onSubmit={submit}>
          <div className="editor-field">
            <label className="editor-label" htmlFor={`${prefix}-binding`}>
              Key reference
            </label>
            <select
              id={`${prefix}-binding`}
              className="editor-select"
              value={bindingId}
              disabled={mutation.isPending}
              onChange={(event) => setBindingId(event.target.value)}
            >
              <option value="">Choose a reference</option>
              {bindings.map((binding) => (
                <option key={binding.id} value={binding.id}>
                  {binding.name} ({binding.id})
                </option>
              ))}
            </select>
          </div>
          <div className="editor-field">
            <label className="editor-label" htmlFor={`${prefix}-transport`}>
              Destination type
            </label>
            <select
              id={`${prefix}-transport`}
              className="editor-select"
              value={transport}
              disabled={mutation.isPending}
              onChange={(event) =>
                setTransport(event.target.value === 'otel' ? 'otel' : 'product')
              }
            >
              <option value="product">Product receiver</option>
              <option value="otel">OTel collector</option>
            </select>
          </div>
          <div className="editor-field">
            <label className="editor-label" htmlFor={`${prefix}-destination`}>
              Exact destination address
            </label>
            <input
              id={`${prefix}-destination`}
              className="editor-input"
              type="url"
              value={destination}
              disabled={mutation.isPending}
              onChange={(event) => setDestination(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            pending={mutation.isPending}
            pendingLabel="Saving grant…"
            disabled={!selected || !destination.trim() || !available}
          >
            Grant destination
          </Button>
          {selected && (
            <ul aria-label={`${selected.name} telemetry grants`}>
              {(selected.telemetryDestinationGrants ?? []).map((grant) => (
                <li key={`${grant.transport}:${grant.destination}`}>
                  {grant.transport === 'product'
                    ? 'Product receiver'
                    : 'OTel collector'}{' '}
                  · {grant.destination}{' '}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={mutation.isPending || !available}
                    onClick={() => void run('unbind', grant)}
                  >
                    Remove grant
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={mutation.isPending}
        onClick={() => void query.refetch()}
      >
        Refresh key references
      </Button>
      {message && <p role={mutation.isError ? 'alert' : 'status'}>{message}</p>}
      <DiscardModal />
    </section>
  );
}
