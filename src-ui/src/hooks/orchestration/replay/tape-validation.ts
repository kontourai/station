import { MAX_TAPE_FRAMES } from './limits';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;
const optionalText = (value: unknown) =>
  value === undefined || typeof value === 'string';
const optionalBoolean = (value: unknown) =>
  value === undefined || typeof value === 'boolean';
const list = (value: unknown, check: (item: unknown) => boolean) =>
  Array.isArray(value) && value.length <= MAX_TAPE_FRAMES && value.every(check);

/** Bound nesting before recursive render/redaction helpers ever see imported data. */
function boundedJson(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number; leave?: boolean }> = [
    { value, depth: 0 },
  ];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (entry.leave) {
      ancestors.delete(entry.value as object);
      continue;
    }
    if (++nodes > 2_000_000 || entry.depth > 64) return false;
    const item = entry.value;
    if (
      item === null ||
      item === undefined ||
      typeof item === 'string' ||
      typeof item === 'boolean'
    )
      continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    if (
      !Array.isArray(item) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      return false;
    ancestors.add(item);
    stack.push({ value: item, depth: entry.depth, leave: true });
    for (const field of Object.values(Object.getOwnPropertyDescriptors(item))) {
      if (!('value' in field)) return false;
      stack.push({ value: field.value, depth: entry.depth + 1 });
    }
  }
  return true;
}

function runtimeEvent(value: unknown, elided = false): boolean {
  if (
    !record(value) ||
    !text(value.method) ||
    !text(value.threadId) ||
    !text(value.provider) ||
    !text(value.createdAt)
  )
    return false;
  if (
    ![
      'eventId',
      'turnId',
      'itemId',
      'requestId',
      'sessionId',
      'prompt',
      'outputText',
      'delta',
      'message',
      'summary',
      'description',
      'title',
      'reason',
      'nextAction',
      'routeBackTo',
      'namespace',
      'runId',
      'definitionId',
      'verdict',
      'outcome',
      'toolName',
      'toolCallId',
      'from',
      'to',
    ].every((key) => optionalText(value[key]))
  )
    return false;
  if (value.metadata !== undefined && !record(value.metadata)) return false;
  if (!freshness(value.freshness)) return false;
  if (value.method === 'flow.gate-verdict' && !verdict(value)) return false;
  if (elided) return true;
  if (
    ['turn.started', 'turn.completed', 'turn.aborted'].includes(value.method) &&
    !text(value.turnId)
  )
    return false;
  if (
    value.method === 'content.text-delta' ||
    value.method === 'content.reasoning-delta'
  )
    return typeof value.delta === 'string';
  if (value.method.startsWith('tool.') && !text(value.toolCallId)) return false;
  if (value.method === 'tool.started' && !text(value.toolName)) return false;
  if (value.method === 'tool.progress' && typeof value.message !== 'string')
    return false;
  if (value.method.startsWith('request.') && !text(value.requestId))
    return false;
  if (value.method === 'plan.updated')
    return list(
      value.entries,
      (entry) =>
        record(entry) &&
        typeof entry.content === 'string' &&
        typeof entry.status === 'string',
    );
  if (value.method === 'policy.stop-verdict')
    return list(value.warnings, (warning) => typeof warning === 'string');
  return true;
}
function freshness(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      (value.lastEvaluatedAt === null || optionalText(value.lastEvaluatedAt)) &&
      optionalText(value.blockedReason) &&
      (value.gateOutcomeCount === undefined ||
        (typeof value.gateOutcomeCount === 'number' &&
          Number.isFinite(value.gateOutcomeCount))))
  );
}
function flowRun(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      text(value.runId) &&
      text(value.definitionId) &&
      optionalText(value.currentStep) &&
      freshness(value.freshness))
  );
}
function verdict(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      text(value.runId) &&
      text(value.verdict) &&
      ['summary', 'nextAction', 'routeBackTo', 'gateId'].every((key) =>
        optionalText(value[key]),
      ) &&
      (value.missing === undefined ||
        list(value.missing, (item) => typeof item === 'string')) &&
      (value.reportPaths === undefined ||
        (record(value.reportPaths) &&
          text(value.reportPaths.json) &&
          text(value.reportPaths.markdown))))
  );
}
function handoff(value: unknown): boolean {
  return (
    record(value) &&
    text(value.sessionId) &&
    text(value.predecessorSessionId) &&
    ['targetAgentId', 'targetConnectionId', 'targetModelId'].every((key) =>
      optionalText(value[key]),
    ) &&
    list(value.carried, (item) => typeof item === 'string') &&
    list(value.reset, (item) => typeof item === 'string')
  );
}
function contentParts(value: unknown): boolean {
  return (
    value === undefined ||
    list(
      value,
      (part) =>
        record(part) &&
        text(part.type) &&
        [
          'content',
          'text',
          'url',
          'image',
          'mediaType',
          'name',
          'toolName',
          'toolCallId',
          'error',
          'errorText',
          'progressMessage',
          'state',
        ].every((key) => optionalText(part[key])) &&
        (part.uiBlock === undefined || record(part.uiBlock)) &&
        flowRun(part.flowRunAttached) &&
        verdict(part.flowGateVerdict) &&
        (part.conversationHandoff === undefined ||
          handoff(part.conversationHandoff)) &&
        (part.conversationContextBoundary === undefined ||
          (record(part.conversationContextBoundary) &&
            typeof part.conversationContextBoundary.priorTranscriptInjected ===
              'boolean')),
    )
  );
}
function initialChat(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  if (
    !['status', 'orchestrationStatus', 'openTurnId', 'model', 'provider'].every(
      (key) => optionalText(value[key]),
    )
  )
    return false;
  if (
    ![
      'orchestrationTurnOpen',
      'orchestrationSessionStarted',
      'openTurnShellSuperseded',
    ].every((key) => optionalBoolean(value[key]))
  )
    return false;
  if (
    value.messages !== undefined &&
    !list(
      value.messages,
      (message) =>
        record(message) &&
        typeof message.role === 'string' &&
        ['user', 'assistant', 'system'].includes(message.role) &&
        optionalText(message.content) &&
        (message.timestamp === undefined ||
          (typeof message.timestamp === 'number' &&
            Number.isFinite(message.timestamp))) &&
        optionalBoolean(message.answerEligible) &&
        contentParts(message.contentParts),
    )
  )
    return false;
  const streaming = value.streamingMessage;
  return (
    streaming === undefined ||
    (record(streaming) &&
      optionalText(streaming.content) &&
      optionalText(streaming.text) &&
      contentParts(streaming.contentParts))
  );
}
function history(value: unknown): boolean {
  return (
    record(value) &&
    list(
      value.events,
      (entry) =>
        record(entry) &&
        Number.isSafeInteger(entry.sequence) &&
        Number(entry.sequence) >= 0 &&
        (entry.elided === undefined ||
          entry.elided === 'byte_limit' ||
          entry.elided === 'output_limit') &&
        runtimeEvent(entry.event, entry.elided === 'byte_limit'),
    ) &&
    list(value.handoffs, handoff) &&
    list(
      value.contextBoundaries,
      (item) =>
        record(item) && text(item.successorSessionId) && text(item.policy),
    ) &&
    (value.sessionLineage === undefined ||
      list(
        value.sessionLineage,
        (item) =>
          record(item) && text(item.sessionId) && optionalText(item.agentSlug),
      )) &&
    ['hasMore', 'loading', 'settled', 'upgradeRequired'].every(
      (key) => typeof value[key] === 'boolean',
    ) &&
    optionalText(value.errorMessage) &&
    optionalText(value.currentSessionId)
  );
}
function frame(value: unknown): boolean {
  if (
    !record(value) ||
    typeof value.atMs !== 'number' ||
    !Number.isFinite(value.atMs) ||
    value.atMs < 0
  )
    return false;
  switch (value.kind) {
    case 'clock':
      return true;
    case 'runtime':
      return runtimeEvent(value.event);
    case 'history':
      return history(value.state);
    case 'snapshot':
      return (
        typeof value.reconnect === 'boolean' &&
        record(value.payload) &&
        list(
          value.payload.sessions,
          (session) =>
            record(session) &&
            text(session.threadId) &&
            text(session.provider) &&
            text(session.status) &&
            optionalBoolean(session.hasActiveTurn),
        )
      );
    case 'connection':
      return (
        typeof value.status === 'string' &&
        ['receiving', 'interrupted', 'closed', 'caught-up'].includes(
          value.status,
        )
      );
    default:
      return false;
  }
}

export function tapeValidationError(
  value: unknown,
  kind: string,
): string | undefined {
  if (!boundedJson(value))
    return 'The recording exceeds nesting limits or contains non-JSON data.';
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== kind ||
    !text(value.recordedAt)
  )
    return 'Unsupported recording header.';
  const source = value.source;
  if (
    !record(source) ||
    !text(source.threadId) ||
    !text(source.agentSlug) ||
    !['model', 'provider', 'conversationId'].every((key) =>
      optionalText(source[key]),
    )
  )
    return 'Invalid recording source.';
  if (!Array.isArray(value.events) || value.events.length > MAX_TAPE_FRAMES)
    return 'The recording exceeds the 20,000-event limit.';
  const invalidEvent = value.events.findIndex((item) => !runtimeEvent(item));
  if (invalidEvent >= 0) return `Invalid runtime event ${invalidEvent + 1}.`;
  if (!initialChat(value.initialChat)) return 'Invalid initial chat state.';
  if (value.initialHistory !== undefined && !history(value.initialHistory))
    return 'Invalid initial history state.';
  if (
    !(
      value.coverage === undefined ||
      value.coverage === 'server-events' ||
      value.coverage === 'client-capture'
    ) ||
    !optionalBoolean(value.redacted) ||
    !optionalText(value.stoppedReason)
  )
    return 'Invalid recording coverage.';
  if (value.frames === undefined) return undefined;
  if (!Array.isArray(value.frames) || value.frames.length > MAX_TAPE_FRAMES)
    return 'The recording exceeds the 20,000-frame limit.';
  let previous = 0;
  for (const [index, item] of value.frames.entries()) {
    if (!frame(item)) return `Invalid replay frame ${index + 1}.`;
    const atMs = (item as { atMs: number }).atMs;
    if (atMs < previous)
      return `Time moves backward at replay frame ${index + 1}.`;
    previous = atMs;
  }
  return undefined;
}
export function validateTapeContents(value: unknown, kind: string): boolean {
  return tapeValidationError(value, kind) === undefined;
}
