import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test } from 'vitest';
import {
  CONVERSATION,
  createInboxHarness,
  eventually,
  OWNER,
} from './helpers/thread-inbox-harness.js';

const station = createInboxHarness();

const NOTE = {
  kind: 'file' as const,
  name: 'notes.txt',
  mimeType: 'text/plain' as const,
  size: 2,
  dataUrl: 'data:text/plain;base64,aGk=',
};
const NOTE_BLOB = `sha256-${createHash('sha256').update('hi').digest('hex')}`;

async function entries(world: ReturnType<typeof station>) {
  const listed = await world.listInbox();
  expect(listed.status).toBe(200);
  return (
    (await listed.json()) as { data: { entries: ConversationInboxEntry[] } }
  ).data.entries;
}

describe('a busy follow-up holds its files (followUpAttachments)', () => {
  test('an inline file waits with the message, is listed as a descriptor only, and is sent with it', async () => {
    const world = station({ queuedFiles: true });
    await world.busy();
    const queued = await world.send('with-file', 'review this', {
      whenBusy: 'queue',
      attachments: [NOTE],
    });
    expect(queued.status, await queued.clone().text()).toBe(202);
    const receipt = (await queued.json()) as {
      data: { entry: ConversationInboxEntry };
    };
    const descriptor = {
      kind: NOTE.kind,
      name: NOTE.name,
      mimeType: NOTE.mimeType,
      size: NOTE.size,
    };
    expect(receipt.data.entry.attachments).toEqual([descriptor]);
    const [listed] = await entries(world);
    expect(listed?.attachments).toEqual([descriptor]);
    // Neither the bytes nor their address leave the Station in a listing.
    expect(JSON.stringify(listed)).not.toContain('base64');
    expect(JSON.stringify(listed)).not.toContain('sha256-');
    expect(world.prompts()).toEqual(['read the file']);

    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.prompts()).toEqual(['read the file', 'review this']),
    );
    expect(world.adapter.turns.at(-1)?.attachments).toEqual([NOTE]);
    await eventually(async () =>
      expect(await world.lookup('with-file')).toBe('started'),
    );
  });

  test('a staged file is bound to the held entry and sent with it; its stage is spent', async () => {
    const world = station({ queuedFiles: true, stagedAttachments: true });
    await world.busy();
    const prepared = world.staging.prepare(
      { principalId: OWNER },
      {
        clientAttachmentId: 'chip-1',
        kind: NOTE.kind,
        name: NOTE.name,
        mimeType: NOTE.mimeType,
        size: NOTE.size,
      },
    );
    const reference = world.staging.upload(
      prepared.stageId,
      prepared.uploadGrant,
      NOTE.dataUrl,
    );
    const queued = await world.send('staged-file', 'and this one', {
      whenBusy: 'queue',
      attachmentRefs: [reference],
    });
    expect(queued.status, await queued.clone().text()).toBe(202);
    // Accepted for the held entry: the same chips cannot start another turn.
    const reused = await world.send('other-key', 'again', {
      whenBusy: 'queue',
      attachmentRefs: [reference],
    });
    expect(reused.status).not.toBe(202);
    expect((await entries(world)).map((entry) => entry.clientTurnId)).toEqual([
      'staged-file',
    ]);

    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.prompts()).toEqual(['read the file', 'and this one']),
    );
    expect(world.adapter.turns.at(-1)?.attachments).toEqual([NOTE]);
  });

  test('a file gone from the blob store refuses the entry; the message is never sent without it', async () => {
    const world = station({ queuedFiles: true });
    await world.busy();
    const queued = await world.send('lost-file', 'needs the file', {
      whenBusy: 'queue',
      attachments: [NOTE],
    });
    expect(queued.status, await queued.clone().text()).toBe(202);
    const blob = join(
      world.root,
      'attachments',
      NOTE_BLOB.slice('sha256-'.length, 'sha256-'.length + 2),
      NOTE_BLOB.slice('sha256-'.length),
    );
    expect(existsSync(blob)).toBe(true);
    rmSync(blob);

    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(async () =>
      expect((await entries(world))[0]).toMatchObject({
        clientTurnId: 'lost-file',
        state: 'refused',
        reasonCode: 'attachment_unavailable',
      }),
    );
    expect(world.prompts()).toEqual(['read the file']);
  });

  test('the same key with different files is a different message', async () => {
    const world = station({ queuedFiles: true });
    await world.busy();
    expect(
      (
        await world.send('keyed', 'same words', {
          whenBusy: 'queue',
          attachments: [NOTE],
        })
      ).status,
    ).toBe(202);
    const different = await world.send('keyed', 'same words', {
      whenBusy: 'queue',
      attachments: [{ ...NOTE, dataUrl: 'data:text/plain;base64,aG8=' }],
    });
    expect(different.status).toBe(409);
    expect(await different.json()).toMatchObject({
      code: 'client_turn_input_conflict',
    });
  });

  test('a host that does not store queued files still refuses a busy send with files', async () => {
    const world = station({ stagedAttachments: true });
    await world.busy();
    const withFile = await world.send('no-store', 'needs a file', {
      whenBusy: 'queue',
      attachments: [NOTE],
    });
    expect(withFile.status).not.toBe(202);
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });
});
