import type { DelegationFileRefusalCode } from '@kontourai/station-contracts/attachment-staging';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_NAME_LENGTH,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  type ChatAttachmentInput,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';

const COPY: Record<DelegationFileRefusalCode, string> = {
  delegation_files_unsupported:
    'Attached files are unsupported for this delegation mode.',
  delegation_files_duplicate_name:
    'Delegation attachment names must be unique, ignoring case.',
  delegation_files_count: `A delegation can include at most ${CHAT_ATTACHMENT_MAX_COUNT} attachments.`,
  delegation_files_size: `Attachments must be nonempty, within the ${CHAT_ATTACHMENT_MAX_BYTES}-byte limit per file and the ${CHAT_ATTACHMENT_MAX_TOTAL_BYTES}-byte combined limit.`,
  delegation_files_invalid_name:
    'Delegation attachment name is unsafe or not portable.',
  delegation_files_invalid_data: 'Delegation attachment data is invalid.',
  delegation_files_ref_invalid:
    'Delegation attachment references are unavailable or invalid.',
  delegation_files_unavailable:
    'Delegation files could not be written to the workspace.',
  delegation_files_start_refused:
    'The delegation session was refused before dispatch. No attached files were kept.',
  delegation_files_turn_refused:
    'The delegation turn was refused before invocation. No attached files were kept.',
  delegation_files_outcome_unknown:
    'The delegation may have started. Attached files were retained; inspect the task before retrying.',
  delegation_files_cleanup_failed:
    'Delegation file cleanup failed. Inspect the workspace before retrying.',
};

export class DelegationFileRefusal extends Error {
  constructor(
    readonly code: DelegationFileRefusalCode,
    options?: ErrorOptions,
  ) {
    super(COPY[code], options);
    this.name = 'DelegationFileRefusal';
  }
}

/** Validate a whole batch before upload preparation or workspace writes. */
export function assertDelegationFileNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (
      !name ||
      name.length > CHAT_ATTACHMENT_MAX_NAME_LENGTH ||
      name !== name.trim() ||
      name === '.' ||
      name === '..' ||
      /[/\\<>:"|?*]|[. ]$/u.test(name) ||
      Array.from(name).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
    )
      throw new DelegationFileRefusal('delegation_files_invalid_name');
    const key = name.normalize('NFC').toLowerCase();
    if (seen.has(key))
      throw new DelegationFileRefusal('delegation_files_duplicate_name');
    seen.add(key);
  }
}

/** References and byte-bearing attachments share the same declared size bounds. */
export function assertDelegationFileSizes(
  files: readonly { size: number }[],
): void {
  if (
    files.some(
      ({ size }) =>
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > CHAT_ATTACHMENT_MAX_BYTES,
    ) ||
    files.reduce((sum, { size }) => sum + size, 0) >
      CHAT_ATTACHMENT_MAX_TOTAL_BYTES
  )
    throw new DelegationFileRefusal('delegation_files_size');
}

export function assertDelegationFileData(files: ChatAttachmentInput[]): void {
  if (files.length > CHAT_ATTACHMENT_MAX_COUNT)
    throw new DelegationFileRefusal('delegation_files_count');
  assertDelegationFileSizes(files);
  assertDelegationFileNames(files.map(({ name }) => name));
  if (!files.length)
    throw new DelegationFileRefusal('delegation_files_ref_invalid');
  if (validateChatAttachments(files))
    throw new DelegationFileRefusal('delegation_files_invalid_data');
}
