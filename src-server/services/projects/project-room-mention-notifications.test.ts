import { randomUUID } from 'node:crypto';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { NotificationService } from '../notifications/notification-service.js';
import { EventBus } from '../orchestration/event-bus.js';
import { ProjectManifestStore } from './project-manifest-store.js';
import { createProjectMembershipRuntime } from './project-membership-runtime.js';
import type { ProjectMembershipAuthority } from './project-membership-service.js';
import { notifyProjectRoomMention } from './project-room-mention-notifications.js';
import { ProjectService } from './project-service.js';

const temp = trackTempDirs();
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of close.splice(0).reverse()) await dispose();
});
const owner = humanPrincipal('fixture', 'owner', 'Owner');
const alice = humanPrincipal('fixture', 'alice', 'Alice');
const bob = humanPrincipal('fixture', 'bob', 'Bob');

async function fixture() {
  const home = temp('room-mentions-');
  const storage = new FileStorageAdapter(home);
  const projects = new ProjectService(
    storage,
    new ProjectManifestStore(home, storage),
  );
  const project = await projects.createProject({
    name: 'Example',
    slug: 'example',
  });
  const membership = createProjectMembershipRuntime(home, 'station', storage);
  close.push(() => membership.close());
  let actor = owner;
  const authority: ProjectMembershipAuthority = {
    current: async () => ({ principal: actor, verifiedEmails: [] }),
    operator: async () => {
      if (actor.id !== owner.id) throw new Error('operator required');
    },
  };
  const enabled = await membership.service.enable(
    'example',
    project.id,
    authority,
  );
  for (const person of [alice, bob]) {
    actor = owner;
    const invitation = await membership.service.invite(
      enabled.scope,
      {
        email: null,
        role: 'contributor',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      authority,
    );
    actor = person;
    await membership.service.accept(invitation.token, authority);
  }
  actor = owner;
  const service = new NotificationService(new EventBus(), home, 999_999, {
    projectMembership: membership.service,
  });
  close.push(() => service.shutdown());
  return { service, scope: enabled.scope, projectId: project.id };
}
function event(
  scope: Awaited<ReturnType<typeof fixture>>['scope'],
  recipients: string[],
) {
  const messageId = randomUUID();
  return {
    scope,
    slug: 'example',
    channelId: '22222222-2222-4222-8222-222222222222',
    channelName: 'design',
    recipients,
    message: {
      roomId: '22222222-2222-4222-8222-222222222222',
      messageId,
      seq: 3,
      intentId: randomUUID(),
      text: '@Bob can you check the copy?',
      actor: { id: alice.id, displayName: 'Alice', kind: 'person' as const },
      createdAt: new Date().toISOString(),
      mentions: [
        { kind: 'person' as const, actorId: bob.id, display: 'Bob', offset: 0 },
      ],
    },
  };
}

test('a person mention reaches only that person, once, and opens the exact message', async () => {
  const f = await fixture();
  const mention = event(f.scope, [bob.id]);
  await notifyProjectRoomMention(f.service, mention);
  // A retried send of the same message updates its one record.
  await notifyProjectRoomMention(f.service, mention);
  const feed = await f.service.listForPrincipal(bob.id);
  expect(feed).toHaveLength(1);
  expect(feed[0]).toMatchObject({
    category: 'room-mention',
    title: 'Alice mentioned you in #design',
    body: '@Bob can you check the copy?',
  });
  expect(readNotificationEnvelope(feed[0])?.target).toEqual({
    kind: 'path',
    path: `/projects/example?section=room&channel=${mention.channelId}&message=${mention.message.messageId}`,
  });
  // Nobody else hears of it: not the author, not another member, not the owner.
  for (const other of [alice.id, owner.id])
    expect(await f.service.listForPrincipal(other)).toEqual([]);
  // The owner's own inbox (the operator audience) has nothing either.
  expect(await f.service.list({})).toEqual([]);
});

test('someone who is no longer a member is not told', async () => {
  const f = await fixture();
  const outsider = humanPrincipal('fixture', 'mallory', 'Mallory');
  await notifyProjectRoomMention(f.service, event(f.scope, [outsider.id]));
  expect(await f.service.listForPrincipal(outsider.id)).toEqual([]);
});
