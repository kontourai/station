import { createHash } from 'node:crypto';
import {
  type ConversationImportMessageV1,
  type ConversationImportRequestV1,
  PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES,
  PEER_CONVERSATION_HANDOFF_MAX_MESSAGES,
  PEER_CONVERSATION_HANDOFF_MAX_TEXT_BYTES,
} from '@kontourai/station-contracts/peer-chat';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { z } from 'zod';
import { transcriptSeedSource } from '../orchestration/conversation-transcript-seed.js';

/**
 * Continuing a conversation on a paired Station (`PeerConversationHandoff*`
 * in the peer-chat contract). The source carries text history only, under the
 * contract's bounds; the receiver saves it as a fork context. No file, tool
 * output or attachment crosses.
 */

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Keep the head and tail of `text` within `maxBytes`, with a visible marker between. */
function cutMiddle(text: string, maxBytes: number): string {
  const characters = [...text];
  const marker = (left: number) =>
    `\n[… ${left} characters left out of this message …]\n`;
  // The marker's widest form: every character left out.
  const budget = maxBytes - utf8Bytes(marker(characters.length));
  let headBytes = 0;
  let head = 0;
  while (
    head < characters.length &&
    headBytes + utf8Bytes(characters[head]!) <= budget / 2
  ) {
    headBytes += utf8Bytes(characters[head]!);
    head += 1;
  }
  let tailBytes = 0;
  let tail = characters.length;
  while (
    tail > head &&
    headBytes + tailBytes + utf8Bytes(characters[tail - 1]!) <= budget
  ) {
    tailBytes += utf8Bytes(characters[tail - 1]!);
    tail -= 1;
  }
  return `${characters.slice(0, head).join('')}${marker(tail - head)}${characters.slice(tail).join('')}`;
}

/**
 * The messages the source carries, newest first under the contract bounds.
 * Each message's text is exactly what the Agent/engine handoff's transcript
 * seed reads from it (`transcriptSeedSource`): user and assistant text, no
 * reasoning, tool rows or runtime errors. Older messages that do not fit are
 * left out and counted, never silently dropped.
 */
export function boundCarriedMessages(
  messages: readonly ConversationMessage[],
): {
  messages: ConversationImportMessageV1[];
  omittedMessages: number;
  nonTextMessages: number;
  shortenedMessages: number;
} {
  const projected: ConversationImportMessageV1[] = [];
  let nonTextMessages = 0;
  messages.forEach((message, index) => {
    const source = transcriptSeedSource([message]);
    nonTextMessages += source.nonTextMessages;
    const entry = source.entries[0];
    if (!entry) return;
    projected.push({
      id:
        typeof message.id === 'string' && message.id.length <= 256
          ? message.id
          : `carried:${createHash('sha256')
              .update(`${index}\0${entry.text}`)
              .digest('hex')}`,
      role: entry.role,
      text: entry.text,
    });
  });
  const kept: ConversationImportMessageV1[] = [];
  let bytes = 0;
  let shortenedMessages = 0;
  for (
    let index = projected.length - 1;
    index >= 0 && kept.length < PEER_CONVERSATION_HANDOFF_MAX_MESSAGES;
    index--
  ) {
    const message = projected[index]!;
    const shortened =
      utf8Bytes(message.text) > PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES;
    const text = shortened
      ? cutMiddle(message.text, PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES)
      : message.text;
    const size = utf8Bytes(text);
    if (bytes + size > PEER_CONVERSATION_HANDOFF_MAX_TEXT_BYTES) break;
    bytes += size;
    if (shortened) shortenedMessages += 1;
    kept.unshift({ ...message, text });
  }
  return {
    messages: kept,
    omittedMessages: projected.length - kept.length,
    nonTextMessages,
    shortenedMessages,
  };
}

const count = z.number().int().min(0).max(1_000_000);
const label = z.string().min(1).max(200);

/**
 * The receiver's parse of an import. Every bound is checked by reading one
 * past it and refusing: an oversized body is rejected, never truncated here.
 */
export const conversationImportRequestSchema: z.ZodType<ConversationImportRequestV1> =
  z
    .object({
      version: z.literal(1),
      idempotencyKey: z.string().min(1).max(128),
      source: z
        .object({
          environmentId: label,
          stationName: z.string().min(1).max(120),
          conversationId: z.string().min(1).max(256),
          title: z.string().max(500),
          agent: z.string().min(1).max(64),
        })
        .strict(),
      projectSlug: z.string().min(1).max(512).optional(),
      messages: z
        .array(
          z
            .object({
              id: z.string().min(1).max(256),
              role: z.enum(['user', 'assistant']),
              text: z
                .string()
                .min(1)
                .refine(
                  (text) =>
                    utf8Bytes(text) <=
                    PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES,
                  'A carried message exceeds its byte bound.',
                ),
            })
            .strict(),
        )
        .min(1)
        .max(PEER_CONVERSATION_HANDOFF_MAX_MESSAGES)
        .refine(
          (messages) =>
            messages.reduce(
              (total, message) => total + utf8Bytes(message.text),
              0,
            ) <= PEER_CONVERSATION_HANDOFF_MAX_TEXT_BYTES,
          'Carried history exceeds its byte bound.',
        )
        .refine(
          (messages) =>
            new Set(messages.map((message) => message.id)).size ===
            messages.length,
          'Carried message ids must be unique.',
        ),
      omittedMessages: count,
      nonTextMessages: count,
      shortenedMessages: count,
    })
    .strict();

/** The browser's request to its own Station (`PeerConversationHandoffRequestV1`). */
export const peerConversationHandoffRequestSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(256),
    targetAgent: z.string().min(1).max(64),
    projectSlug: z.string().min(1).max(512).optional(),
  })
  .strict();

/**
 * The fork-context source identity of an imported conversation. It names the
 * other Station, so it can never collide with a conversation of this one.
 */
export function importedSourceConversationId(
  source: ConversationImportRequestV1['source'],
): string {
  return `station:${createHash('sha256')
    .update(JSON.stringify([source.environmentId, source.conversationId]))
    .digest('hex')}`;
}

/** Carried messages as conversation messages a fork context copies. */
export function importedConversationMessages(
  request: ConversationImportRequestV1,
): ConversationMessage[] {
  return request.messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: [{ type: 'text', text: message.text }],
  }));
}
