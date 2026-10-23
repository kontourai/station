import {
  PROJECT_ROOM_LIMITS as LIMITS,
  type ProjectRoomActor,
  type ProjectRoomAppendInput,
  type ProjectRoomNoteInput,
  type ProjectRoomView,
  parseProjectRoomAppendInput,
  parseProjectRoomNoteInput,
} from '@kontourai/station-contracts/project-room';
import { z } from 'zod';
import { envelopeError } from './api-error-message';
import {
  type ApiRequestScope,
  authenticatedFetch,
  fetchSSE,
  mutateJson,
} from './http';

const bounded = (max: number) =>
  z.string().refine((v) => new TextEncoder().encode(v).length <= max);
const id = z.string().min(1).max(512);
const uuid = z.uuid();
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const actor = z.strictObject({
  id,
  displayName: bounded(512),
  kind: z.enum(['person', 'agent']),
});
const scope = z.strictObject({
  stationId: id,
  localProjectId: id,
  localProjectSlug: id,
  portableProjectId: id,
});
const checkpoint = z.strictObject({ roomId: uuid, lastSeq: seq });
const message = z.strictObject({
  intentId: uuid,
  text: bounded(LIMITS.textBytes),
  replyTo: uuid.optional(),
  roomId: uuid,
  messageId: uuid,
  seq: seq.min(1),
  actor,
  createdAt: z.iso.datetime(),
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
  .max(1000);
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
function path(slug: string, suffix = '') {
  if (!slug || slug.length > 512)
    throw new ProjectRoomProtocolError('Project identity is invalid.');
  return `/api/projects/${encodeURIComponent(slug)}/room${suffix}`;
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
    if (error instanceof Error && error.name !== 'SyntaxError') throw error;
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
): Promise<ProjectRoomBrowserView> {
  const value = parse(
    view,
    await envelope(
      await authenticatedFetch(
        `${requestScope.apiBase}${path(slug)}`,
        options(requestScope, signal),
      ),
    ),
  );
  if (
    value.scope.localProjectId !== projectId ||
    value.scope.localProjectSlug !== slug ||
    value.checkpoint.roomId !== value.roomId ||
    (value.note && value.note.roomId !== value.roomId)
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
) {
  parse(seq, after);
  parse(z.number().int().min(1).max(LIMITS.maxPageSize), limit);
  const value = parse(
    history,
    await envelope(
      await authenticatedFetch(
        `${requestScope.apiBase}${path(slug, `/messages?after=${after}&limit=${limit}`)}`,
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
) {
  const { expectedRoomId, expectedProjectId, expectedActorId, ...proposal } =
    input;
  guards({ expectedRoomId, expectedProjectId, expectedActorId });
  parseProjectRoomAppendInput(proposal);
  const value = parse(
    message,
    await envelope(
      await mutateJson(
        `${requestScope.apiBase}${path(slug, '/messages')}`,
        'POST',
        options(requestScope),
        input,
      ),
    ),
  );
  assertRoom(expectedRoomId, value);
  if (
    value.actor.id !== expectedActorId ||
    value.intentId !== input.intentId ||
    value.text !== input.text ||
    value.replyTo !== input.replyTo
  )
    throw new ProjectRoomProtocolError(
      'Project room acknowledgement does not match the proposal.',
    );
  return value;
}
export async function saveProjectRoomNote(
  requestScope: ApiRequestScope,
  slug: string,
  input: ProjectRoomNoteIntent,
) {
  const { expectedRoomId, expectedProjectId, expectedActorId, ...proposal } =
    input;
  guards({ expectedRoomId, expectedProjectId, expectedActorId });
  parseProjectRoomNoteInput(proposal);
  const value = parse(
    note,
    await envelope(
      await mutateJson(
        `${requestScope.apiBase}${path(slug, '/note')}`,
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
) {
  const { clientId, state, ...identity } = input;
  guards(identity);
  parse(uuid, clientId);
  parse(z.enum(['join', 'leave']), state);
  return parse(
    presence,
    await envelope(
      await mutateJson(
        `${requestScope.apiBase}${path(slug, '/presence')}`,
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
) {
  return fetchSSE(`${requestScope.apiBase}${path(slug, '/events')}`, {
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
        else throw new ProjectRoomProtocolError('Unknown Project room event.');
        return true;
      } catch (error) {
        callbacks.onError?.(error);
        return false;
      }
    },
  });
}
/** Validate a retained proposal before offering an explicit retry after reload. */
export function parseProjectRoomMessageIntent(
  value: unknown,
): ProjectRoomMessageIntent {
  return parse(
    z.strictObject({
      expectedRoomId: uuid,
      expectedProjectId: id,
      expectedActorId: id,
      intentId: uuid,
      text: bounded(LIMITS.textBytes).refine((v) => !!v.trim()),
      replyTo: uuid.optional(),
    }),
    value,
  );
}
