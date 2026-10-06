import { isStationProfileStore } from '@kontourai/station-contracts';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import { z } from 'zod';
import { prepareNativeRelayConnectionOwner } from '../../src-ui/src/platform/native/nativeRelayConnectionOwner';
import { createNativeRelayEnrollmentClient } from '../../src-ui/src/platform/native/nativeRelayEnrollmentClient';
import { nativeStationProfileStorage } from '../../src-ui/src/platform/native/stationProfileStorage';
import { invokeTauri } from '../../src-ui/src/platform/native/tauriInvoke';

/** Harness seam for an actual main WebView. Every authority/crypto operation uses the production default native host. */
export function createNativeFreshRelayAcceptance(input: {
  profileName: string;
  profileRevision: number;
  stationAudience: string;
}) {
  const controller = new AbortController();
  const enrollment = createNativeRelayEnrollmentClient({
    profileName: input.profileName,
    expectedProfileRevision: input.profileRevision,
    stationAudience: input.stationAudience,
    signal: controller.signal,
  });
  let ownedAccount:
    | Awaited<ReturnType<typeof prepareNativeRelayConnectionOwner>>
    | undefined;
  const accountOwner = async () => {
    if (ownedAccount?.application.isCurrent()) return ownedAccount;
    ownedAccount?.dispose();
    const storage = nativeStationProfileStorage(true);
    await storage.refresh();
    const profile = storage
      .getRelayRouteProfiles()
      .find((value) => value.name === input.profileName);
    if (!profile?.relayRoute || profile.configurationState !== 'configured')
      throw new Error('native_fixture_owned_activation_required');
    const connectionId = `station-profile:${profile.name.toLowerCase()}`;
    if (!(await storage.authorizeActiveConnection(connectionId, true)))
      throw new Error('native_fixture_selection_refused');
    const binding = storage.captureNativeRequestBinding(
      connectionId,
      input.stationAudience,
    );
    if (!binding) throw new Error('native_fixture_binding_required');
    const rawStore = await invokeTauri<unknown>('station_profile_store_read');
    const store: unknown =
      typeof rawStore === 'string' ? JSON.parse(rawStore) : rawStore;
    if (!isStationProfileStore(store))
      throw new Error('native_fixture_profile_store_invalid');
    ownedAccount = await prepareNativeRelayConnectionOwner({
      connectionId,
      origin: input.stationAudience,
      route: {
        routeVersion: 1,
        brokerOrigin: profile.relayRoute.brokerOrigin,
        profileName: profile.name,
        profileRevision: store.revision,
        stationId: profile.relayRoute.stationId,
        enrollmentId: profile.relayRoute.enrollmentId,
      },
      bindingId: binding.bindingId,
      selectionIsCurrent: () =>
        !controller.signal.aborted &&
        storage.captureNativeRequestBinding(connectionId, input.stationAudience)
          ?.bindingId === binding.bindingId,
    });
    return ownedAccount;
  };
  return Object.freeze({
    begin: enrollment.begin,
    register: (
      credentials: { username: string; password: string },
      invitation: string,
      name: string,
    ) => enrollment.login(credentials, { invitation, name }),
    login: enrollment.login,
    finalize: enrollment.finalize,
    activate: enrollment.activate,
    status: enrollment.status,
    cancel: enrollment.cancel,
    recovery: enrollment.recovery,
    resume: enrollment.resume,
    accountOwner,
    async acceptAndReadPublishedFixture(value: {
      credentials: { username: string; password: string };
      invitation: string;
      scope: ProjectMembershipScope;
      privateProjectSlug: string;
      sharedTask: {
        id: string;
        createdAt: string;
        message: string;
        documentText: string;
        shareId: string;
      };
    }) {
      const owner = await accountOwner();
      if (!owner.account()) await owner.login(value.credentials);
      const member = await owner.acceptInvitation(value.invitation);
      if (
        member.scope.stationId !== value.scope.stationId ||
        member.scope.localProjectId !== value.scope.localProjectId ||
        member.scope.localProjectSlug !== value.scope.localProjectSlug ||
        member.scope.portableProjectId !== value.scope.portableProjectId
      )
        throw new Error('native_fixture_membership_scope_mismatch');
      const account = owner.account();
      const credential = owner.credential();
      const transport = credential.transport;
      const authority = credential.requestAuthority;
      if (!account || !transport || !authority)
        throw new Error('native_fixture_member_transport_required');
      const read = async (path: string, status = 200): Promise<unknown> => {
        if (!authority.isCurrent() || owner.account() !== account)
          throw new Error('native_fixture_member_retired');
        const response = await transport(`${input.stationAudience}${path}`, {
          method: 'GET',
          signal: controller.signal,
        });
        if (response.status !== status)
          throw new Error(`native_fixture_status_${response.status}`);
        const result: unknown = await response.json();
        if (!authority.isCurrent() || owner.account() !== account)
          throw new Error('native_fixture_member_retired');
        return result;
      };
      const slug = value.scope.localProjectSlug;
      const project = z
        .object({
          data: z
            .object({
              version: z.literal('station.member-project/v1'),
              kind: z.literal('member-project'),
              id: z.string(),
              slug: z.literal(slug),
              actions: z.array(z.string()),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(await read(`/api/projects/${encodeURIComponent(slug)}`)).data;
      if (
        project.id !== value.scope.localProjectId ||
        !project.actions.includes('view')
      )
        throw new Error('native_fixture_member_project_mismatch');
      const taskPath = `/api/projects/${encodeURIComponent(slug)}/shared-work/${encodeURIComponent(value.sharedTask.id)}`;
      const document = z
        .object({
          data: z
            .object({
              kind: z.literal('snapshot'),
              task: z
                .object({
                  id: z.literal(value.sharedTask.id),
                  createdAt: z.literal(value.sharedTask.createdAt),
                })
                .strict(),
              text: z.literal(value.sharedTask.documentText),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(await read(`${taskPath}/document`)).data;
      const history = z
        .object({
          data: z
            .object({
              kind: z.literal('available'),
              records: z.array(
                z
                  .object({
                    body: z
                      .object({
                        kind: z.literal('human-message'),
                        text: z.string(),
                      })
                      .strict(),
                  })
                  .passthrough(),
              ),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(await read(`${taskPath}/history`)).data;
      if (
        !history.records.some(
          (record) => record.body.text === value.sharedTask.message,
        )
      )
        throw new Error('native_fixture_shared_history_mismatch');
      const publication = z
        .object({
          data: z
            .object({
              kind: z.literal('shared'),
              publication: z
                .object({ shareId: z.literal(value.sharedTask.shareId) })
                .passthrough(),
            })
            .strict(),
        })
        .passthrough()
        .parse(await read(`${taskPath}/publication`)).data;
      await read(
        `/api/projects/${encodeURIComponent(value.privateProjectSlug)}`,
        403,
      );
      return {
        member,
        principal: account.principal,
        documentRead: document.text === value.sharedTask.documentText,
        historyRead: true,
        publicationRead: publication.kind === 'shared',
        privateProjectDenied: true,
      };
    },
    async stop() {
      controller.abort();
      ownedAccount?.dispose();
      await enrollment.dispose();
    },
  });
}
