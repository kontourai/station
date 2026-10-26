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

  // Rows written while hydration leaked the composer handle are already on
  // disk; their digests cover those bytes, so they must keep decoding.
  test('an envelope retained with the leaked composer handle still decodes', () => {
    const capture = captureTurnIntent(
      {
        threadId: 'thread-1',
        input: 'see attached',
        attachments: [
          {
            clientAttachmentId: 'client-attachment-1',
            kind: 'file',
            name: 'note.txt',
            mimeType: 'text/plain',
            size: 5,
            dataUrl: DATA,
          } as never,
        ],
      },
      resumeGuard,
    );

    expect(capture.envelopeJson).toContain('clientAttachmentId');
    expect(() => decodeTurnIntent(retainedRow(capture))).not.toThrow();
  });
});
