/**
 * The narrow authored-spec policy boundary enforced before a session reaches
 * an adapter. Catalog callers supply whether their server-side spec
 * resolution found the same Agent definition the session resolver would
 * attach.
 *
 * archive#3027: provider-INDEPENDENT by design. The original claude-only
 * check left every other engine default (codex, kiro, opencode, muse)
 * starting spec-less, and any provider name-list here would silently miss
 * kiro/opencode — they dispatch at runtime with provider 'acp'. So this
 * function never consults the provider at all: a session agent slug that
 * did not resolve to an authored Agent definition refuses, whoever the
 * engine is. Callers whose provider has no session-delivery concept
 * (Station's own engine, managed model runtimes) own that exemption by
 * answering `hasResolvedAgent` truthfully for their layer — see
 * `resolveSessionAgentForStart` in orchestration-service.ts.
 */
export function sessionAgentStartUnavailableReason(input: {
  agentSlug: unknown;
  hasResolvedAgent: boolean;
  unresolvedReason?: string;
}): string | null {
  if (
    typeof input.agentSlug !== 'string' ||
    input.agentSlug.length === 0 ||
    input.hasResolvedAgent
  ) {
    return null;
  }
  return (
    input.unresolvedReason ??
    // "could not be resolved", not "does not have": the session resolver
    // also reports unresolved after a transient spec-load failure, where an
    // authored definition may well exist on disk (see the resolver's catch).
    `Agent '${input.agentSlug}' could not be resolved to an authored Agent definition, so this session cannot start. Enable this engine by creating an Agent for it — new chats will run as that Agent.`
  );
}
