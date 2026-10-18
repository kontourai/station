import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ChatAttachmentInput,
  parseChatAttachmentDataUrl,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';

/** Route-owned staging authority; neither methods nor upload grants cross JSON. */
export interface DelegationStagedFiles {
  resolve(binding: {
    threadId: string;
    clientTurnId: string;
  }): ChatAttachmentInput[];
  accept(binding: { threadId: string; clientTurnId: string }): void;
}

/** Preserve bytes and basenames without overwriting any existing workspace file. */
export async function materializeDelegationFiles(
  cwd: string,
  attachments: ChatAttachmentInput[],
): Promise<string[]> {
  const error = validateChatAttachments(attachments);
  if (error) throw new Error(error);
  if (
    attachments.some(
      ({ name }) =>
        /[<>:"|?*]|[. ]$/u.test(name) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name),
    )
  )
    throw new Error('Delegation attachment name is not portable.');
  if (!attachments.length) throw new Error('Delegation files are missing.');
  // A fresh directory directly under the resolved workspace avoids traversing
  // caller-named subdirectories or following an existing attachment symlink.
  const directory = await mkdtemp(
    join(await realpath(cwd), '.station-delegate-'),
  );
  try {
    const paths: string[] = [];
    for (const attachment of attachments) {
      const parsed = parseChatAttachmentDataUrl(attachment.dataUrl)!;
      const path = join(directory, attachment.name);
      await writeFile(path, Buffer.from(parsed.base64, 'base64'), {
        flag: 'wx',
        mode: 0o600,
      });
      paths.push(path);
    }
    return paths;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
