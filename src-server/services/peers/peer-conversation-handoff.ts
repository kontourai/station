import { createHash } from 'node:crypto';
import {
  type ConversationImportMessageV1,
  type ConversationImportRequestV1,
  PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES,
  PEER_CONVERSATION_HANDOFF_MAX_MESSAGES,
  PEER_CONVERSATION_HANDOFF_MAX_REQUEST_BYTES,
  PEER_CONVERSATION_HANDOFF_MAX_TEXT_BYTES,
} from '@kontourai/station-contracts/peer-chat';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { z } from 'zod';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { conversationMessageText } from '../orchestration/conversation-transcript-seed.js';
import {
  boundLabelKeepingTail,
  cleanLabel,
} from '../orchestration/quoted-text.js';

/**
 * Continuing a conversation on a paired Station (`PeerConversationHandoff*`
 * in the peer-chat contract). The source carries text history only, under the
 * contract's bounds; the receiver saves it as a fork context. No file, tool
 * output or attachment crosses.
 */

/**
 * Bytes `text` takes inside a JSON string on the wire: control characters,
 * quotes and backslashes are escaped, so this can be up to six times its
 * UTF-8 size. Every bound here counts this, never the decoded size.
 */
export function encodedTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/** Keep the head and tail of `text` within `maxBytes` encoded, with a visible marker between. */
function cutMiddle(text: string, maxBytes: number): string {
  const characters = [...text];
  const marker = (left: number) =>
    `\n[… ${left} characters left out of this message …]\n`;
  // The marker's widest form: every character left out.
  const budget = maxBytes - encodedTextBytes(marker(characters.length));
  let headBytes = 0;
  let head = 0;
  while (
    head < characters.length &&
    headBytes + encodedTextBytes(characters[head]!) <= budget / 2
  ) {
    headBytes += encodedTextBytes(characters[head]!);
    head += 1;
  }
  let tailBytes = 0;
  let tail = characters.length;
  while (
    tail > head &&
    headBytes + tailBytes + encodedTextBytes(characters[tail - 1]!) <= budget
  ) {
    tailBytes += encodedTextBytes(characters[tail - 1]!);
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
    // The row's own text, never a seed's quoted rendering of it: the receiver
    // quotes rows it imports, so carrying them quoted would quote them twice.
    const text = conversationMessageText(message);
    if (text === undefined) return;
    if (!text) {
      nonTextMessages += 1;
      return;
    }
    // Earlier hops are the sender's claim; any cut keeps the verified last.
    const importedFrom =
      typeof message.metadata?.importedFrom === 'string'
        ? boundLabelKeepingTail(
            cleanLabel(message.metadata.importedFrom),
            (label) => [...label].length <= 120,
          )
        : undefined;
    projected.push({
      id:
        typeof message.id === 'string' && message.id.length <= 256
          ? message.id
          : `carried:${createHash('sha256')
              .update(`${index}\0${text}`)
              .digest('hex')}`,
      role: message.role as 'user' | 'assistant',
      text,
      ...(importedFrom && importedFrom !== '…' ? { importedFrom } : {}),
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
      encodedTextBytes(message.text) >
      PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES;
    const text = shortened
      ? cutMiddle(message.text, PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES)
      : message.text;
    const size = encodedTextBytes(text);
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

/**
 * The import request as sent, or `null` when its encoding is one byte or more
 * over {@link PEER_CONVERSATION_HANDOFF_MAX_REQUEST_BYTES}: the sender refuses
 * it rather than send something the receiver's body ceiling would reject.
 */
export function encodeImportRequest(
  request: ConversationImportRequestV1,
  maxBytes = PEER_CONVERSATION_HANDOFF_MAX_REQUEST_BYTES,
): string | null {
  const body = JSON.stringify(request);
  return Buffer.byteLength(body, 'utf8') > maxBytes ? null : body;
}

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
              importedFrom: z
                .string()
                .max(120)
                .transform(cleanLabel)
                .refine(
                  (label) => label.length > 0,
                  'An origin must name something once cleaned.',
                )
                .optional(),
              text: z
                .string()
                .min(1)
                .refine(
                  (text) =>
                    encodedTextBytes(text) <=
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
              (total, message) => total + encodedTextBytes(message.text),
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
 * The fork-context source identity of an imported conversation, keyed by the
 * authenticated paired-Station Device that sent it (never a claim in the
 * body), so it can never collide with a conversation of this Station or of
 * another sender.
 */
export function importedSourceConversationId(
  senderDeviceId: string,
  sourceConversationId: string,
): string {
  return `station:${createHash('sha256')
    .update(JSON.stringify([senderDeviceId, sourceConversationId]))
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
    ...(message.importedFrom
      ? { metadata: { importedFrom: message.importedFrom } }
      : {}),
  }));
}

/**
 * Who may import (`POST /agents/:slug/conversation-imports`): only a paired
 * Station, meaning a request admitted with a verified `delegation` Device
 * credential whose Device record still names that same Device when re-read
 * here. The name is the one the paired Station gave itself when it requested
 * pairing (its `deviceName`), which this Station's operator approved.
 */
export function pairedStationImportCaller(
  identifyDevice: (
    credential: string,
  ) => { id: string; name: string } | null | undefined,
): (request: Request) => { deviceId: string; stationName: string } | undefined {
  return (request) => {
    const principal = getRuntimeAuthenticatedRequestPrincipal(request);
    if (principal?.deviceKind !== 'delegation' || !principal.deviceId)
      return undefined;
    const device = identifyDevice(principal.credential);
    if (!device || device.id !== principal.deviceId) return undefined;
    return { deviceId: device.id, stationName: device.name };
  };
}
