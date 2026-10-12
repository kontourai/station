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
import { createInterface } from 'node:readline';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import type { GetMessagesOptions } from '@voltagent/core';
import type { UIMessage } from 'ai';
import { createLogger } from '../../utils/logger.js';
import { parseReasoningFromMessage } from '../../utils/reasoning-parser.js';
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
 * A cross-process lock is still the wrong answer: it would hand-roll, over
 * NDJSON, what a database gives for free. When concurrent writers become a
 * supported shape (collaboration), the answer is a different adapter with
 * real transactions — see archive#2904 — not a lock protocol taped to this one.
 */
const messageFileMutations = new Map<string, Promise<unknown>>();

async function withMessagesFile<T>(
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = messageFileMutations.get(path) ?? Promise.resolve();
  // Chain off the settled tail: a rejected mutation must not poison the queue
  // for every later caller on this file.
  const next = previous.then(run, run);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  messageFileMutations.set(path, tail);
  try {
    return await next;
  } finally {
    // Release when still the tail, matching `persistConversation`'s
    // identity-guarded delete. Serialization is unaffected — a later caller
    // has already replaced the entry — and the map stops retaining one entry
    // per file mutated since boot, including for deleted conversations.
    if (messageFileMutations.get(path) === tail)
      messageFileMutations.delete(path);
  }
}

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
  flushDirectoryAfterCommit(path, 'rewrite');
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
  path: string,
  operation: 'rewrite' | 'append',
): void {
  try {
    fsyncDirectorySync(dirname(path));
  } catch (error) {
    logger.warn('Messages directory fsync failed after a committed write', {
      path,
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
 */
export interface TornTailRecovery {
  kind: 'completed' | 'quarantined';
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

/** The bytes after the last newline, or null when the file ends in one. */
async function findUnterminatedTail(
  handle: FileHandle,
  size: number,
): Promise<{ offset: number; bytes: Buffer } | null> {
  if (size === 0) return null;
  const last = await readExactly(handle, 1, size - 1);
  if (last[0] === NEWLINE) return null;

  const chunks: Buffer[] = [];
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - TAIL_SCAN_CHUNK_BYTES);
    const chunk = await readExactly(handle, end - start, start);
    const newline = chunk.lastIndexOf(NEWLINE);
    if (newline !== -1) {
      chunks.unshift(chunk.subarray(newline + 1));
      return { offset: start + newline + 1, bytes: Buffer.concat(chunks) };
    }
    chunks.unshift(chunk);
    end = start;
  }
  return { offset: 0, bytes: Buffer.concat(chunks) };
}

function isCompleteRecord(bytes: Buffer): boolean {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf-8'));
    return typeof value === 'object' && value !== null;
  } catch {
    return false;
  }
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
  handle: FileHandle,
  path: string,
  size: number,
): Promise<TornTailRecovery | null> {
  const tail = await findUnterminatedTail(handle, size);
  if (!tail) return null;

  if (isCompleteRecord(tail.bytes)) {
    // `a+` appends regardless of position, so this lands at the end.
    await handle.write('\n');
    return {
      kind: 'completed',
      path,
      offset: tail.offset,
      bytes: tail.bytes.length,
    };
  }

  // Move the fragment aside before truncating it away, and make the copy
  // durable first: a crash between the two then leaves the fragment in both
  // places (the next append quarantines it again), never in neither.
  const quarantinePath = tornRecordQuarantinePath(path);
  const quarantine = await open(quarantinePath, 'a');
  try {
    // The fragment holds no newline by construction, so one appended line
    // per recovery keeps the quarantine file line-framed.
    await quarantine.writeFile(Buffer.concat([tail.bytes, Buffer.from('\n')]));
    await quarantine.sync();
  } finally {
    await quarantine.close();
  }
  fsyncDirectorySync(dirname(quarantinePath));
  await handle.truncate(tail.offset);
  return {
    kind: 'quarantined',
    path,
    offset: tail.offset,
    bytes: tail.bytes.length,
    quarantinePath,
  };
}

/**
 * Append whole NDJSON records and flush them before returning (#3564).
 *
 * Runs inside the path's queue slot. The handle is opened `a+` so the tail
 * can be read and repaired through the same descriptor that appends.
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
  if (wasEmpty) flushDirectoryAfterCommit(path, 'append');
}

/** Read a messages file as its raw lines, preserving bytes exactly. */
async function readMessageLines(path: string): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
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
  await mkdir(paths.getSessionsDir(resourceId), { recursive: true });

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
  await mkdir(paths.getSessionsDir(resourceId), { recursive: true });

  const messagesPath = paths.getMessagesPath(resourceId, conversationId);
  const payload = `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
  await withMessagesFile(messagesPath, () =>
    appendMessageRecords(messagesPath, payload),
  );
  await touchConversation(conversationId);
}

export async function readStoredMessages({
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
}): Promise<UIMessage[]> {
  let resourceId = await resolveResourceId(conversationId, userId);
  let messagesPath = paths.getMessagesPath(resourceId, conversationId);

  if (!existsSync(messagesPath)) {
    const location = await findConversationLocation(conversationId);
    if (!location) {
      return [];
    }
    resourceId = location.resourceId;
    messagesPath = paths.getMessagesPath(resourceId, conversationId);
    if (!existsSync(messagesPath)) {
      return [];
    }
  }

  const messages: UIMessage[] = [];
  const fileStream = createReadStream(messagesPath, 'utf-8');
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as UIMessage);
    } catch (error) {
      logger.error('Failed to parse message', { error });
    }
  }

  if (options?.limit && messages.length > options.limit) {
    return messages.slice(-options.limit);
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
