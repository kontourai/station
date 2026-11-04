import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { AttachmentStagingService } from '../attachment-staging-service.js';
import {
  captureTurnIntent,
  decodeTurnIntent,
} from '../prepared-turn-intent.js';

const DATA = 'data:text/plain;base64,aGVsbG8=';
const owner = { principalId: 'human:local:operator' };
const resumeGuard = { binding: {}, requiresFreshCompanions: false };

function retainedRow(capture: ReturnType<typeof captureTurnIntent>) {
  return {
    envelopeJson: capture.envelopeJson,
    inputDigest: capture.intent.inputDigest,
    intentDigest: capture.intent.intentDigest,
    invocationId: capture.intent.invocationId,
    threadId: capture.threadId,
  };
}

describe('retained turn intent with staged attachments', () => {
  test('a turn whose attachments came from staging decodes when its terminal retires the boundary', () => {
    const staging = new AttachmentStagingService(() => 1_000);
    const prepared = staging.prepare(owner, {
      clientAttachmentId: 'client-attachment-1',
      kind: 'file',
      name: 'note.txt',
      mimeType: 'text/plain',
      size: 5,
    });
    const reference = staging.upload(
      prepared.stageId,
      prepared.uploadGrant,
      DATA,
    );
    const attachments = staging.bindAndHydrate(owner, [reference], {
      threadId: 'thread-1',
      clientTurnId: 'turn-1',
    });

    const capture = captureTurnIntent(
      { threadId: 'thread-1', input: 'see attached', attachments },
      resumeGuard,
    );

    expect(capture.envelopeJson).not.toContain('clientAttachmentId');
    expect(decodeTurnIntent(retainedRow(capture)).input.attachments).toEqual([
      {
        kind: 'file',
        name: 'note.txt',
        mimeType: 'text/plain',
        size: 5,
        dataUrl: DATA,
      },
    ]);
  });

  // Recovery replays an attachment read back from the event log, which keeps
  // its blob reference beside the bytes; other callers leave their own handles.
  test('a capture projects every attachment to the contract fields whatever its caller left on it', () => {
    const attachment = {
      kind: 'file' as const,
      name: 'note.txt',
      mimeType: 'text/plain' as const,
      size: 5,
      dataUrl: DATA,
    };
    const capture = captureTurnIntent(
      {
        threadId: 'thread-1',
        input: 'see attached',
        attachments: [
          {
            ...attachment,
            clientAttachmentId: 'client-attachment-1',
            blobRef: `sha256-${'a'.repeat(64)}`,
            id: 'task-room-attachment',
          } as never,
        ],
      },
      resumeGuard,
    );

    expect(capture.adapterInput.attachments).toEqual([attachment]);
    expect(decodeTurnIntent(retainedRow(capture)).input.attachments).toEqual([
      attachment,
    ]);
  });

  // An attachment with no bytes cannot decode at retirement, so it must be
  // refused here, before the engine can receive the turn.
  test('a capture refuses an attachment whose bytes are missing', () => {
    expect(() =>
      captureTurnIntent(
        {
          threadId: 'thread-1',
          input: 'see attached',
          attachments: [
            {
              kind: 'file',
              name: 'note.txt',
              mimeType: 'text/plain',
              size: 5,
              blobRef: `sha256-${'a'.repeat(64)}`,
            } as never,
          ],
        },
        resumeGuard,
      ),
    ).toThrow('finite JSON values');
  });

  // Rows retained before the projection are already on disk and their digests
  // cover those bytes, so they must keep decoding.
  test.each([
    ['clientAttachmentId', 'client-attachment-1'],
    ['blobRef', `sha256-${'a'.repeat(64)}`],
  ])('an envelope retained with a leaked %s still decodes', (key, value) => {
    const envelope = {
      input: {
        attachments: [
          {
            [key]: value,
            dataUrl: DATA,
            kind: 'file',
            mimeType: 'text/plain',
            name: 'note.txt',
            size: 5,
          },
        ],
        text: 'see attached',
      },
      invocationId: '5d1d7a51-1b1e-4c7e-9a4e-0b8b6f2f7a11',
      resumeGuard,
      schema: 'station.prepared-turn/v1',
      threadId: 'thread-1',
    };
    // Keys are written sorted at every level, as the real writer produces.
    const envelopeJson = JSON.stringify(envelope);
    const digest = (domain: string, bytes: string) =>
      createHash('sha256').update(`${domain}\0`).update(bytes).digest('hex');

    const decoded = decodeTurnIntent({
      envelopeJson,
      inputDigest: digest(
        'station.prepared-turn-input/v1',
        JSON.stringify(envelope.input),
      ),
      intentDigest: digest('station.prepared-turn-envelope/v1', envelopeJson),
      invocationId: envelope.invocationId,
      threadId: 'thread-1',
    });

    expect(decoded.input.attachments?.[0]).toMatchObject({ [key]: value });
  });
});
