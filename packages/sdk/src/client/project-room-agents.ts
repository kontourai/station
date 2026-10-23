import {
  PROJECT_ROOM_LIMITS,
  parseProjectRoomAgentRequestInput,
} from '@kontourai/station-contracts/project-room';
import { z } from 'zod';
import { envelopeError } from './api-error-message';
import { type ApiRequestScope, getJson, mutateJson } from './http';
import {
  type ProjectRoomGuards,
  ProjectRoomProtocolError,
} from './project-rooms';

const guards = z.strictObject({
  expectedRoomId: z.uuid(),
  expectedProjectId: z.string().min(1),
  expectedActorId: z.string().min(1),
});
const message = z.strictObject({
  intentId: z.uuid(),
  agentId: z.string().min(1).max(256),
  text: z
    .string()
    .min(1)
    .refine(
      (s) =>
        new TextEncoder().encode(s).length <= PROJECT_ROOM_LIMITS.textBytes,
    ),
  replyTo: z.uuid().optional(),
});
const intent = message.extend(guards.shape);
const handle = message.extend({
  roomId: z.uuid(),
  requestId: z.uuid(),
  actor: z.strictObject({
    id: z.string().min(1),
    displayName: z.string(),
    kind: z.enum(['person', 'agent']),
  }),
  state: z.enum(['reserved', 'started', 'published', 'uncertain', 'cancelled']),
  publishedMessageId: z.uuid().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  failure: z
    .enum([
      'agent_unavailable',
      'launch_uncertain',
      'execution_failed',
      'publication_failed',
    ])
    .optional(),
});
export type ProjectRoomAgentIntent = z.infer<typeof intent>;
export type ProjectRoomAgentHandle = z.infer<typeof handle>;
export function parseProjectRoomAgentIntent(
  value: unknown,
): ProjectRoomAgentIntent {
  const input = intent.parse(value);
  const {
    expectedRoomId: _room,
    expectedProjectId: _project,
    expectedActorId: _actor,
    ...request
  } = input;
  parseProjectRoomAgentRequestInput(request);
  return input;
}
export async function projectRoomAgentRequest(
  scope: ApiRequestScope,
  slug: string,
  guard: ProjectRoomGuards,
  operation:
    | ProjectRoomAgentIntent
    | { requestId: string; action: 'inspect' | 'reconcile' | 'cancel' },
  signal?: AbortSignal,
): Promise<ProjectRoomAgentHandle> {
  guards.parse(guard);
  if (
    !('action' in operation) &&
    (operation.expectedRoomId !== guard.expectedRoomId ||
      operation.expectedProjectId !== guard.expectedProjectId ||
      operation.expectedActorId !== guard.expectedActorId)
  )
    throw new ProjectRoomProtocolError('Room Agent authority changed.');
  const base = `${scope.apiBase}/api/projects/${encodeURIComponent(slug)}/room/agents`;
  const options = {
    requestScope: scope,
    signal,
    maxResponseBytes: PROJECT_ROOM_LIMITS.textBytes * 6 + 16384,
  };
  const requestId =
    'action' in operation ? z.uuid().parse(operation.requestId) : undefined;
  const response =
    'action' in operation
      ? operation.action === 'inspect'
        ? await getJson(`${base}/${requestId}`, options)
        : await mutateJson(
            `${base}/${requestId}/${operation.action}`,
            'POST',
            options,
            guard,
          )
      : await mutateJson(
          base,
          'POST',
          options,
          parseProjectRoomAgentIntent(operation),
        );
  const body = await response.json();
  if (!response.ok || body?.success !== true)
    throw envelopeError(response, body, 'Agent request unavailable.');
  const parsed = handle.safeParse(body.data);
  if (!parsed.success)
    throw new ProjectRoomProtocolError('Room Agent response incompatible.');
  const value = parsed.data;
  if (
    value.roomId !== guard.expectedRoomId ||
    (requestId && value.requestId !== requestId)
  )
    throw new ProjectRoomProtocolError('Room Agent identity changed.');
  if (
    !('action' in operation) &&
    (value.intentId !== operation.intentId ||
      value.agentId !== operation.agentId ||
      value.text !== operation.text ||
      value.replyTo !== operation.replyTo ||
      value.actor.id !== guard.expectedActorId)
  )
    throw new ProjectRoomProtocolError('Room Agent intent changed.');
  return value;
}
