import type { SecretBindingView } from '@kontourai/station-contracts/secret-binding';
import {
  useCreateSecretBindingMutation,
  useReplaceSecretBindingMutation,
  useRevokeSecretBindingMutation,
  useSecretBindingsQuery,
} from '@kontourai/station-sdk/secret-bindings-query';
import { type FormEvent, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';

type Backend = 'env' | 'keychain' | 'op';
type Form = {
  id: string;
  name: string;
  backend: Backend;
  reference: string;
  account: string;
  expectedRevision?: number;
};
const emptyForm = (): Form => ({
  id: '',
  name: '',
  backend: 'env',
  reference: '',
  account: '',
});

function sameForm(left: Form, right: Form): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.backend === right.backend &&
    left.reference === right.reference &&
    left.account === right.account &&
    left.expectedRevision === right.expectedRevision
  );
}

function formFor(binding: SecretBindingView): Form {
  const ref = binding.authRef as {
    env?: string;
    op?: string;
    keychain?: { service?: string; account?: string };
  };
  if (ref.keychain)
    return {
      id: binding.id,
      name: binding.name,
      backend: 'keychain',
      reference: ref.keychain.service ?? '',
      account: ref.keychain.account ?? '',
      expectedRevision: binding.revision,
    };
  if (ref.op)
    return {
      id: binding.id,
      name: binding.name,
      backend: 'op',
      reference: ref.op,
      account: '',
      expectedRevision: binding.revision,
    };
  return {
    id: binding.id,
    name: binding.name,
    backend: 'env',
    reference: ref.env ?? '',
    account: '',
    expectedRevision: binding.revision,
  };
}
function authRef(form: Form) {
  if (form.backend === 'env') return { env: form.reference };
  if (form.backend === 'op') return { op: form.reference };
  return {
    keychain: {
      service: form.reference,
      ...(form.account ? { account: form.account } : {}),
    },
  };
}
function referenceMetadata(auth: SecretBindingView['authRef']): string {
  const ref = auth as {
    env?: unknown;
    op?: unknown;
    keychain?: { service?: unknown; account?: unknown };
  };
  if (typeof ref.env === 'string') return `environment ${ref.env}`;
  if (typeof ref.op === 'string') return `1Password ${ref.op}`;
  if (ref.keychain && typeof ref.keychain.service === 'string')
    return `keychain ${ref.keychain.service}${typeof ref.keychain.account === 'string' ? ` / ${ref.keychain.account}` : ''}`;
  return 'reference unavailable';
}

/** Operator metadata only: this component never renders credential material. */
export function SecretBindingsSection() {
  const {
    data: bindings = [],
    isLoading,
    error,
    refetch,
  } = useSecretBindingsQuery({ retry: false });
  const [form, setForm] = useState<Form>(emptyForm);
  const [savedForm, setSavedForm] = useState<Form>(emptyForm);
  const [message, setMessage] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<SecretBindingView | null>(
    null,
  );
  const create = useCreateSecretBindingMutation();
  const replace = useReplaceSecretBindingMutation();
  const revoke = useRevokeSecretBindingMutation();
  const editing = form.expectedRevision !== undefined;
  const dirty = !sameForm(form, savedForm);
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  const pending = create.isPending || replace.isPending;
  const resetForm = () => {
    const next = emptyForm();
    setForm(next);
    setSavedForm(next);
  };
  const beginEdit = (binding: SecretBindingView) => {
    const next = formFor(binding);
    setForm(next);
    setSavedForm(next);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    try {
      if (editing) {
        await replace.mutateAsync({
          id: form.id,
          name: form.name,
          authRef: authRef(form),
          expectedRevision: form.expectedRevision!,
        });
        setMessage('Binding metadata saved.');
      } else {
        await create.mutateAsync({
          id: form.id,
          name: form.name,
          authRef: authRef(form),
        });
        setMessage('Binding created.');
      }
      resetForm();
    } catch (submissionError) {
      setMessage(
        submissionError instanceof Error
          ? submissionError.message
          : 'Secret binding could not be saved.',
      );
    }
  };
  return (
    <section className="agent-editor__section" aria-label="Secret bindings">
      <div className="agent-editor__section-header">
        <h3 className="agent-editor__section-title">Secret bindings</h3>
        <p className="agent-editor__section-desc">
          Operator-owned MCP references. Secret material never enters this
          editor.
        </p>
      </div>
      <form className="integration-binding-picker" onSubmit={submit}>
        <label>
          ID
          <input
            value={form.id}
            disabled={editing}
            onChange={(event) => setForm({ ...form, id: event.target.value })}
          />
        </label>
        <label>
          Name
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label>
          Backend
          <select
            value={form.backend}
            onChange={(event) =>
              setForm({ ...form, backend: event.target.value as Backend })
            }
          >
            <option value="env">Environment</option>
            <option value="keychain">Keychain</option>
            <option value="op">1Password</option>
          </select>
        </label>
        <label>
          Reference
          <input
            value={form.reference}
            placeholder={
              form.backend === 'op'
                ? 'op://vault/item/field'
                : form.backend === 'env'
                  ? 'TOKEN_NAME'
                  : 'service name'
            }
            onChange={(event) =>
              setForm({ ...form, reference: event.target.value })
            }
          />
        </label>
        {form.backend === 'keychain' && (
          <label>
            Account (optional)
            <input
              value={form.account}
              onChange={(event) =>
                setForm({ ...form, account: event.target.value })
              }
            />
          </label>
        )}
        <Button
          type="submit"
          variant="primary"
          pending={pending}
          pendingLabel="Saving…"
          disabled={!form.id || !form.name || !form.reference}
        >
          {editing ? 'Save binding' : 'Create binding'}
        </Button>
        {(editing || dirty) && (
          <Button variant="secondary" onClick={() => guard(resetForm)}>
            {editing ? 'Cancel edit' : 'Cancel create'}
          </Button>
        )}
      </form>
      {message && <p role="status">{message}</p>}
      {isLoading ? (
        <SkeletonList count={2} />
      ) : error ? (
        <ErrorState
          title="Secret bindings unavailable"
          description={error.message}
          action={
            <Button size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      ) : bindings.length === 0 ? (
        <Empty
          label="Nothing here yet"
          description="Create an operator-owned reference before binding an MCP environment."
        />
      ) : (
        <ul className="integration-binding-list">
          {bindings.map((binding) => (
            <li key={binding.id}>
              <strong>{binding.name}</strong>{' '}
              <span>
                {binding.availability.backend} reference (
                {referenceMetadata(binding.authRef)}) ·{' '}
                {binding.availability.available
                  ? 'backend available'
                  : 'backend unavailable'}{' '}
                · revision {binding.revision}
              </span>{' '}
              <span>{binding.revokedAt ? 'revoked' : 'active'}</span>
              <ul aria-label={`${binding.name} grants`}>
                {binding.grants.length === 0 ? (
                  <li>
                    <Empty variant="compact" label="Nothing here yet" />
                  </li>
                ) : (
                  binding.grants.map((grant) => (
                    <li key={`${grant.integrationId}:${grant.envName}`}>
                      {grant.integrationId} · {grant.envName}
                    </li>
                  ))
                )}
              </ul>
              {!binding.revokedAt && (
                <>
                  <Button
                    size="sm"
                    onClick={() => guard(() => beginEdit(binding))}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setRevokeTarget(binding)}
                  >
                    Revoke
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmModal
        isOpen={revokeTarget !== null}
        title="Revoke secret binding"
        message={`Revoke "${revokeTarget?.name ?? ''}"? Existing MCP consumers will no longer be able to establish this binding.`}
        confirmLabel="Revoke binding"
        variant="danger"
        role="alertdialog"
        pending={revoke.isPending}
        onConfirm={() => {
          if (!revokeTarget) return;
          void revoke
            .mutateAsync({
              id: revokeTarget.id,
              expectedRevision: revokeTarget.revision,
            })
            .then(() => {
              setMessage('Binding revoked.');
              setRevokeTarget(null);
            })
            .catch((revokeError) => {
              setMessage(
                revokeError instanceof Error
                  ? revokeError.message
                  : 'Secret binding could not be revoked.',
              );
              setRevokeTarget(null);
            });
        }}
        onCancel={() => setRevokeTarget(null)}
      />
      <DiscardModal />
    </section>
  );
}
