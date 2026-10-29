import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
} from '@kontourai/station-contracts/chat-attachment';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { materializeDelegationFiles } from '../delegation-files.js';

const temporary = trackTempDirs();
const file = (
  name: string,
  bytes = Buffer.from('exact'),
): ChatAttachmentInput => ({
  kind: 'file',
  name,
  mimeType: 'text/plain',
  size: bytes.length,
  dataUrl: `data:text/plain;base64,${bytes.toString('base64')}`,
});

describe('delegation workspace materializer independent of staging', () => {
  test.each(['../outside.txt', '/outside.txt', '..', 'folder\\outside.txt'])(
    'refuses unsafe path %s before touching the filesystem',
    async (name) => {
      const root = temporary('delegate-path-');
      await expect(
        materializeDelegationFiles(join(root, 'absent'), [file(name)]),
      ).rejects.toMatchObject({ code: 'delegation_files_invalid_name' });
      expect(await readdir(root)).toEqual([]);
    },
  );

  test('refuses case-only duplicate names before resolving a workspace or writing files', async () => {
    const root = temporary('delegate-duplicates-');
    await expect(
      materializeDelegationFiles(join(root, 'absent'), [
        file('A.txt'),
        file('a.txt'),
      ]),
    ).rejects.toMatchObject({ code: 'delegation_files_duplicate_name' });
    expect(await readdir(root)).toEqual([]);
  });

  test('refuses actual combined bytes max+1 independently of CLI and staging limits', async () => {
    const root = temporary('delegate-size-');
    const large = Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES, 97);
    const attachments = [
      file('one.txt', large),
      file('two.txt', large),
      file('three.txt', large),
      file('four.txt', Buffer.from('a')),
    ];
    expect(attachments.reduce((sum, value) => sum + value.size, 0)).toBe(
      CHAT_ATTACHMENT_MAX_TOTAL_BYTES + 1,
    );
    await expect(
      materializeDelegationFiles(root, attachments),
    ).rejects.toMatchObject({ code: 'delegation_files_size' });
    expect(await readdir(root)).toEqual([]);
  });

  test('writes distinct safe files and exposes cleanup of only its owned directory', async () => {
    const root = temporary('delegate-materialize-');
    await mkdir(join(root, 'existing'));
    const result = await materializeDelegationFiles(root, [
      file('one.txt'),
      file('two.txt'),
    ]);
    expect(
      await Promise.all(result.paths.map((path) => readFile(path, 'utf8'))),
    ).toEqual(['exact', 'exact']);
    await result.remove();
    expect(await readdir(root)).toEqual(['existing']);
  });

  test('filesystem failures have a coded public refusal without an internal path', async () => {
    const root = temporary('delegate-unavailable-');
    await expect(
      materializeDelegationFiles(join(root, 'absent'), [file('one.txt')]),
    ).rejects.toMatchObject({
      code: 'delegation_files_unavailable',
      message: 'Delegation files could not be written to the workspace.',
    });
  });
});
