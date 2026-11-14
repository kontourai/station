import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import {
  PROJECT_ROOM_LIMITS as LIMITS,
  type ProjectRoomActor,
  type ProjectRoomAppendInput,
  type ProjectRoomAttachment,
  type ProjectRoomChannel,
  type ProjectRoomChannelCreateInput,
  type ProjectRoomChannelUpdateInput,
  type ProjectRoomDeleteInput,
  type ProjectRoomEditInput,
  type ProjectRoomMessage,
  type ProjectRoomNoteInput,
  type ProjectRoomReactionInput,
  type ProjectRoomView,
  parseProjectRoomAppendInput,
  parseProjectRoomAttachments,
  parseProjectRoomChannel,
  parseProjectRoomChannelCreateInput,
  parseProjectRoomChannelList,
  parseProjectRoomChannelUpdateInput,
  parseProjectRoomDeleteInput,
  parseProjectRoomEditInput,
  parseProjectRoomNoteInput,
  parseProjectRoomReactionInput,
} from '@kontourai/station-contracts/project-room';
import { parseProjectRoomMessage } from '@kontourai/station-contracts/project-room-browser';
import { z } from 'zod';
import { envelopeError } from './api-error-message';
import { hasCapability } from './capability.js';
import { type ApiRequestScope, fetchSSE, getJson, mutateJson } from './http';
import { fetchPublicStationCapabilities } from './publicStationCapabilities.js';
import { rethrowDeadline } from './request-deadline';

const bounded = (max: number) =>
  z.string().refine((v) => new TextEncoder().encode(v).length <= max);
const id = z.string().min(1).max(2048);
const uuid = z.uuid();
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const actor = z.strictObject({
  id,
  displayName: bounded(2048),
  kind: z.enum(['person', 'agent']),
});
const scope = z.strictObject({
  stationId: id,
  localProjectId: id,
  localProjectSlug: id,
  portableProjectId: id,
});
const checkpoint = z.strictObject({ roomId: uuid, lastSeq: seq });
/** A message as history projects it; the contract owns its rules. */
const message = z.unknown().transform((value, ctx): ProjectRoomMessage => {
  try {
    return parseProjectRoomMessage(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid Project room message' });
    return z.NEVER;
  }
});
const sources = z
  .array(uuid)
  .max(LIMITS.sourceMessages)
  .refine((v) => new Set(v).size === v.length);
const note = z.strictObject({
  roomId: uuid,
  revision: seq.min(1),
  markdown: bounded(LIMITS.noteBytes),
  sourceMessageIds: sources,
  actor,
  updatedAt: z.iso.datetime(),
});
const presence = z
  .array(z.strictObject({ clientId: uuid, actor, expiresAt: z.iso.datetime() }))
  .max(100);
const view = z.strictObject({
  scope,
  roomId: uuid,
  capabilities: z.strictObject({
    view: z.boolean(),
    discuss: z.boolean(),
    edit: z.boolean(),
    execute: z.boolean(),
  }),
  checkpoint,
  note: note.nullable(),
  actor,
  presence,
});
const history = z.strictObject({
  scope,
  roomId: uuid,
  messages: z.array(message).max(LIMITS.maxPageSize),
  checkpoint,
  nextAfter: seq.nullable(),
});

export interface ProjectRoomPresence {
  clientId: string;
  actor: ProjectRoomActor;
  expiresAt: string;
}
export interface ProjectRoomBrowserView extends ProjectRoomView {
  actor: ProjectRoomActor;
  presence: ProjectRoomPresence[];
}
export interface ProjectRoomGuards {
  expectedRoomId: string;
  expectedProjectId: string;
  expectedActorId: string;
}
export type ProjectRoomMessageIntent = ProjectRoomAppendInput &
  ProjectRoomGuards;
export type ProjectRoomNoteIntent = ProjectRoomNoteInput & ProjectRoomGuards;
export class ProjectRoomProtocolError extends Error {}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ProjectRoomProtocolError(
      'Project room response is incompatible.',
    );
  return result.data;
}
function projectPath(slug: string) {
  if (!slug || slug.length > 512)
    throw new ProjectRoomProtocolError('Project identity is invalid.');
  return `/api/projects/${encodeURIComponent(slug)}`;
}
/**
 * A room's address: the Project's default channel (`/room`) without
 * `channelId`, otherwise that channel (`/channels/:channelId`).
 */
function path(slug: string, suffix = '', channelId?: string) {
  if (channelId === undefined) return `${projectPath(slug)}/room${suffix}`;
  return `${projectPath(slug)}/channels/${parse(uuid, channelId)}${suffix}`;
}
async function envelope(response: Response): Promise<unknown> {
  // Bound the bytes before JSON parsing, including malformed success responses.
  const boundedResponse = response.clone();
  const reader = boundedResponse.body?.getReader();
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > LIMITS.pageBytes + 65536) {
          void reader.cancel();
          void response.body?.cancel();
          throw new ProjectRoomProtocolError(
            'Project room response is too large.',
          );
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    rethrowDeadline(error);
    if (!(error instanceof SyntaxError)) throw error;
    if (!response.ok)
      throw envelopeError(response, undefined, 'Project room request failed.');
    throw new ProjectRoomProtocolError('Project room response is not JSON.');
  }
  if (!response.ok)
    throw envelopeError(response, body, 'Project room request failed.');
  const result = z
    .strictObject({ success: z.literal(true), data: z.unknown() })
    .safeParse(body);
  if (!result.success)
    throw new ProjectRoomProtocolError(
      'Project room response is incompatible.',
    );
  return result.data.data;
}
function options(requestScope: ApiRequestScope, signal?: AbortSignal) {
  return { requestScope, signal };
}
function guards(input: ProjectRoomGuards) {
  parse(
    z.strictObject({
      expectedRoomId: uuid,
      expectedProjectId: id,
      expectedActorId: id,
    }),
    input,
  );
}
function assertRoom(roomId: string, value: { roomId: string }) {
  if (value.roomId !== roomId)
    throw new ProjectRoomProtocolError('Project room identity changed.');
}
export async function discoverProjectRoom(
  requestScope: ApiRequestScope,
  slug: string,
  projectId: string,
  signal?: AbortSignal,
  channelId?: string,
): Promise<ProjectRoomBrowserView> {
  const value = parse(
    view,
    await envelope(
      await getJson(
        `${requestScope.apiBase}${path(slug, '', channelId)}`,
        options(requestScope, signal),
      ),
    ),
  );
  if (
    value.scope.localProjectId !== projectId ||
    value.scope.localProjectSlug !== slug ||
    value.checkpoint.roomId !== value.roomId ||
    (channelId !== undefined && value.roomId !== channelId) ||
    (value.note && value.note.roomId !== value.roomId)
  )
    throw new ProjectRoomProtocolError('Project room identity changed.');
  return value;
}
export async function initializeProjectRoom(
  requestScope: ApiRequestScope,
  slug: string,
  projectId: string,
) {
  parse(id, projectId);
  const value = parse(
    z.strictObject({ scope, roomId: uuid }),
    await envelope(
      await mutateJson(
        `${requestScope.apiBase}${path(slug, '/init')}`,
        'POST',
        options(requestScope),
        { expectedProjectId: projectId },
      ),
    ),
  );
  if (
    value.scope.localProjectId !== projectId ||
    value.scope.localProjectSlug !== slug
  )
    throw new ProjectRoomProtocolError('Project room identity changed.');
  return value;
}
export async function fetchProjectRoomHistory(
  requestScope: ApiRequestScope,
  slug: string,
  identity: { projectId: string; roomId: string },
  after = 0,
  limit = 25,
  signal?: AbortSignal,
  channelId?: string,
) {
  parse(seq, after);
  parse(z.number().int().min(1).max(LIMITS.maxPageSize), limit);
  const value = parse(
    history,
    await envelope(
      await getJson(
        `${requestScope.apiBase}${path(slug, `/messages?after=${after}&limit=${limit}`, channelId)}`,
        options(requestScope, signal),
      ),
    ),
  );
  assertRoom(identity.roomId, value);
  assertRoom(identity.roomId, value.checkpoint);
  if (
    value.scope.localProjectId !== identity.projectId ||
    value.scope.localProjectSlug !== slug
  )
    throw new ProjectRoomProtocolError('Project room identity changed.');
  let previous = after;
  for (const item of value.messages) {
    assertRoom(identity.roomId, item);
    if (item.seq <= previous || item.seq > value.checkpoint.lastSeq)
      throw new ProjectRoomProtocolError(
        'Project room history is out of order.',
      );
    previous = item.seq;
  }
  if (
    value.nextAfter !== null &&
    (value.nextAfter !== previous || previous <= after)
  )
    throw new ProjectRoomProtocolError('Project room cursor did not advance.');
  return value;
}
export async function sendProjectRoomMessage(
  requestScope: ApiRequestScope,
  slug: string,
  input: ProjectRoomMessageIntent,
  channelId?: string,
) {
  const { expectedRoomId, expectedProjectId, expectedActorId, ...proposal } =
    input;
  guards({ expectedRoomId, expectedProjectId, expectedActorId });
  parseProjectRoomAppendInput(proposal);
  const value = parse(
    message,
    await envelope(
      await mutateJson(
        `${requestScope.apiBase}${path(slug, '/messages', channelId)}`,
        'POST',
        options(requestScope),
        input,
      ),
    ),
  );
  assertRoom(expectedRoomId, value);
  // A retried send can be acknowledged after the message was edited or
  // deleted; then its content is the newer revision's.
  const revised = value.editedAt !== undefined || value.deletedAt !== undefined;
  const files = (list?: { id: string }[]) =>
    JSON.stringify(list?.map((file) => file.id) ?? []);
  if (
    value.actor.id !== expectedActorId ||
    value.intentId !== input.intentId ||
    value.replyTo !== input.replyTo ||
    (!revised && value.text !== input.text) ||
    (value.deletedAt === undefined &&
      files(value.attachments) !== files(input.attachments))
  )
    throw new ProjectRoomProtocolError(
      'Project room acknowledgement does not match the proposal.',
    );
  return value;
}
/** A message reference plus the room guards every message action carries. */
export type ProjectRoomMessageTarget = ProjectRoomGuards & {
  messageId: string;
};
async function messageAction(
  requestScope: ApiRequestScope,
  slug: string,
  target: ProjectRoomMessageTarget,
  action: 'reactions' | 'edit' | 'delete',
  input: object,
  channelId: string | undefined,
): Promise<ProjectRoomMessage> {
  const { messageId, ...identity } = target;
  guards(identity);
  parse(uuid, messageId);
  const value = parse(
    message,
    await envelope(
      await mutateJson(
        `${requestScope.apiBase}${path(slug, `/messages/${messageId}/${action}`, channelId)}`,
        'POST',
        options(requestScope),
        { ...identity, ...input },
      ),
    ),
  );
  assertRoom(identity.expectedRoomId, value);
  if (value.messageId !== messageId)
    throw new ProjectRoomProtocolError(
      'Project room message identity changed.',
    );
  return value;
}
/** Sets the caller's reaction; sending the same state again changes nothing. */
export async function reactToProjectRoomMessage(
  requestScope: ApiRequestScope,
  slug: string,
  target: ProjectRoomMessageTarget,
  input: ProjectRoomReactionInput,
  channelId?: string,
) {
  const value = parseProjectRoomReactionInput(input);
  const result = await messageAction(
    requestScope,
    slug,
    target,
    'reactions',
    value,
    channelId,
  );
  const mine = result.reactions
    ?.find((reaction) => reaction.emoji === value.emoji)
    ?.actors.some((actor) => actor.id === target.expectedActorId);
  if (!result.deletedAt && !!mine !== value.reacted)
    throw new ProjectRoomProtocolError(
      'Project room reaction acknowledgement does not match the request.',
    );
  return result;
}
/** Replaces the text of the caller's own message; the original is kept. */
export async function editProjectRoomMessage(
  requestScope: ApiRequestScope,
  slug: string,
  target: ProjectRoomMessageTarget,
  input: ProjectRoomEditInput,
  channelId?: string,
) {
  return messageAction(
    requestScope,
    slug,
    target,
    'edit',
    parseProjectRoomEditInput(input),
    channelId,
  );
}
/** Replaces the caller's own message with a "message deleted" tombstone. */
export async function deleteProjectRoomMessage(
  requestScope: ApiRequestScope,
  slug: string,
  target: ProjectRoomMessageTarget,
  input: ProjectRoomDeleteInput,
  channelId?: string,
) {
  const result = await messageAction(
    requestScope,
    slug,
    target,
    'delete',
    parseProjectRoomDeleteInput(input),
    channelId,
  );
  if (!result.deletedAt)
    throw new ProjectRoomProtocolError(
      'Project room delete was not acknowledged.',
    );
  return result;
}
/** Stores files for the caller's next message in this room. */
export async function uploadProjectRoomAttachments(
  requestScope: ApiRequestScope,
  slug: string,
  input: ProjectRoomGuards & { attachments: ChatAttachmentInput[] },
  channelId?: string,
): Promise<ProjectRoomAttachment[]> {
  const { attachments, ...identity } = input;
  guards(identity);
  const response = await mutateJson(
    `${requestScope.apiBase}${path(slug, '/attachments', channelId)}`,
    'POST',
    options(requestScope),
    input,
  );
  const value = await envelope(response);
  let stored: ProjectRoomAttachment[];
  try {
    stored = parseProjectRoomAttachments(value);
  } catch {
    throw new ProjectRoomProtocolError(
      'Project room attachment acknowledgement is incompatible.',
    );
  }
  if (
    stored.length !== attachments.length ||
    stored.some(
      (file, index) =>
        file.name !== attachments[index]!.name ||
        file.size !== attachments[index]!.size,
    )
  )
    throw new ProjectRoomProtocolError(
      'Project room attachment acknowledgement does not match the upload.',
    );
  return stored;
}
/** A file's bytes, as a raw response (octet-stream). */
export function fetchProjectRoomAttachment(
  requestScope: ApiRequestScope,
  slug: string,
  attachmentId: string,
  channelId?: string,
  signal?: AbortSignal,
): Promise<Response> {
  parse(uuid, attachmentId);
  return getJson(
    `${requestScope.apiBase}${path(slug, `/attachments/${attachmentId}`, channelId)}`,
    options(requestScope, signal),
  );
}
/**
 * Whether the host takes reactions, edits, deletes and files on Project room
 * messages (`projectRoomMessageActions`). `false` when the handshake cannot
 * be read, so a client never offers what the host would answer 404.
 */
export async function readProjectRoomMessageActionsCapability(
  apiBase: string,
): Promise<boolean> {
  const handshake = await fetchPublicStationCapabilities(apiBase);
  return handshake
    ? hasCapability(handshake, 'projectRoomMessageActions')
    : false;
}
export async function saveProjectRoomNote(
  requestScope: ApiRequestScope,
  slug: string,
  input: ProjectRoomNoteIntent,
  channelId?: string,
) {
  const { expectedRoomId, expectedProjectId, expectedActorId, ...proposal } =
    input;
  guards({ expectedRoomId, expectedProjectId, expectedActorId });
  parseProjectRoomNoteInput(proposal);
  const value = parse(
    note,
    await envelope(
      await mutateJson(
        `${requestScope.apiBase}${path(slug, '/note', channelId)}`,
        'PUT',
        options(requestScope),
        input,
      ),
    ),
  );
  assertRoom(expectedRoomId, value);
  if (
    value.revision !== input.expectedRevision + 1 ||
    value.actor.id !== expectedActorId ||
    value.markdown !== input.markdown ||
    JSON.stringify(value.sourceMessageIds) !==
      JSON.stringify(input.sourceMessageIds)
  )
    throw new ProjectRoomProtocolError(
      'Project room note acknowledgement is incompatible.',
    );
  return value;
}
export async function setProjectRoomPresence(
  requestScope: ApiRequestScope,
  slug: string,
  input: ProjectRoomGuards & { clientId: string; state: 'join' | 'leave' },
  channelId?: string,
) {
  const { clientId, state, ...identity } = input;
  guards(identity);
  parse(uuid, clientId);
  parse(z.enum(['join', 'leave']), state);
  return parse(
    presence,
    await envelope(
      await mutateJson(
        `${requestScope.apiBase}${path(slug, '/presence', channelId)}`,
        'POST',
        options(requestScope),
        input,
      ),
    ),
  );
}
export type ProjectRoomEvent =
  | { kind: 'changed'; roomId: string; lastSeq: number }
  | { kind: 'presence'; participants: ProjectRoomPresence[] }
  | { kind: 'revoked'; reason: 'access_changed' };
export function subscribeProjectRoom(
  requestScope: ApiRequestScope,
  slug: string,
  roomId: string,
  callbacks: {
    onEvent(event: ProjectRoomEvent): void;
    onError?(error: unknown): void;
    onTerminal?(error: unknown): void;
  },
  channelId?: string,
) {
  return fetchSSE(
    `${requestScope.apiBase}${path(slug, '/events', channelId)}`,
    {
      requestScope,
      onError: callbacks.onError,
      onTerminal: callbacks.onTerminal,
      onMessage(frame) {
        if (frame.data.length > LIMITS.pageBytes) {
          callbacks.onError?.(
            new ProjectRoomProtocolError('Project room event is too large.'),
          );
          return false;
        }
        try {
          const value: unknown = JSON.parse(frame.data);
          if (frame.event === 'changed') {
            const event = parse(checkpoint, value);
            assertRoom(roomId, event);
            callbacks.onEvent({ kind: 'changed', ...event });
          } else if (frame.event === 'presence')
            callbacks.onEvent({
              kind: 'presence',
              ...parse(z.strictObject({ participants: presence }), value),
            });
          else if (frame.event === 'revoked')
            callbacks.onEvent({
              kind: 'revoked',
              ...parse(
                z.strictObject({ reason: z.literal('access_changed') }),
                value,
              ),
            });
          else
            throw new ProjectRoomProtocolError('Unknown Project room event.');
          return true;
        } catch (error) {
          callbacks.onError?.(error);
          return false;
        }
      },
    },
  );
}
/** Validate a retained proposal before offering an explicit retry after reload. */
export function parseProjectRoomMessageIntent(
  value: unknown,
): ProjectRoomMessageIntent {
  const { expectedRoomId, expectedProjectId, expectedActorId, ...proposal } =
    parse(
      z.strictObject({
        expectedRoomId: uuid,
        expectedProjectId: id,
        expectedActorId: id,
        intentId: uuid,
        text: bounded(LIMITS.textBytes),
        replyTo: uuid.optional(),
        attachments: z.array(z.unknown()).optional(),
      }),
      value,
    );
  try {
    return {
      expectedRoomId,
      expectedProjectId,
      expectedActorId,
      ...parseProjectRoomAppendInput(proposal),
    };
  } catch {
    throw new ProjectRoomProtocolError('Project room message is invalid.');
  }
}

export type { ProjectRoomChannel } from '@kontourai/station-contracts/project-room';
/** Guards a channel operation: the Project and person the client saw. */
export type ProjectRoomChannelGuards = Omit<
  ProjectRoomGuards,
  'expectedRoomId'
>;
function channelGuards(input: ProjectRoomChannelGuards) {
  parse(z.strictObject({ expectedProjectId: id, expectedActorId: id }), input);
}
function channel(value: unknown): ProjectRoomChannel {
  try {
    return parseProjectRoomChannel(value);
  } catch {
    throw new ProjectRoomProtocolError(
      'Project room channel response is incompatible.',
    );
  }
}
/**
 * The Project's channels, default first. A host without channels answers 404
 * for this path; callers treat that as "this host has only the default room".
 */
export async function listProjectRoomChannels(
  requestScope: ApiRequestScope,
  slug: string,
  signal?: AbortSignal,
): Promise<ProjectRoomChannel[]> {
  const value = await envelope(
    await getJson(
      `${requestScope.apiBase}${projectPath(slug)}/channels`,
      options(requestScope, signal),
    ),
  );
  try {
    return parseProjectRoomChannelList(value);
  } catch {
    throw new ProjectRoomProtocolError(
      'Project room channel list is incompatible.',
    );
  }
}
export async function createProjectRoomChannel(
  requestScope: ApiRequestScope,
  slug: string,
  input: ProjectRoomChannelCreateInput & ProjectRoomChannelGuards,
): Promise<ProjectRoomChannel> {
  const { expectedProjectId, expectedActorId, ...proposal } = input;
  channelGuards({ expectedProjectId, expectedActorId });
  parseProjectRoomChannelCreateInput(proposal);
  const value = channel(
    await envelope(
      await mutateJson(
        `${requestScope.apiBase}${projectPath(slug)}/channels`,
        'POST',
        options(requestScope),
        input,
      ),
    ),
  );
  if (value.name !== proposal.name || value.topic !== proposal.topic)
    throw new ProjectRoomProtocolError(
      'Project room channel acknowledgement does not match the proposal.',
    );
  return value;
}
export async function updateProjectRoomChannel(
  requestScope: ApiRequestScope,
  slug: string,
  channelId: string,
  input: ProjectRoomChannelUpdateInput & ProjectRoomChannelGuards,
): Promise<ProjectRoomChannel> {
  const { expectedProjectId, expectedActorId, ...proposal } = input;
  channelGuards({ expectedProjectId, expectedActorId });
  parseProjectRoomChannelUpdateInput(proposal);
  const value = channel(
    await envelope(
      await mutateJson(
        `${requestScope.apiBase}${path(slug, '', channelId)}`,
        'PATCH',
        options(requestScope),
        input,
      ),
    ),
  );
  if (
    value.channelId !== channelId ||
    (proposal.name !== undefined && value.name !== proposal.name) ||
    (proposal.topic !== undefined &&
      value.topic !== (proposal.topic ?? undefined)) ||
    (proposal.archived !== undefined &&
      (value.archivedAt !== undefined) !== proposal.archived)
  )
    throw new ProjectRoomProtocolError(
      'Project room channel acknowledgement does not match the proposal.',
    );
  return value;
}
