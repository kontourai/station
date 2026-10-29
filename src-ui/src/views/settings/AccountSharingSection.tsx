import type {
  AccountSharingChoice,
  AccountSharingOriginOption,
  AccountSharingSettingView,
} from '@kontourai/station-contracts/local-accounts';
import { StationHttpError } from '@kontourai/station-sdk/client';
import {
  applyAccountSharingSetting,
  getAccountSharingSetting,
} from '@kontourai/station-sdk/local-accounts';
import { Badge } from '@kontourai/ui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageSection } from '../../components/PageSection';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { userFacingErrorMessage } from '../../utils/errorText';

/** How often to look again while the Station restarts into a change. */
const RESTART_POLL_MS = 1_500;

const SOURCE_LABEL: Record<
  AccountSharingOriginOption['sources'][number],
  string
> = {
  'tailscale-serve': 'Tailscale Serve',
  'allowed-origin': 'Allowed origin',
  'bound-host': 'Station address',
  'station-loopback': 'This computer',
};
const UNAVAILABLE_LABEL: Record<
  NonNullable<AccountSharingOriginOption['unavailable']>,
  string
> = {
  'requires-https': 'Needs HTTPS',
  'not-a-browser-origin': 'Not in ALLOWED_ORIGINS',
};

/**
 * #4305: Settings → System → Project sharing with local accounts. Operator
 * only; applying restarts the Station through its process supervisor.
 */
export function AccountSharingSection() {
  const authority = useHostRequestAuthorityScope();
  return authority ? (
    <SharingControls
      key={`${authority.apiBase}:${authority.authorityKey}`}
      authority={authority}
    />
  ) : null;
}

function activeChoice(view: AccountSharingSettingView): AccountSharingChoice {
  return view.active.localAccounts && view.active.publicOrigin
    ? { enabled: true, publicOrigin: view.active.publicOrigin }
    : { enabled: false };
}
function sameChoice(a: AccountSharingChoice, b: AccountSharingChoice) {
  return a.enabled
    ? b.enabled && a.publicOrigin === b.publicOrigin
    : !b.enabled;
}

function SharingControls({
  authority,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const client = useQueryClient();
  const nameId = useId();
  const key = [
    'operator-account-sharing',
    authority.apiBase,
    authority.authorityKey,
  ];
  const [restarting, setRestarting] = useState<{
    choice: AccountSharingChoice;
    since: string;
  }>();
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      getAccountSharingSetting(authority.apiBase, {
        requestScope: authority,
        signal,
      }),
    retry: restarting ? 3 : false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: restarting ? RESTART_POLL_MS : false,
  });
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: (choice: AccountSharingChoice) =>
      applyAccountSharingSetting(authority.apiBase, choice, {
        requestScope: authority,
      }),
  });
  const [draft, setDraft] = useState<AccountSharingChoice>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  const view = query.data;
  // The restart is over once the Station reports the change, or reports a
  // later apply outcome that is not it.
  if (
    restarting &&
    view &&
    (sameChoice(activeChoice(view), restarting.choice) ||
      (view.lastApply &&
        view.lastApply.at >= restarting.since &&
        view.lastApply.outcome !== 'applied'))
  )
    setRestarting(undefined);

  async function apply() {
    if (!draft) return;
    setError(undefined);
    const since = new Date().toISOString();
    try {
      const result = await mutation.mutateAsync(draft);
      setConfirming(false);
      if (result.changed) setRestarting({ choice: draft, since });
      setDraft(undefined);
      await client.invalidateQueries({ queryKey: key });
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
    } finally {
      mutation.reset();
    }
  }

  const title = 'Project sharing with local accounts';
  if (query.isPending)
    return (
      <PageSection className="settings__section account-sharing" title={title}>
        <SkeletonBlock count={2} />
      </PageSection>
    );
  if (query.isError && !restarting) {
    const status =
      query.error instanceof StationHttpError ? query.error.status : undefined;
    return (
      <PageSection className="settings__section account-sharing" title={title}>
        {status === 403 ? (
          <p className="settings__field-hint" role="status">
            Only the Station operator can change this. Open Settings on the
            Station host.
          </p>
        ) : status === 404 ? (
          <p className="settings__field-hint" role="status">
            This Station cannot change this from Settings. Update Station to use
            it.
          </p>
        ) : (
          <ErrorState
            title="Project sharing unavailable"
            description={userFacingErrorMessage(query.error)}
            action={
              <Button onClick={() => void query.refetch()}>Try again</Button>
            }
          />
        )}
      </PageSection>
    );
  }
  if (!view)
    return (
      <PageSection className="settings__section account-sharing" title={title}>
        <p className="settings__field-hint" role="status">
          Station is restarting…
        </p>
      </PageSection>
    );

  const locked = view.source === 'deployment';
  const active = activeChoice(view);
  const choice = draft ?? active;
  const selectable = view.origins.filter((option) => !option.unavailable);
  // Turning it on again preselects the last stored address, if still offered.
  const storedOrigin = view.stored?.enabled
    ? view.stored.publicOrigin
    : undefined;
  const defaultOrigin =
    selectable.find((option) => option.origin === storedOrigin)?.origin ??
    selectable[0]?.origin ??
    '';
  const changed = !sameChoice(choice, active);
  const canRestart = view.restart === 'supervised';
  const statusBadge = (
    <Badge
      value={
        view.active.localAccounts
          ? 'On'
          : view.active.externalProvider
            ? 'Provider'
            : 'Off'
      }
      tone={view.active.localAccounts ? 'positive' : 'neutral'}
    />
  );

  return (
    <PageSection
      className="settings__section account-sharing"
      title={title}
      description="Invite people to Projects; they sign in with a username and password."
      actions={statusBadge}
    >
      {locked ? (
        <div className="account-sharing__locked">
          <Badge value="Set by the deployment" tone="neutral" />
          <p className="settings__field-hint">
            Change {view.lockedBy.join(', ')} and restart Station to change it.
          </p>
          {view.active.publicOrigin && (
            <p className="settings__field-hint">
              Sign-in address: {view.active.publicOrigin}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="account-sharing__toggle">
            <span id={`${nameId}-label`}>Turn on</span>
            <Toggle
              checked={choice.enabled}
              disabled={restarting !== undefined}
              describedBy={`${nameId}-label`}
              label="Project sharing with local accounts"
              onChange={(enabled) =>
                setDraft(
                  enabled
                    ? { enabled: true, publicOrigin: defaultOrigin }
                    : { enabled: false },
                )
              }
            />
          </div>
          {choice.enabled && (
            <fieldset
              className="account-sharing__origins"
              disabled={restarting !== undefined}
            >
              <legend>Sign-in address</legend>
              {view.origins.map((option) => (
                <label
                  key={option.origin}
                  className={`account-sharing__origin${option.unavailable ? ' account-sharing__origin--unavailable' : ''}`}
                >
                  <input
                    type="radio"
                    name={`${nameId}-origin`}
                    disabled={option.unavailable !== undefined}
                    checked={choice.publicOrigin === option.origin}
                    onChange={() =>
                      setDraft({ enabled: true, publicOrigin: option.origin })
                    }
                  />
                  <span>
                    <span className="account-sharing__origin-value">
                      {option.origin}
                    </span>
                    <span className="settings__field-hint">
                      {option.sources
                        .map((source) => SOURCE_LABEL[source])
                        .join(' · ')}
                      {option.unavailable &&
                        ` · ${UNAVAILABLE_LABEL[option.unavailable]}`}
                    </span>
                  </span>
                </label>
              ))}
              {selectable.length === 0 && (
                <p className="settings__field-hint" role="status">
                  No usable address. Add an HTTPS origin to ALLOWED_ORIGINS.
                </p>
              )}
            </fieldset>
          )}
          {restarting ? (
            <p className="settings__field-hint" role="status">
              Station is restarting to apply this…
            </p>
          ) : (
            <div className="account-sharing__actions">
              <Button
                variant="primary"
                disabled={
                  !changed ||
                  !canRestart ||
                  (choice.enabled && !choice.publicOrigin)
                }
                onClick={() => setConfirming(true)}
              >
                Apply and restart
              </Button>
              {changed && (
                <Button onClick={() => setDraft(undefined)}>Cancel</Button>
              )}
            </div>
          )}
          {!canRestart && (
            <p className="settings__field-hint" role="status">
              Station can apply this only when its process supervisor runs it.
            </p>
          )}
        </>
      )}
      {view.lastApply && view.lastApply.outcome !== 'applied' && (
        <p className="settings__field-hint" role="status">
          {view.lastApply.outcome === 'rolled-back'
            ? 'The last change was rolled back.'
            : 'The last change was not applied.'}{' '}
          {view.lastApply.reason}
        </p>
      )}
      {view.startupFailure && (
        <p className="settings__field-hint" role="status">
          {view.startupFailure}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <ConfirmModal
        isOpen={confirming}
        pending={mutation.isPending}
        error={error}
        title={
          choice.enabled
            ? 'Turn on Project sharing and restart Station?'
            : 'Turn off Project sharing and restart Station?'
        }
        message={
          choice.enabled
            ? `People will sign in at ${choice.publicOrigin}. Open chats reconnect after the restart.`
            : 'Accounts and Project members are kept, but nobody can sign in until it is on again.'
        }
        onConfirm={() => void apply()}
        onCancel={() => {
          setConfirming(false);
          setError(undefined);
        }}
      />
    </PageSection>
  );
}
