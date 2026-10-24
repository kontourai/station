import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  type FileHandle,
  mkdir,
  open,
  rename,
  rm,
  truncate,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES } from '@kontourai/station-contracts/chat-attachment';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import type { GetMessagesOptions } from '@voltagent/core';
import type { UIMessage } from 'ai';
import { transcriptTailRecoveries } from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';
import { readNdjsonLines } from '../../utils/ndjson-lines.js';
import { parseReasoningFromMessage } from '../../utils/reasoning-parser.js';
import { withFileMutation } from './memory-adapter-mutation-queue.js';
import { MemoryAdapterPaths } from './memory-adapter-paths.js';

interface UIMessageWithMetadata extends UIMessage {
  metadata?: Record<string, any>;
}

const logger = createLogger({ name: 'memory-adapter-messages' });

/**
 * Serializes every mutation of one messages file (archive#2252).
 *
 * The transcript is an append log, and appends are safe on their own. The
 * hazard is the two DESTRUCTIVE operations — delete-by-id and remove-last —
 * which are read-modify-write over the whole file: a message appended between
 * their read and their write is silently destroyed. Nothing coordinated them,
 * so a delete landing while a response streamed could drop the streamed
 * message.
 *
 * Keyed by absolute path and held at module scope ON PURPOSE. Six call sites
 * construct their own `FileMemoryAdapter`, so a per-instance queue would leave
 * two adapters in the same process free to interleave on the same file.
 *
 * Scope is deliberately IN-PROCESS, and the honest version of why:
 *
 * Station's SUPPORTED shape is one server per home. Every adapter
 * construction is server-side and the CLI reaches memory over HTTP, so there
 * is no non-server writer. That rules out a second WRITER, not a second
 * SERVER — and nothing enforces one: `station start` conflict-checks ports
 * only, never the home, so two instances started without `--temp-home` share
 * `~/.station` and can still lose an update between them. This queue does not
 * fix that and does not claim to.
 *
 * Nor is the multi-instance case uniformly improved — an earlier draft said
 * "strictly better" and that is disprovable. Publishing by rename replaces
 * the inode, so a second process that opened the path before the rename
 * writes into the now-unlinked inode and its append is lost; in-place
 * `writeFile` truncated the SAME inode, so that append survived. What temp+
 * rename removes across processes is the torn-READ window. It trades one
 * narrow lost-append ordering for another, and neither is addressed here.
 *
 * Torn-tail repair (#3564) adds a third multi-process loss that did not
 * exist before it. Plain O_APPEND appends from two processes never removed a
 * complete line; the repair can. If process B finds an unterminated tail and
 * process A then appends and fsyncs record X, B's truncate to the stale
 * offset deletes X. B can also see A's in-flight append (Node writes large
 * payloads in pieces) as a torn tail and quarantine it. Both need a second
 * server on the same home, the unsupported shape above. A lock around the
 * repair alone would not close it, because ordinary appends do not take that
 * lock. Locking every append is the per-message cross-process lock rejected
 * below.
 *
 * A cross-process lock is still the wrong answer: it would hand-roll, over
 * NDJSON, what a database gives for free. When concurrent writers become a
 * supported shape (collaboration), the answer is a different adapter with
 * real transactions — see archive#2904 — not a lock protocol taped to this one.
 */
const withMessagesFile = withFileMutation;

/**
 * Publish a whole messages file without a truncate-then-write window.
 *
 * `writeFile(path)` truncates in place, so a crash mid-write leaves a
 * half-written transcript. This mirrors what `persistConversation` already
 * does for the conversation document next door: readers see either the
 * previous complete file or this one.
 *
 * The temporary's data is flushed before the rename (#3564): otherwise a
 * power loss can persist the rename and not the bytes, publishing an empty
 * or partial transcript. The directory is flushed after it so the rename
 * itself survives. Both follow the shared JSON publisher's sequence; that
 * seam serializes a JSON value, while this file is NDJSON text.
 */
async function writeMessagesFileAtomic(
  path: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, 'wx');
    try {
      await handle.writeFile(contents, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  flushDirectoryAfterCommit(dirname(path), 'rewrite');
}

/**
 * Flush the directory entry of a write that has already committed.
 *
 * Readers already see the bytes, so a failed directory flush must not report
 * the write as failed: a caller retrying an append would duplicate the
 * message, and one retrying a delete-by-id would act on a state it believes
 * unchanged. The failure is disclosed instead (the shared JSON publisher
 * swallows it silently).
 */
function flushDirectoryAfterCommit(
  directory: string,
  operation: 'rewrite' | 'append' | 'create',
): void {
  try {
    fsyncDirectorySync(directory);
  } catch (error) {
    logger.warn('Messages directory fsync failed after a committed write', {
      directory,
      operation,
      error,
    });
  }
}

/**
 * What an append found and did about an unterminated last record.
 *
 * - `completed`: the tail parsed as JSON, so only its newline was lost. The
 *   newline is written and the record kept.
 * - `quarantined`: the tail is a fragment. Its bytes are appended, verbatim
 *   and newline-terminated, to `quarantinePath`, and the transcript is
 *   truncated back to its last complete line.
 * - `observed`: a read found a tail that is a fragment. Nothing on disk
 *   changed; the reader skipped the fragment, and the next append quarantines
 *   it. Reported so a torn transcript is visible before that append happens.
 */
export interface TornTailRecovery {
  kind: 'completed' | 'quarantined' | 'observed';
  path: string;
  /** Byte offset where the unterminated record starts. */
  offset: number;
  /** Length of the unterminated record in bytes. */
  bytes: number;
  quarantinePath?: string;
}

/**
 * Where an append moves an unparseable torn tail. It sits beside the
 * transcript without the `.ndjson` suffix, so transcript scans (the usage
 * aggregator's) skip it, and it is removed with the conversation.
 */
export function tornRecordQuarantinePath(messagesPath: string): string {
  return `${messagesPath}.torn`;
}

const NEWLINE = 0x0a;
const TAIL_SCAN_CHUNK_BYTES = 64 * 1024;
/**
 * The largest unterminated tail parsed to see whether only its newline was
 * lost. It is twice the largest chat command body Station accepts, which
 * already counts base64-inlined attachments, so every record Station can
 * write fits with room for stored metadata. The read path parses records
 * whole, so this bounds nothing the reader does not already hold in memory.
 *
 * A longer tail is quarantined unparsed. Its bytes survive in `.torn`, but
 * nothing reads `.torn`, so such a record would leave the transcript.
 */
export const MAX_COMPLETABLE_TAIL_BYTES =
  2 * CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES;

async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  // The file is only mutated inside this path's queue slot, so a short read
  // means another process changed it underneath us. Refuse rather than
  // repair from a view that is already stale.
  if (bytesRead !== length) {
    throw new Error(
      `Messages file changed during torn-tail scan (read ${bytesRead} of ${length} bytes at ${position}).`,
    );
  }
  return buffer;
}

/**
 * Offset of the first byte after the last newline, or null when the file
 * ends in one. Scans backwards a chunk at a time and keeps no chunk, so
 * memory stays bounded however long the unterminated tail is.
 */
async function findUnterminatedTailOffset(
  handle: FileHandle,
  size: number,
): Promise<number | null> {
  if (size === 0) return null;
  const last = await readExactly(handle, 1, size - 1);
  if (last[0] === NEWLINE) return null;

  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - TAIL_SCAN_CHUNK_BYTES);
    const chunk = await readExactly(handle, end - start, start);
    const newline = chunk.lastIndexOf(NEWLINE);
    if (newline !== -1) return start + newline + 1;
    end = start;
  }
  return 0;
}

async function tailIsCompleteRecord(
  handle: FileHandle,
  offset: number,
  size: number,
): Promise<boolean> {
  if (size - offset > MAX_COMPLETABLE_TAIL_BYTES) return false;
  const bytes = await readExactly(handle, size - offset, offset);
  try {
    const value: unknown = JSON.parse(bytes.toString('utf-8'));
    return typeof value === 'object' && value !== null;
  } catch {
    return false;
  }
}

/**
 * Append transcript bytes `[offset, size)` to the quarantine file as one
 * newline-terminated line, copied a chunk at a time, then flush the file and
 * its directory. The fragment holds no newline by construction, so the
 * quarantine file stays line-framed across recoveries.
 */
async function quarantineTail(
  source: FileHandle,
  quarantinePath: string,
  offset: number,
  size: number,
): Promise<void> {
  const quarantine = await open(quarantinePath, 'a');
  try {
    for (let position = offset; position < size; ) {
      const length = Math.min(TAIL_SCAN_CHUNK_BYTES, size - position);
      await quarantine.writeFile(await readExactly(source, length, position));
      position += length;
    }
    await quarantine.writeFile('\n');
    await quarantine.sync();
  } finally {
    await quarantine.close();
  }
  fsyncDirectorySync(dirname(quarantinePath));
}

/**
 * Make the transcript end on a line boundary before anything is appended.
 *
 * Every append writes `record + "\n"`, so an interrupted append (a crash,
 * power loss or ENOSPC mid-write) leaves a prefix of one record with no
 * newline. Appending straight after it glues the next record onto the
 * fragment, and the reader then drops the merged line: one torn write cost
 * two messages (#3564). Repairing here means a torn write costs at most the
 * record that was being written.
 */
async function repairTornTail(
  appendHandle: FileHandle,
  path: string,
  size: number,
): Promise<TornTailRecovery | null> {
  const offset = await findUnterminatedTailOffset(appendHandle, size);
  if (offset === null) return null;
  const bytes = size - offset;

  if (await tailIsCompleteRecord(appendHandle, offset, size)) {
    // O_APPEND places this at the end. It is flushed with the payload.
    await appendHandle.write('\n');
    return { kind: 'completed', path, offset, bytes };
  }

  // Copy the fragment aside, durably, before truncating it away: a crash
  // between the two leaves it in both places (the next append quarantines it
  // again), never in neither.
  const quarantinePath = tornRecordQuarantinePath(path);
  await quarantineTail(appendHandle, quarantinePath, offset, size);

  // Truncate through a separate read-write descriptor, never the append one.
  // On Windows libuv opens O_APPEND without FILE_WRITE_DATA, which truncation
  // (SetEndOfFile) requires, so truncating the append handle would fail there
  // after every quarantine and refuse each later append. The truncation is
  // flushed on the descriptor that made it.
  const repair = await open(path, 'r+');
  try {
    await repair.truncate(offset);
    await repair.sync();
  } finally {
    await repair.close();
  }
  return { kind: 'quarantined', path, offset, bytes, quarantinePath };
}

/**
 * Append whole NDJSON records and flush them before returning (#3564).
 *
 * Runs inside the path's queue slot. The append itself goes through an
 * O_APPEND descriptor (`a+`, readable for the tail scan), so an ordinary
 * append never positions a write and cannot overwrite another writer's
 * line. It is flushed on that same descriptor.
 */
async function appendMessageRecords(
  path: string,
  payload: string,
): Promise<void> {
  const handle = await open(path, 'a+');
  let wasEmpty = false;
  try {
    const { size } = await handle.stat();
    wasEmpty = size === 0;
    const recovery = await repairTornTail(handle, path, size);
    if (recovery) {
      transcriptTailRecoveries.add(1, { kind: recovery.kind });
      logger.warn('Recovered an unterminated record in a messages file', {
        recovery,
      });
    }
    await handle.appendFile(payload, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // An empty file is usually one this open just created, and a new file's
  // directory entry is not durable until the directory is flushed. A file
  // emptied by `clearMessages` pays one redundant directory flush.
  if (wasEmpty) flushDirectoryAfterCommit(dirname(path), 'append');
}

/**
 * `mkdir -p` the sessions directory and make every directory it created
 * durable. Each new directory's entry lives in its parent, so the parents are
 * flushed from the sessions directory's own parent up to the parent of the
 * first directory created. The sessions directory's entry for the transcript
 * is flushed by the first append.
 */
async function ensureSessionsDirectory(directory: string): Promise<void> {
  const firstCreated = await mkdir(directory, { recursive: true });
  if (firstCreated === undefined) return;
  const stop = dirname(firstCreated);
  for (let current = dirname(directory); ; current = dirname(current)) {
    flushDirectoryAfterCommit(current, 'create');
    if (current === stop || dirname(current) === current) break;
  }
}

/**
 * Read a messages file as its raw lines, preserving bytes exactly. Split on
 * `\n` only: a readline split at a raw U+2028/U+2029 inside a message would
 * rewrite that character as a newline and tear the record in two.
 */
async function readMessageLines(path: string): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readNdjsonLines(createReadStream(path))) {
    if (line.trim()) lines.push(line);
  }
  return lines;
}

function serializeMessageLines(lines: string[]): string {
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

export async function addStoredMessage({
  paths,
  resolveResourceId,
  touchConversation,
  usageAggregator,
  message,
  userId,
  conversationId,
  context,
}: {
  paths: MemoryAdapterPaths;
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
  touchConversation(conversationId: string): Promise<void>;
  usageAggregator?: any;
  message: UIMessage;
  userId: string;
  conversationId: string;
  context?: any;
}): Promise<void> {
  const resourceId = await resolveResourceId(conversationId, userId);
  await ensureSessionsDirectory(paths.getSessionsDir(resourceId));

  const parsedMessage = parseReasoningFromMessage(message);
  const metadata = (parsedMessage as UIMessageWithMetadata).metadata;
  const messageWithMetadata: UIMessageWithMetadata = {
    ...parsedMessage,
    metadata: {
      ...metadata,
      timestamp: context?.suppressUsageAggregation
        ? metadata?.timestamp
        : (metadata?.timestamp ?? Date.now()),
      modelMetadata: context?.modelMetadata,
      usage: context?.usage,
      model: context?.model,
      traceId: context?.traceId,
    },
  };

  const abortController = context?.abortController;
  if (
    abortController?.signal.aborted &&
    messageWithMetadata.role === 'assistant'
  ) {
    messageWithMetadata.parts = [
      ...messageWithMetadata.parts,
      { type: 'text', text: '\n\n---\n\n_⚠️ Response cancelled by user_' },
    ];
  }

  const messagesPath = paths.getMessagesPath(resourceId, conversationId);
  await withMessagesFile(messagesPath, () =>
    appendMessageRecords(
      messagesPath,
      `${JSON.stringify(messageWithMetadata)}\n`,
    ),
  );
  await touchConversation(conversationId);

  if (
    usageAggregator &&
    !context?.suppressUsageAggregation &&
    messageWithMetadata.role === 'assistant'
  ) {
    try {
      await usageAggregator.incrementalUpdate(
        messageWithMetadata,
        resourceId,
        conversationId,
      );
    } catch (error) {
      logger.error('Failed to update usage stats', { error });
    }
  }
}

export async function addStoredMessages({
  paths,
  resolveResourceId,
  touchConversation,
  messages,
  userId,
  conversationId,
}: {
  paths: MemoryAdapterPaths;
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
  touchConversation(conversationId: string): Promise<void>;
  messages: UIMessage[];
  userId: string;
  conversationId: string;
}): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const resourceId = await resolveResourceId(conversationId, userId);
  await ensureSessionsDirectory(paths.getSessionsDir(resourceId));

  const messagesPath = paths.getMessagesPath(resourceId, conversationId);
  const payload = `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
  await withMessagesFile(messagesPath, () =>
    appendMessageRecords(messagesPath, payload),
  );
  await touchConversation(conversationId);
}

/**
 * Re-examine a transcript's tail inside the path's queue slot.
 *
 * The reader streams without the queue, so a fragment it parsed last may be
 * an append still being written (Node writes large payloads in pieces).
 * Queuing behind every in-flight mutation and then looking at the file as it
 * is NOW separates a torn tail from a write in progress. Reports only a
 * fragment: a tail that is a whole record missing its newline is read fine
 * and is completed by the next append.
 */
async function observeTornTail(path: string): Promise<TornTailRecovery | null> {
  return withMessagesFile(path, async () => {
    // The check is diagnostic, so nothing it hits may fail the read it
    // follows. Another process truncating or removing the file mid-check
    // surfaces here as a short read (`readExactly`) or an fs error.
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, 'r');
      const { size } = await handle.stat();
      const offset = await findUnterminatedTailOffset(handle, size);
      if (offset === null) return null;
      if (await tailIsCompleteRecord(handle, offset, size)) return null;
      return { kind: 'observed', path, offset, bytes: size - offset };
    } catch (error) {
      logger.debug('Skipped the torn-tail check of a transcript', { error });
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  });
}

/**
 * Read a transcript and, separately, report whether it ends in a torn
 * fragment (#3564). VoltAgent's `getMessages` returns only messages, so the
 * recovery travels beside them here and `readStoredMessages` hands it to
 * telemetry.
 */
async function readStoredMessagesWithRecovery({
  paths,
  resolveResourceId,
  findConversationLocation,
  userId,
  conversationId,
  options,
}: {
  paths: MemoryAdapterPaths;
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
  findConversationLocation(
    conversationId: string,
  ): Promise<{ path: string; resourceId: string } | null>;
  userId: string;
  conversationId: string;
  options?: GetMessagesOptions;
}): Promise<{ messages: UIMessage[]; recovery: TornTailRecovery | null }> {
  let resourceId = await resolveResourceId(conversationId, userId);
  let messagesPath = paths.getMessagesPath(resourceId, conversationId);

  if (!existsSync(messagesPath)) {
    const location = await findConversationLocation(conversationId);
    if (!location) {
      return { messages: [], recovery: null };
    }
    resourceId = location.resourceId;
    messagesPath = paths.getMessagesPath(resourceId, conversationId);
    if (!existsSync(messagesPath)) {
      return { messages: [], recovery: null };
    }
  }

  const messages: UIMessage[] = [];
  const fileStream = createReadStream(messagesPath, 'utf-8');

  // Whether the LAST non-empty line failed to parse. Only then can the file
  // end in a torn fragment, so only then is the tail re-examined.
  let lastLineUnparseable = false;
  for await (const line of readNdjsonLines(fileStream)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as UIMessage);
      lastLineUnparseable = false;
    } catch (error) {
      lastLineUnparseable = true;
      logger.error('Failed to parse message', { error });
    }
  }

  const recovery = lastLineUnparseable
    ? await observeTornTail(messagesPath)
    : null;

  const limited =
    options?.limit && messages.length > options.limit
      ? messages.slice(-options.limit)
      : messages;
  return { messages: limited, recovery };
}

export async function readStoredMessages(
  params: Parameters<typeof readStoredMessagesWithRecovery>[0],
): Promise<UIMessage[]> {
  const { messages, recovery } = await readStoredMessagesWithRecovery(params);
  if (recovery) {
    transcriptTailRecoveries.add(1, { kind: recovery.kind });
    logger.warn('Found an unterminated fragment at the end of a transcript', {
      recovery,
    });
  }
  return messages;
}

export async function clearStoredMessages({
  paths,
  resolveResourceId,
  getConversationsByUserId,
  userId,
  conversationId,
}: {
  paths: MemoryAdapterPaths;
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
  getConversationsByUserId(
    userId: string,
  ): Promise<Array<{ id: string; resourceId: string }>>;
  userId: string;
  conversationId?: string;
}): Promise<void> {
  if (conversationId) {
    const resourceId = await resolveResourceId(conversationId, userId);
    const path = paths.getMessagesPath(resourceId, conversationId);
    if (existsSync(path)) {
      await withMessagesFile(path, () => truncate(path, 0));
    }
    return;
  }

  const conversations = await getConversationsByUserId(userId);
  await Promise.all(
    conversations.map(async (conversation) => {
      const path = paths.getMessagesPath(
        conversation.resourceId,
        conversation.id,
      );
      if (existsSync(path)) {
        await withMessagesFile(path, () => truncate(path, 0));
      }
    }),
  );
}

export async function removeLastStoredMessage({
  paths,
  resolveResourceId,
  userId,
  conversationId,
}: {
  paths: MemoryAdapterPaths;
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
  userId: string;
  conversationId: string;
}): Promise<void> {
  const resourceId = await resolveResourceId(conversationId, userId);
  const path = paths.getMessagesPath(resourceId, conversationId);

  if (!existsSync(path)) {
    return;
  }

  await withMessagesFile(path, async () => {
    // Re-read INSIDE the queue slot: a snapshot taken before this call was
    // queued could be stale by the time the write lands, which is the
    // read-modify-write hazard this serialization exists to close.
    const lines = await readMessageLines(path);
    if (lines.length === 0) return;
    lines.pop();
    await writeMessagesFileAtomic(path, serializeMessageLines(lines));
  });
}

/**
 * Delete messages by id (archive#2252).
 *
 * Moved here from `FileMemoryAdapter` so that every mutation THROUGH THIS
 * MODULE goes through the one serialized, atomic seam. Other paths remove the
 * file from outside it — `deleteConversationAssets`'s `unlink`, the
 * agent-directory removals in `config-loader-agents.ts` and
 * `plugin-install-transaction.ts`, and out-of-process `station clean` — so a
 * delete landing between a queued
 * rewrite's read and its rename can still resurrect an orphan transcript.
 * That race predates this change (`writeFile` recreated the file too) and is
 * not closed here; it is named so the seam is not mistaken for total.
 *
 * Three things changed with the move, all correctness:
 *
 * - It reads RAW LINES instead of going through `readStoredMessages`. That
 *   reader drops any line it cannot parse (logging and continuing) and honours
 *   an `options.limit`, so rewriting from its output would silently discard
 *   corrupt lines — and, if a limit were ever passed, everything outside it.
 *   Keeping the original line text also means untouched messages are written
 *   back byte-identical rather than re-serialized.
 * - The read happens inside the queue slot, so a concurrent append cannot be
 *   lost between the read and the write.
 * - If the file disappears between the pre-queue `existsSync` and the queued
 *   slot, this now REJECTS with ENOENT where the old path resolved (its read
 *   returned `[]`, and it then recreated an empty file). Rejecting is the
 *   better answer — silently recreating a transcript for a conversation
 *   something just deleted is worse — but it is caller-visible, so it is
 *   stated rather than left to be discovered.
 */
export async function deleteStoredMessages({
  paths,
  resolveResourceId,
  touchConversation,
  messageIds,
  userId,
  conversationId,
}: {
  paths: MemoryAdapterPaths;
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
  touchConversation(conversationId: string): Promise<void>;
  messageIds: string[];
  userId: string;
  conversationId: string;
}): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }

  const resourceId = await resolveResourceId(conversationId, userId);
  const path = paths.getMessagesPath(resourceId, conversationId);
  if (!existsSync(path)) {
    return;
  }

  const doomed = new Set(messageIds.map((id) => String(id)));
  await withMessagesFile(path, async () => {
    const lines = await readMessageLines(path);
    const remaining = lines.filter((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Unparseable line: keep it. A delete-by-id must not double as a
        // corruption sweep — that would turn one bad byte into silent data
        // loss for messages nobody asked to remove.
        return true;
      }
      const id = (parsed as { id?: unknown })?.id;
      return !doomed.has(String(id));
    });
    if (remaining.length === lines.length) {
      return;
    }
    await writeMessagesFileAtomic(path, serializeMessageLines(remaining));
  });

  await touchConversation(conversationId);
}
