/**
 * archive#4543 LOW-2: the exact shape `delegateTask` itself mints
 * (`task:${randomUUID()}`) — and the only shape `metadata.conversationId`/
 * `metadata.environmentId` may be re-stamped from via the
 * `conversationIdentity` internal escape hatch (validated by this shared helper). `environmentId` is always server-resolved
 * (`target.environmentId`), but `conversationId` is stamped from
 * `sessionId`, and an MCP tool caller MAY supply a custom `sessionId`
 * (`station-control-operations-tools.ts`'s `sessionId` param) — an
 * unvalidated arbitrary string would otherwise get laundered through a
 * RESERVED_ORCHESTRATION_METADATA_KEYS key whose contract
 * (`provider.ts`'s `CONVERSATION_ID_RESERVED_METADATA_KEY` docblock) is
 * "always resolved by Station", not caller-supplied.
 */
export function isDelegatedTaskSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
