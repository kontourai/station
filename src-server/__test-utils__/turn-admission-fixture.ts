import { randomUUID } from 'node:crypto';

/** Supply a caller-owned key while preserving explicitly invalid wire fields. */
export function keyedTurnRequest(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  if (request.type === 'steerTurn')
    return { clientInputId: randomUUID(), ...request };

  const operation = request.taskRoomRequest ?? request.taskRoomReply;
  const operationId =
    operation && typeof operation === 'object' && 'operationId' in operation
      ? operation.operationId
      : request.attemptId;
  const key =
    typeof operationId === 'string' &&
    operationId.trim() &&
    operationId.length <= 200
      ? operationId
      : randomUUID();
  return { clientTurnId: key, ...request };
}

/** Key only turn-sending MCP tools; preserve every other tool's strict schema. */
export function keyedTurnToolArguments(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return ['send_message', 'delegate_task', 'continue_task'].includes(name)
    ? (keyedTurnRequest(args) as Record<string, unknown>)
    : args;
}
