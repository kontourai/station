import type { ProjectAccessAdministrationView } from '@kontourai/station-contracts/project-membership';
import { StationHttpError } from '@kontourai/station-sdk';
import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import {
  changeProjectAccess,
  getProjectAccess,
  type ProjectAccessCommand,
  type ProjectAccessCommandResult,
} from '@kontourai/station-sdk/project-access-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { SkeletonList } from '../../components/state';
import { AccessPanelView } from '../project-settings/AccessPanelView';
import {
  GuestAccountRequired,
  requireGuestAccount,
} from './guest-account-authority';

class GuestAccessScopeLost extends Error {}

const guestOptions = (signal?: AbortSignal) => ({
  authentication: 'omit' as const,
  ...(signal ? { signal } : {}),
  timeoutMs: 15_000,
  maxResponseBytes: 64 * 1024,
});

async function readAdministration(
  apiBase: string,
  principalId: string,
  slug: string,
  signal: AbortSignal,
): Promise<ProjectAccessAdministrationView> {
  await requireGuestAccount(apiBase, principalId, signal);
  try {
    const view = await getProjectAccess(apiBase, slug, guestOptions(signal));
    await requireGuestAccount(apiBase, principalId, signal);
    if (view.actingPrincipal.id !== principalId)
      throw new GuestAccountRequired();
    return view;
  } catch (cause) {
    if (cause instanceof GuestAccountRequired) throw cause;
    if (cause instanceof StationHttpError && cause.status === 401) {
      await requireGuestAccount(apiBase, principalId, signal);
      throw new GuestAccessScopeLost();
    }
    throw cause;
  }
}

/**
 * People and access for an invited Project admin, from the guest entry
 * surface (outside ApiBaseProvider, cookie-authenticated, no operator
 * credential).
 *
 * Administration is proven per read, never assumed: a successful access
 * read means the current account holds `manage-members` on this Project
 * right now, and the shared panel below derives every editing affordance
 * from that view's canonical member actions. Whether this browser may
 * submit changes is a SEPARATE, independently approved device capability
 * read from the credential-bound authority observation — never inferred
 * from membership and never granting membership.
 *
 * Every mutation carries the caller-captured acting principal as
 * `expectedActor`; the server refuses before committing when freshly
 * authenticated authority resolves differently (e.g. HttpOnly cookies
 * replaced in another window). Principal, scope, and revision are captured
 * synchronously at confirm time, before any await. Committed mutations are
 * never retried automatically: a refusal refreshes reads and says so.
 */
export function GuestProjectAccessView({
  apiBase,
  principalId,
  project,
  onAccountRequired,
  onAccessLost,
}: {
  apiBase: string;
  principalId: string;
  project: { id: string; slug: string };
  onAccountRequired: () => void;
  onAccessLost: () => void;
}) {
  const client = useQueryClient();
  const [banner, setBanner] = useState<GuestAccessBanner>();
  const hadAdministration = useRef(false);
  const onAccountRequiredRef = useRef(onAccountRequired);
  onAccountRequiredRef.current = onAccountRequired;
  const onAccessLostRef = useRef(onAccessLost);
  onAccessLostRef.current = onAccessLost;
  const accessKey = [
    'guest-project-access',
    apiBase,
    principalId,
    project.id,
    project.slug,
  ] as const;
  const authorityKeyPrefix = ['guest-authority', apiBase, principalId] as const;
  const access = useQuery({
    queryKey: accessKey,
    queryFn: ({ signal }) =>
      readAdministration(apiBase, principalId, project.slug, signal),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  const observation = useQuery({
    queryKey: [...authorityKeyPrefix, project.slug],
    queryFn: async ({ signal }) => {
      await requireGuestAccount(apiBase, principalId, signal);
      const value = await getAuthorityObservation(
        apiBase,
        guestOptions(signal),
      );
      await requireGuestAccount(apiBase, principalId, signal);
      if (value.principal.id !== principalId) throw new GuestAccountRequired();
      return value;
    },
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  const accountRequired =
    access.error instanceof GuestAccountRequired ||
    observation.error instanceof GuestAccountRequired;
  useEffect(() => {
    if (accountRequired) onAccountRequiredRef.current();
  }, [accountRequired]);
  useEffect(() => {
    if (access.isSuccess) hadAdministration.current = true;
  }, [access.isSuccess]);
  useEffect(() => {
    if (access.error instanceof GuestAccessScopeLost) return;
    if (
      access.error instanceof StationHttpError &&
      access.error.status === 404
    ) {
      onAccessLostRef.current();
      return;
    }
    if (
      hadAdministration.current &&
      access.error instanceof StationHttpError &&
      (access.error.status === 401 || access.error.status === 403)
    ) {
      // A self-demotion already named its own cause; keep that specific
      // acknowledgement rather than replacing it with the generic one.
      setBanner(
        (current) =>
          current ?? {
            // The access read itself failed, so nothing was refreshed.
            refreshed: false,
            cause:
              "Your administration access changed. You can still read the Project, but can't change people or invitations.",
          },
      );
    }
  }, [access.error]);
  useEffect(
    () => () => {
      const accessFilter = {
        queryKey: [
          'guest-project-access',
          apiBase,
          principalId,
          project.id,
          project.slug,
        ],
      } as const;
      const authorityFilter = {
        queryKey: ['guest-authority', apiBase, principalId],
      } as const;
      void client.cancelQueries(accessFilter);
      void client.removeQueries(accessFilter);
      void client.cancelQueries(authorityFilter);
      void client.removeQueries(authorityFilter);
    },
    [apiBase, client, principalId, project.id, project.slug],
  );

  /** `refreshReads` never throws, so the read's own state says if it worked. */
  function accessReadSucceeded() {
    return client.getQueryState(accessKey)?.status === 'success';
  }

  async function refreshReads() {
    await client.invalidateQueries({ queryKey: accessKey });
    await client.invalidateQueries({ queryKey: authorityKeyPrefix });
  }

  async function apply(
    command: ProjectAccessCommand,
  ): Promise<ProjectAccessCommandResult> {
    // Own-copy synchronously, before any await, and keep the exact
    // scope/revision/actor the panel captured with the rendered action or
    // the opened confirmation: a refresh that replaces the cached
    // administration between opening a confirmation and confirming it must
    // never retarget that intent onto the newer scope or principal. The
    // server comparison against fresh authority stays the authority; this
    // only guarantees the client sends the OLD intent, never a newer one.
    const presented =
      client.getQueryData<ProjectAccessAdministrationView>(accessKey);
    if (!presented)
      throw new Error(
        'The access list is unavailable. Refresh it before trying again.',
      );
    // The shared panel never emits the operator-only enable bootstrap;
    // narrowing here keeps the intent stamping exact for the four leaves.
    if (command.kind === 'enable')
      throw new Error('Enabling Project sharing needs the Station operator.');
    if (command.expectedActor !== principalId)
      throw new Error(
        'The acting account changed. Refresh access before trying again.',
      );
    const stamped: ProjectAccessCommand = {
      ...command,
      scope: { ...command.scope },
    };
    try {
      const outcome = await changeProjectAccess(
        apiBase,
        project.slug,
        stamped,
        guestOptions(),
      );
      await refreshReads();
      if (
        stamped.kind === 'change-member' &&
        stamped.principalId === stamped.expectedActor &&
        (stamped.role !== 'admin' || stamped.status !== 'active')
      )
        setBanner({
          refreshed: true,
          cause:
            "You changed your own Project role. You can still read the Project, but can't change people or invitations.",
        });
      return outcome;
    } catch (cause) {
      if (cause instanceof StationHttpError && cause.status === 409) {
        await refreshReads();
        throw new Error(
          'Someone else changed Project access first. Review the refreshed list before trying again.',
        );
      }
      if (cause instanceof StationHttpError && cause.status === 401) {
        await refreshReads();
        setBanner({
          // Station refused the change for this browser. Claim a refresh only
          // if the re-read access list actually came back.
          refreshed: accessReadSucceeded(),
          cause:
            "Station refused this change for this browser. If the list doesn't let you change people, request browser access again.",
        });
        throw new Error(
          "Station refused this change because your sign-in or this browser's approval changed. It wasn't retried.",
        );
      }
      if (cause instanceof StationHttpError && cause.status === 403) {
        await refreshReads();
        setBanner({
          refreshed: accessReadSucceeded(),
          cause:
            'Your Project role or this browser’s approval changed. Review the list before trying again.',
        });
        throw new Error(
          "Station refused this change and it wasn't retried. The list shows what you can still do.",
        );
      }
      throw cause;
    }
  }

  if (access.isPending || accountRequired)
    return <SkeletonList count={1} label="Checking Project administration" />;
  if (access.error) {
    if (access.error instanceof StationHttpError) {
      if (access.error.status === 403)
        return (
          <section
            className="account-entry__access-view-only"
            aria-label="People and access"
          >
            {banner && <AccessBannerStatus banner={banner} />}
            <h4>People and access</h4>
            <p>
              People and invitation management is limited to Project admins.
              {observation.data?.grant.kind === 'device' &&
              !observation.data.grant.grantedScopes.includes(
                'orchestration:operate',
              )
                ? ' This browser is also view only until the Station operator approves it for managing collaborators.'
                : ''}
            </p>
            <div className="account-entry__actions">
              <Button
                onClick={() => {
                  setBanner(undefined);
                  void refreshReads();
                }}
              >
                Refresh people and access
              </Button>
            </div>
          </section>
        );
      if (access.error.status === 404) return null;
    }
    if (access.error instanceof GuestAccessScopeLost)
      return (
        <section
          className="account-entry__access-view-only"
          aria-label="People and access"
        >
          <h4>People and access</h4>
          <p role="alert">
            This browser’s approval changed. Request browser access again to
            restore the shared Project list.
          </p>
          <div className="account-entry__actions">
            <Button onClick={() => void refreshReads()}>Refresh</Button>
          </div>
        </section>
      );
    return (
      <section
        className="account-entry__access-view-only"
        aria-label="People and access"
      >
        <h4>People and access</h4>
        <p role="alert">People and access is unavailable.</p>
        <div className="account-entry__actions">
          <Button onClick={() => void refreshReads()}>Retry</Button>
        </div>
      </section>
    );
  }

  const view = access.data;
  const actor = view.members.find(
    (member) =>
      member.principal.id === view.actingPrincipal.id &&
      member.status === 'active',
  );
  const grant = observation.data?.grant;
  const deviceGrant = grant?.kind === 'device' ? grant : undefined;
  const grantedScopes = new Set(deviceGrant?.grantedScopes ?? []);
  const canOperate =
    grantedScopes.has('orchestration:read') &&
    grantedScopes.has('orchestration:operate');
  const observationMismatch =
    observation.isSuccess &&
    observation.data.principal.id !== view.actingPrincipal.id;
  const writeDisabledReason = observationMismatch
    ? 'The signed-in account changed while this list was open. Refresh before changing anything.'
    : observation.data === undefined
      ? 'This browser’s approval couldn’t be checked. Ask the Station operator to approve this browser for managing collaborators.'
      : !canOperate
        ? 'View only. To change people or invitations, ask the Station operator to approve this browser for managing collaborators.'
        : undefined;
  // The remount key clears one-time invitation links and pending
  // confirmations whenever the rendered authority or Project changes.
  const panelKey = [
    apiBase,
    principalId,
    project.slug,
    view.actingPrincipal.id,
    view.scope.localProjectId,
    view.scope.portableProjectId,
    deviceGrant
      ? `${deviceGrant.deviceId}:${[...deviceGrant.grantedScopes].sort().join(' ')}`
      : (observation.data?.grant.kind ?? 'unknown'),
  ].join('|');

  return (
    <section
      className="account-entry__access-admin"
      aria-label="People and access"
    >
      {banner && <AccessBannerStatus banner={banner} />}
      <p role="status" className="account-entry__capability">
        Signed in as <strong>{actor?.principal.display}</strong> · Project role:{' '}
        <strong>{actor?.role}</strong> · People administration:{' '}
        <strong>
          {writeDisabledReason ? 'view-only' : 'can submit changes'}
        </strong>
      </p>
      {observationMismatch && (
        <p role="alert">
          The signed-in account changed while this list was open. The list was
          kept for inspection only.
        </p>
      )}
      <AccessPanelView
        key={panelKey}
        view={view}
        busy={access.isFetching || observation.isFetching}
        apply={apply}
        writeDisabledReason={writeDisabledReason}
        expectedActor={view.actingPrincipal.id}
      />
      <div className="account-entry__actions">
        <Button
          onClick={() => {
            setBanner(undefined);
            void refreshReads();
          }}
        >
          Refresh people and access
        </Button>
      </div>
    </section>
  );
}

/**
 * `refreshed` is true only where the access list was actually re-read
 * successfully before the banner was set (a self-demotion; a 401 or 403
 * refusal of a change only when its re-read came back), so
 * "List refreshed." is never claimed after a read Station refused.
 */
interface GuestAccessBanner {
  refreshed: boolean;
  cause: string;
}

function AccessBannerStatus({ banner }: { banner: GuestAccessBanner }) {
  return (
    <p role="status">
      {banner.refreshed ? `List refreshed. ${banner.cause}` : banner.cause}
    </p>
  );
}
