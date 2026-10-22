import type {
  EngineSignInAttempt,
  EngineSignInMethod,
  EngineSignInView,
} from '@kontourai/station-sdk/engine-sign-in';
import {
  useEngineCredentialMutation,
  useEngineSignInAttemptQuery,
  useEngineSignInCheckMutation,
  useEngineSignInMutation,
  useEngineSignInQuery,
} from '@kontourai/station-sdk/engine-sign-in';
import { useEffect, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import { openExternalLink } from '../../platform/openExternalLink';
import { Button } from '../Button';
import { TerminalPanel } from '../coding-layout/TerminalPanel';
import { hostActionCopy } from '../host-action/host-action-copy';
import { SkeletonBlock } from '../state';
import './EngineSignInPanel.css';

const STATE_LABEL: Record<EngineSignInView['status']['state'], string> = {
  authenticated: 'Signed in',
  unauthenticated: 'Not signed in',
  unknown: 'Not checked',
};

function when(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

/** Why the status reads as it does, in the person's words. */
function statusDetail(view: EngineSignInView): string {
  const { status, engineName } = view;
  const at = when(status.observedAt);
  switch (status.source) {
    case 'status-command':
      return `${engineName}'s own status check said so${at ? ` at ${at}` : ''}.`;
    case 'refusal':
      return `${engineName} refused a chat because it needs a sign-in${at ? ` (${at})` : ''}.`;
    case 'sign-in':
      return `${engineName} reported the sign-in from Station as complete${at ? ` at ${at}` : ''}.`;
    default:
      return status.checkable
        ? `Station could not tell whether ${engineName} is signed in.`
        : `${engineName} has no sign-in check Station can run. A chat will say if it needs a sign-in.`;
  }
}

function TermsNote({
  notice,
}: {
  notice: NonNullable<EngineSignInMethod['termsNotice']>;
}) {
  return (
    <small className="engine-sign-in__terms">
      {`This sign-in can use a subscription from ${notice.provider}. ${notice.provider}'s terms may restrict using a subscription login in tools other than its own. `}
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void openExternalLink(notice.termsUrl)}
      >
        Read {notice.provider}'s terms
      </Button>
    </small>
  );
}

function AttemptView({
  attempt,
  engineName,
  onCancel,
  cancelling,
}: {
  attempt: EngineSignInAttempt;
  engineName: string;
  onCancel: () => void;
  cancelling: boolean;
}) {
  if (attempt.state !== 'running') {
    const text =
      attempt.state === 'succeeded'
        ? `${engineName} finished signing in.`
        : attempt.state === 'cancelled'
          ? 'The sign-in was cancelled.'
          : attempt.state === 'timed-out'
            ? 'The sign-in took too long and was stopped.'
            : `The sign-in did not finish.${attempt.message ? ` ${attempt.message}` : ''}`;
    return (
      <p
        className="engine-sign-in__attempt"
        role={attempt.state === 'succeeded' ? 'status' : 'alert'}
      >
        {text}
      </p>
    );
  }
  return (
    <div className="engine-sign-in__attempt" role="status" aria-live="polite">
      {attempt.kind === 'terminal' && attempt.terminal ? (
        <>
          <span>Finish signing in in the terminal below.</span>
          <div className="engine-sign-in__terminal">
            <TerminalPanel
              projectSlug={attempt.terminal.projectSlug}
              terminalId={attempt.terminal.terminalId}
              workingDir="~"
              attachOnly
              isActive
            />
          </div>
        </>
      ) : (
        <span>Waiting for {engineName} to finish signing in.</span>
      )}
      {(attempt.links ?? []).map((link) => (
        <span key={link} className="engine-sign-in__link">
          <code>{link}</code>
          <Button size="sm" onClick={() => void openExternalLink(link)}>
            Open link
          </Button>
        </span>
      ))}
      <Button size="sm" onClick={onCancel} pending={cancelling}>
        Cancel sign-in
      </Button>
    </div>
  );
}

function CredentialField({
  name,
  configured,
  disabled,
  pending,
  onSave,
  onClear,
}: {
  name: string;
  configured: boolean;
  disabled: boolean;
  pending: boolean;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(!configured);
  useEffect(() => setEditing(!configured), [configured]);
  const id = `engine-key-${name}`;
  if (!editing)
    return (
      <div className="engine-sign-in__key">
        <span>
          <code>{name}</code> is saved.
        </span>
        <Button size="sm" disabled={disabled} onClick={() => setEditing(true)}>
          Replace
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={disabled}
          pending={pending}
          onClick={onClear}
        >
          Remove
        </Button>
      </div>
    );
  return (
    <form
      className="engine-sign-in__key"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) return;
        onSave(value);
        setValue('');
      }}
    >
      <label htmlFor={id}>
        <code>{name}</code>
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        disabled={disabled || !value.trim()}
        pending={pending}
      >
        Save key
      </Button>
    </form>
  );
}

/**
 * An engine's sign-in: what Station knows about it, and the ways the engine
 * itself offers to sign in. Everything shown comes from the server; the
 * client sends only a method id or a key value, never what to run.
 */
export function EngineSignInPanel({
  connectionId,
  onSignedIn,
}: {
  connectionId: string;
  /** After a sign-in finishes, e.g. to check the engine again. */
  onSignedIn?: () => void;
}) {
  const scope = useHostRequestAuthorityScope();
  const presentation = useDevicePresentation();
  const enabled = !!scope;
  const view = useEngineSignInQuery(
    connectionId,
    scope ?? { apiBase: '', authorityKey: '' },
    enabled,
  );
  const signInAllowed = view.data?.allowed.signIn === true;
  const attempt = useEngineSignInAttemptQuery(
    connectionId,
    scope ?? { apiBase: '', authorityKey: '' },
    enabled && signInAllowed,
  );
  const check = useEngineSignInCheckMutation(
    connectionId,
    scope ?? { apiBase: '', authorityKey: '' },
  );
  const signIn = useEngineSignInMutation(
    connectionId,
    scope ?? { apiBase: '', authorityKey: '' },
  );
  const credential = useEngineCredentialMutation(
    connectionId,
    scope ?? { apiBase: '', authorityKey: '' },
  );

  // Read the engine's sign-in methods once if this Station has not yet.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (
      autoChecked.current ||
      !view.data ||
      view.data.methods ||
      view.data.methodsError
    )
      return;
    autoChecked.current = true;
    check.mutate();
  }, [view.data, check]);

  // A finished sign-in changes the status; read it again once.
  const current = attempt.data ?? null;
  const finishedId = useRef<string | null>(null);
  useEffect(() => {
    if (!current || current.state === 'running') return;
    if (finishedId.current === current.id) return;
    finishedId.current = current.id;
    if (current.state === 'succeeded') {
      check.mutate();
      onSignedIn?.();
    }
  }, [current, check, onSignedIn]);

  if (!scope) return null;
  if (view.isLoading)
    return (
      <section className="engine-sign-in" aria-label="Sign-in">
        <SkeletonBlock count={2} label="Loading sign-in" />
      </section>
    );
  if (view.isError || !view.data)
    return (
      <section className="engine-sign-in" aria-label="Sign-in">
        <p role="alert">
          Sign-in could not be read.{' '}
          <Button size="sm" onClick={() => void view.refetch()}>
            Retry
          </Button>
        </p>
      </section>
    );

  const data = view.data;
  const running = current?.state === 'running';
  const error =
    (check.error as Error | null)?.message ??
    (signIn.error as Error | null)?.message ??
    (credential.error as Error | null)?.message;
  const methods = data.methods ?? [];
  const paired = presentation?.deviceClass === 'paired';

  return (
    <section className="engine-sign-in" aria-label="Sign-in">
      <div className="engine-sign-in__status">
        <h3>Sign-in</h3>
        <strong data-state={data.status.state}>
          {STATE_LABEL[data.status.state]}
        </strong>
        <Button
          size="sm"
          pending={check.isPending}
          onClick={() => check.mutate()}
        >
          Check again
        </Button>
      </div>
      <small>{statusDetail(data)}</small>
      {presentation && (
        <small>{hostActionCopy('engine-sign-in', presentation)}</small>
      )}
      {!signInAllowed && (
        <small>
          This device is not allowed to sign engines in. The Station's operator
          can allow it from this device's access settings.
        </small>
      )}
      {data.termsNotice && <TermsNote notice={data.termsNotice} />}

      {current && (
        <AttemptView
          attempt={current}
          engineName={data.engineName}
          cancelling={signIn.isPending}
          onCancel={() => signIn.mutate({ kind: 'cancel' })}
        />
      )}

      {methods.length > 0 && (
        <ul className="engine-sign-in__methods">
          {methods.map((method) => {
            const terminalBlocked =
              method.kind === 'terminal' && !data.allowed.terminal;
            return (
              <li key={method.id}>
                <div>
                  <strong>{method.name}</strong>
                  {method.description && <small>{method.description}</small>}
                  {method.kind === 'terminal' &&
                    !terminalBlocked &&
                    presentation && (
                      <small>
                        {hostActionCopy(
                          'engine-sign-in-terminal',
                          presentation,
                        )}
                      </small>
                    )}
                  {method.kind === 'agent' && presentation && (
                    <small>
                      {hostActionCopy('engine-sign-in-browser', presentation)}
                    </small>
                  )}
                  {terminalBlocked && signInAllowed && (
                    <small>
                      {paired && presentation
                        ? hostActionCopy('connection-sign-in', presentation)
                        : 'This sign-in runs a command on the computer Station runs on, which this device is not allowed to do.'}
                    </small>
                  )}
                  {method.termsNotice && (
                    <TermsNote notice={method.termsNotice} />
                  )}
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!signInAllowed || terminalBlocked || running}
                  pending={
                    signIn.isPending &&
                    signIn.variables?.kind === 'start' &&
                    signIn.variables.methodId === method.id
                  }
                  onClick={() =>
                    signIn.mutate({ kind: 'start', methodId: method.id })
                  }
                >
                  Sign in
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {data.methodsError && (
        <small role="alert">
          {data.engineName} did not list its sign-in options:{' '}
          {data.methodsError}
        </small>
      )}
      {methods.length === 0 && data.signInHint && (
        <small>{data.signInHint}</small>
      )}

      {data.credentials.length > 0 && (
        <div className="engine-sign-in__keys">
          <strong>API key</strong>
          {presentation && paired && (
            <small>{hostActionCopy('connection-api-key', presentation)}</small>
          )}
          {data.credentials.map((field) => (
            <CredentialField
              key={field.name}
              name={field.name}
              configured={field.configured}
              disabled={!signInAllowed}
              pending={
                credential.isPending &&
                credential.variables?.name === field.name
              }
              onSave={(value) => credential.mutate({ name: field.name, value })}
              onClear={() =>
                credential.mutate({ name: field.name, value: null })
              }
            />
          ))}
          <small>
            Station keeps the key for this engine only and gives it to{' '}
            {data.engineName} when it starts. It is never shown again.
          </small>
        </div>
      )}
      {error && (
        <p role="alert" className="engine-sign-in__error">
          {error}
        </p>
      )}
    </section>
  );
}
