import {
  CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES,
  CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH,
} from '@kontourai/station-contracts/chat-attachment';
import { z } from 'zod/v3';

export type PeerChatBodyKind =
  | 'chat'
  | 'continue'
  | 'command'
  | 'inbox'
  | 'prepare'
  | 'reconcile'
  | 'upload'
  | 'restore-preview'
  | 'restore'
  | 'empty';

export interface PeerChatOperation {
  path: string;
  query: string;
  mutation: boolean;
  response: 'json' | 'content' | 'media' | 'events';
  body?: PeerChatBodyKind;
  maxBodyBytes: number;
  requiresLocalConversation: boolean;
}

interface Rule {
  method: string;
  path: RegExp;
  query?: readonly string[];
  response?: PeerChatOperation['response'];
  body?: PeerChatBodyKind;
  localConversation?: boolean;
}

const rules: readonly Rule[] = [
  { method: 'GET', path: /^\/\.well-known\/station\/v1$/ },
  {
    method: 'GET',
    path: /^\/api\/(?:projects|agents|connections\/(?:agents|models))$/,
  },
  { method: 'GET', path: /^\/api\/agents\/[^/]+$/ },
  { method: 'GET', path: /^\/api\/settings\/managed-policy$/ },
  { method: 'GET', path: /^\/api\/conversations\/[^/]+\/open$/ },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/providers(?:\/[^/]+\/(?:commands|models))?$/,
  },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/events$/,
    query: ['threadId'],
    response: 'events',
  },
  { method: 'GET', path: /^\/api\/orchestration\/sessions$/ },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/sessions\/[^/]+$/,
    query: ['view', 'cursor', 'turnLimit'],
  },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/(?:sessions|conversations)\/[^/]+\/event-window$/,
    query: ['cursor', 'direction', 'turnLimit'],
  },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/sessions\/[^/]+\/content\/[^/]+$/,
    query: ['maxChars'],
    response: 'content',
  },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/sessions\/[^/]+\/(?:requests\/[^/]+(?:\/content-binding)?|input-requests\/[^/]+)$/,
  },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/sessions\/[^/]+\/child-work\/[^/]+\/(?:transcript|instructions)$/,
    query: ['offset', 'limit'],
  },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/sessions\/[^/]+\/(?:checkpoint-restores|usage-limit)$/,
  },
  // The transcript's changed-files read names its history revision so each
  // revision is a distinct read; the receiver ignores it.
  {
    method: 'GET',
    path: /^\/api\/orchestration\/sessions\/[^/]+\/checkpoints$/,
    query: ['revision'],
  },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/conversations\/[^/]+\/(?:usage-tree|context-boundary\/[^/]+)$/,
  },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/conversations\/[^/]+\/inbox$/,
  },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/conversations\/[^/]+\/turn-deliveries\/[^/]+$/,
    query: ['projectSlug'],
  },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/commands\/receipts$/,
    query: ['threadId'],
  },
  { method: 'GET', path: /^\/api\/orchestration\/commands\/receipts\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/orchestration\/chat$/, body: 'chat' },
  {
    method: 'POST',
    path: /^\/api\/orchestration\/chat\/[^/]+\/continue$/,
    body: 'continue',
    localConversation: true,
  },
  { method: 'POST', path: /^\/api\/orchestration\/commands$/, body: 'command' },
  {
    method: 'POST',
    path: /^\/api\/orchestration\/conversations\/[^/]+\/inbox$/,
    body: 'inbox',
    localConversation: true,
  },
  {
    method: 'DELETE',
    path: /^\/api\/orchestration\/conversations\/[^/]+\/inbox\/[^/]+$/,
    body: 'empty',
    localConversation: true,
  },
  {
    method: 'POST',
    path: /^\/api\/orchestration\/sessions\/[^/]+\/checkpoints\/[^/]+\/restore-preview$/,
    body: 'restore-preview',
  },
  {
    method: 'POST',
    path: /^\/api\/orchestration\/sessions\/[^/]+\/checkpoints\/[^/]+\/restore$/,
    body: 'restore',
  },
  { method: 'GET', path: /^\/api\/attachments\/[^/]+$/, response: 'media' },
  {
    method: 'GET',
    path: /^\/api\/orchestration\/attachment-staging\/capability$/,
  },
  {
    method: 'POST',
    path: /^\/api\/orchestration\/attachment-staging\/prepare$/,
    body: 'prepare',
  },
  {
    method: 'POST',
    path: /^\/api\/orchestration\/attachment-staging\/reconcile$/,
    body: 'reconcile',
  },
  {
    method: 'PUT',
    path: /^\/api\/orchestration\/attachment-staging\/stage_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    body: 'upload',
  },
  {
    method: 'DELETE',
    path: /^\/api\/orchestration\/attachment-staging\/stage_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    body: 'empty',
  },
];

/** The route and owner-standing exception share this exact deny-by-default ceiling. */
export function classifyPeerChatOperation(
  method: string,
  pathname: string,
  search = '',
): PeerChatOperation | null {
  try {
    if (pathname.length > 4096 || search.length > 4096) return null;
    const segments = pathname.split('/').slice(1).map(decodeURIComponent);
    if (
      segments.some(
        (segment) =>
          !/^[A-Za-z0-9_:@.-]+$/.test(segment) ||
          segment === '.' ||
          segment === '..',
      )
    )
      return null;
    const path = `/${segments.join('/')}`;
    if (/^\/api\/orchestration\/sessions\/(?:read-model|loaded)$/.test(path))
      return null;
    const rule = rules.find(
      (entry) => entry.method === method.toUpperCase() && entry.path.test(path),
    );
    if (!rule) return null;
    const query = new URLSearchParams(search);
    const seen = new Set<string>();
    for (const [key, value] of query) {
      if (
        !rule.query?.includes(key) ||
        seen.has(key) ||
        value.length > 2048 ||
        /[%/\\]/.test(value) ||
        value === '.' ||
        value === '..' ||
        [...value].some((character) => character.charCodeAt(0) < 32)
      )
        return null;
      seen.add(key);
    }
    if (
      /^\/api\/orchestration\/sessions\/[^/]+$/.test(path) &&
      query.get('view') !== 'window-v1'
    )
      return null;
    const mutation = !['GET', 'HEAD'].includes(method.toUpperCase());
    return {
      path: `/${segments.map(encodeURIComponent).join('/')}`,
      query: query.size ? `?${query.toString()}` : '',
      mutation,
      response: rule.response ?? 'json',
      body: rule.body,
      maxBodyBytes:
        rule.body === 'upload'
          ? CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH
          : ['chat', 'continue', 'command'].includes(rule.body ?? '')
            ? CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES
            : 1024 * 1024,
      requiresLocalConversation: rule.localConversation === true,
    };
  } catch {
    return null;
  }
}

export function isPeerChatMutation(method: string, pathname: string): boolean {
  const match =
    /^\/api\/environments\/peers\/([A-Za-z0-9_-]+)\/chat-api(\/.*)$/.exec(
      pathname,
    );
  return (
    !!match && classifyPeerChatOperation(method, match[2]!)?.mutation === true
  );
}

const PEER_CHAT_COMMANDS = new Set([
  'interruptTurn',
  'steerTurn',
  'steerTurnOnce',
  'inspectSteerInput',
  'respondToRequest',
  'stopSession',
  'discardDraft',
]);

/** Used after receiver-schema parsing; omitted environments must never select a Project default. */
function isReceiverLocalChatTarget(target: {
  environment?: { kind: string };
  workspace?: { kind: string; cwd?: string };
}): boolean {
  return (
    target.environment?.kind === 'current' &&
    (!target.workspace ||
      (target.workspace.kind === 'project' &&
        target.workspace.cwd === undefined))
  );
}

/** Reparse with receiver schemas; never pass arbitrary actor or execution fields onward. */
export async function transformPeerChatBody(
  kind: PeerChatBodyKind,
  raw: string,
): Promise<{ body?: string; mutationKey?: string } | null> {
  if (kind === 'empty') return raw.length === 0 ? {} : null;
  if (kind === 'upload') return { body: raw };
  try {
    const input: unknown = JSON.parse(raw);
    const {
      foregroundMessageSchema,
      continueForegroundMessageSchema,
      orchestrationCommandSchema,
      conversationInboxBodySchema,
    } = await import('../orchestration/orchestration.js');
    const { attachmentStageDescriptorSchema, attachmentStageReconcileSchema } =
      await import('../orchestration/attachment-staging.js');
    const schemas = {
      chat: foregroundMessageSchema,
      continue: continueForegroundMessageSchema,
      command: orchestrationCommandSchema,
      inbox: conversationInboxBodySchema,
      prepare: attachmentStageDescriptorSchema,
      reconcile: attachmentStageReconcileSchema,
      'restore-preview': z
        .object({ phase: z.enum(['baseline', 'settle']).default('settle') })
        .strict(),
      restore: z
        .object({
          confirmed: z.literal(true),
          previewId: z.string().uuid(),
          expectedCurrentTreeSha: z.string().regex(/^[0-9a-f]{40,64}$/),
        })
        .strict(),
    };
    const parsed = schemas[kind].safeParse(input);
    if (!parsed.success || dropsFields(input, parsed.data)) return null;
    if (kind === 'chat') {
      const chat = foregroundMessageSchema.parse(parsed.data);
      if (!isReceiverLocalChatTarget(chat.target)) return null;
      return { body: JSON.stringify(chat), mutationKey: chat.clientTurnId };
    }
    if (kind === 'continue') {
      const continuation = continueForegroundMessageSchema.parse(parsed.data);
      if (continuation.environment?.kind !== 'current') return null;
      return {
        body: JSON.stringify(continuation),
        mutationKey: continuation.clientTurnId,
      };
    }
    if (
      kind === 'command' &&
      !PEER_CHAT_COMMANDS.has(
        orchestrationCommandSchema.parse(parsed.data).type,
      )
    )
      return null;
    const value = parsed.data;
    const mutationKey =
      'key' in value && typeof value.key === 'string'
        ? value.key
        : 'clientInputId' in value && typeof value.clientInputId === 'string'
          ? value.clientInputId
          : 'clientTurnId' in value && typeof value.clientTurnId === 'string'
            ? value.clientTurnId
            : undefined;
    return { body: JSON.stringify(value), mutationKey };
  } catch {
    return null;
  }
}

function dropsFields(input: unknown, output: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  if (!output || typeof output !== 'object') return true;
  const result = output as Record<string, unknown>;
  return Object.entries(input).some(
    ([key, value]) => !(key in result) || dropsFields(value, result[key]),
  );
}
