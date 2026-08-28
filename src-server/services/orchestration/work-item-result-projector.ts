import {
  type GithubWorkItemRepository,
  parseSessionWorkItemAssociation,
  SESSION_WORK_ITEM_ASSOCIATION_V1,
  SESSION_WORK_ITEM_MAX_ID_BYTES,
  SESSION_WORK_ITEM_MAX_REPOSITORY_PART_BYTES,
  type SessionWorkItemAssociation,
  type SessionWorkItemPresentation,
  type SessionWorkItemReadProjection,
} from '@kontourai/station-contracts/session-work-item';
import {
  issueSessionWorkItemCandidateFromProjector,
  parseSessionWorkItemCandidate,
  type SessionWorkItemCandidate,
  type SessionWorkItemCandidateFields,
} from './session-work-item-candidate.js';

export const SESSION_WORK_ITEM_READ_MAX_OBSERVATIONS = 100;
export const SESSION_WORK_ITEM_READ_MAX_ITEMS = 50;
export const SESSION_WORK_ITEM_READ_MAX_ASSOCIATIONS_PER_ITEM = 20;
export const SESSION_WORK_ITEM_READ_MAX_SERIALIZED_BYTES = 64 * 1024;

const provenanceBrand = Symbol('work-item-result-projector-provenance');
const issuedProvenance = new WeakSet<object>();
const encoder = new TextEncoder();
const githubOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/;
const githubRepository = /^[A-Za-z0-9._-]{1,100}$/;

/** Capability minted by the reviewed MCP loader seam. */
export type WorkItemResultProjectorProvenance = {
  readonly serverId: 'github';
  readonly originalToolName: 'create_issue';
  readonly [provenanceBrand]: true;
};

/** Temporary loader-seam injection point; runtime composition owns this later. */
export function mintWorkItemResultProjectorProvenanceForReviewedLoader(): WorkItemResultProjectorProvenance {
  const value = Object.freeze({
    serverId: 'github' as const,
    originalToolName: 'create_issue' as const,
    [provenanceBrand]: true as const,
  });
  issuedProvenance.add(value);
  return value;
}

export type WorkItemResultProjectorInput = {
  associationId: string;
  sessionId: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
  terminalStatus: 'success' | 'error' | 'cancelled';
  provenance: WorkItemResultProjectorProvenance;
  /** Trusted, separately validated arguments from the reviewed loader seam. */
  githubArguments: { owner: string; repo: string; title: string };
  /** Raw MCP content is parsed here but never retained in the association. */
  content: unknown;
};

export type SessionWorkItemReadScope = {
  sessionId: string;
  conversationId: string;
};

export type SessionWorkItemReadOutcome =
  | { kind: 'available'; projection: SessionWorkItemReadProjection }
  | {
      kind: 'corrupt';
      code:
        | 'invalid-association'
        | 'scope-mismatch'
        | 'identity-conflict'
        | 'association-conflict'
        | 'bound-exceeded'
        | 'serialization-failed';
    };

type GithubMinimalCreateIssueResult = { id: string; url: string };
type ResultProjector = (
  input: WorkItemResultProjectorInput,
) => SessionWorkItemCandidateFields | null;

function exactRegistryKey(serverId: string, originalToolName: string): string {
  return JSON.stringify([serverId, originalToolName]);
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    encoder.encode(value).byteLength <= maxBytes
  );
}

function repository(
  owner: unknown,
  name: unknown,
): GithubWorkItemRepository | null {
  if (
    !boundedText(owner, SESSION_WORK_ITEM_MAX_REPOSITORY_PART_BYTES) ||
    !boundedText(name, SESSION_WORK_ITEM_MAX_REPOSITORY_PART_BYTES) ||
    !githubOwner.test(owner) ||
    !githubRepository.test(name) ||
    name === '.' ||
    name === '..'
  )
    return null;
  return { owner: owner.toLowerCase(), name: name.toLowerCase() };
}

function trustedArguments(
  value: WorkItemResultProjectorInput['githubArguments'],
): GithubWorkItemRepository | null {
  if (!plain(value) || Object.keys(value).length !== 3) return null;
  if (!boundedText(value.title, 240)) return null;
  return repository(value.owner, value.repo);
}

function parseMinimalResponse(
  content: unknown,
): GithubMinimalCreateIssueResult | null {
  try {
    if (!Array.isArray(content) || content.length !== 1 || !plain(content[0]))
      return null;
    const block = content[0];
    if (
      Object.keys(block).length !== 2 ||
      block.type !== 'text' ||
      !boundedText(block.text, 4096)
    )
      return null;
    const result: unknown = JSON.parse(block.text);
    if (
      !plain(result) ||
      Object.keys(result).length !== 2 ||
      !boundedText(result.id, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      !boundedText(result.url, SESSION_WORK_ITEM_MAX_ID_BYTES)
    )
      return null;
    return { id: result.id, url: result.url };
  } catch {
    return null;
  }
}

function issueNumberFromCanonicalUrl(
  rawUrl: string,
  repository: GithubWorkItemRepository,
): number | null {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    )
      return null;
    if (!rawUrl.startsWith('https://github.com/') || url.toString() !== rawUrl)
      return null;
    const path = url.pathname.split('/');
    if (
      path.length !== 5 ||
      path[0] !== '' ||
      path[1]?.toLowerCase() !== repository.owner ||
      path[2]?.toLowerCase() !== repository.name ||
      path[3] !== 'issues' ||
      !/^[1-9]\d*$/.test(path[4] ?? '')
    )
      return null;
    // Do not convert a fullDatabaseId/issue number to a JS number until after
    // grammar validation; the durable native id itself is never converted.
    const number = Number(path[4]);
    if (!Number.isSafeInteger(number)) return null;
    return number;
  } catch {
    return null;
  }
}

/** Safe browser link derived from a validated durable association only. */
export function deriveGithubIssueHttpsLink(
  association: SessionWorkItemAssociation,
): string | null {
  const parsed = parseSessionWorkItemAssociation(association);
  if (!parsed) return null;
  const match = /^github:([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(parsed.workItemRef);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  return `https://github.com/${parsed.repository.owner}/${parsed.repository.name}/issues/${number}`;
}

function projectGithubCreateIssue(
  input: WorkItemResultProjectorInput,
): SessionWorkItemCandidateFields | null {
  const repo = trustedArguments(input.githubArguments);
  const result = parseMinimalResponse(input.content);
  if (!repo || !result) return null;
  const number = issueNumberFromCanonicalUrl(result.url, repo);
  if (!number) return null;
  return parseSessionWorkItemCandidate({
    version: SESSION_WORK_ITEM_ASSOCIATION_V1,
    associationId: input.associationId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    relation: 'created',
    provider: { id: 'github', host: 'github.com' },
    workItemRef: `github:${repo.owner}/${repo.name}#${number}`,
    repository: repo,
    nativeId: result.id,
  });
}

/** Strict capability-gated registry; raw names alone do not dispatch. */
export class WorkItemResultProjector {
  private readonly registry = new Map<string, ResultProjector>([
    [exactRegistryKey('github', 'create_issue'), projectGithubCreateIssue],
  ]);

  project(
    input: WorkItemResultProjectorInput,
  ): SessionWorkItemCandidate | null {
    try {
      if (
        input.terminalStatus !== 'success' ||
        !issuedProvenance.has(input.provenance)
      )
        return null;
      const projected =
        this.registry.get(
          exactRegistryKey(
            input.provenance.serverId,
            input.provenance.originalToolName,
          ),
        )?.(input) ?? null;
      return projected
        ? issueSessionWorkItemCandidateFromProjector(projected)
        : null;
    } catch {
      return null;
    }
  }
}

function sameAssociation(
  left: SessionWorkItemAssociation,
  right: SessionWorkItemAssociation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Strict, bounded scoped read. It never silently truncates: callers receive
 * `corrupt/bound-exceeded` and must use a future continuation-capable read.
 */
export function projectSessionWorkItemRead(
  scope: SessionWorkItemReadScope,
  observations: readonly unknown[],
): SessionWorkItemReadOutcome {
  try {
    if (
      !boundedText(scope.sessionId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      !boundedText(scope.conversationId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      observations.length > SESSION_WORK_ITEM_READ_MAX_OBSERVATIONS
    )
      return { kind: 'corrupt', code: 'bound-exceeded' };
    const retained: SessionWorkItemAssociation[] = [];
    const associations = new Map<string, SessionWorkItemAssociation>();
    const sourceEvents = new Map<string, SessionWorkItemAssociation>();
    const nativeIdentities = new Map<string, string>();
    const items = new Map<
      string,
      { presentation: SessionWorkItemPresentation; associationIds: string[] }
    >();
    for (const observation of observations) {
      const parsed = parseSessionWorkItemAssociation(observation);
      if (!parsed) return { kind: 'corrupt', code: 'invalid-association' };
      if (
        parsed.sessionId !== scope.sessionId ||
        parsed.conversationId !== scope.conversationId
      )
        return { kind: 'corrupt', code: 'scope-mismatch' };
      const priorAssociation = associations.get(parsed.associationId);
      if (priorAssociation) {
        if (!sameAssociation(priorAssociation, parsed))
          return { kind: 'corrupt', code: 'association-conflict' };
        continue;
      }
      associations.set(parsed.associationId, parsed);
      const key = JSON.stringify([parsed.sessionId, parsed.workItemRef]);
      const sourceEventKey = JSON.stringify([
        parsed.sessionId,
        parsed.eventId,
        parsed.toolCallId,
      ]);
      const priorSourceEvent = sourceEvents.get(sourceEventKey);
      if (priorSourceEvent && !sameAssociation(priorSourceEvent, parsed))
        return { kind: 'corrupt', code: 'association-conflict' };
      sourceEvents.set(sourceEventKey, parsed);
      const nativeKey = JSON.stringify([
        parsed.provider.id,
        parsed.provider.host,
        parsed.nativeId,
      ]);
      const priorNativeIdentity = nativeIdentities.get(nativeKey);
      if (priorNativeIdentity && priorNativeIdentity !== key)
        return { kind: 'corrupt', code: 'identity-conflict' };
      nativeIdentities.set(nativeKey, key);
      const priorItem = items.get(key);
      if (priorItem) {
        const present = priorItem.presentation;
        if (
          present.conversationId !== parsed.conversationId ||
          present.nativeId !== parsed.nativeId ||
          present.provider.id !== parsed.provider.id ||
          present.provider.host !== parsed.provider.host ||
          present.repository.owner !== parsed.repository.owner ||
          present.repository.name !== parsed.repository.name
        )
          return { kind: 'corrupt', code: 'identity-conflict' };
        if (
          priorItem.associationIds.length >=
          SESSION_WORK_ITEM_READ_MAX_ASSOCIATIONS_PER_ITEM
        )
          return { kind: 'corrupt', code: 'bound-exceeded' };
        priorItem.associationIds.push(parsed.associationId);
      } else {
        if (items.size >= SESSION_WORK_ITEM_READ_MAX_ITEMS)
          return { kind: 'corrupt', code: 'bound-exceeded' };
        items.set(key, {
          presentation: {
            sessionId: parsed.sessionId,
            conversationId: parsed.conversationId,
            workItemRef: parsed.workItemRef,
            provider: parsed.provider,
            repository: parsed.repository,
            nativeId: parsed.nativeId,
            associationIds: [],
            observedAt: parsed.observedAt,
          },
          associationIds: [parsed.associationId],
        });
      }
      retained.push(parsed);
    }
    const projection: SessionWorkItemReadProjection = {
      version: SESSION_WORK_ITEM_ASSOCIATION_V1,
      observations: retained,
      items: [...items.values()].map(({ presentation, associationIds }) => ({
        ...presentation,
        associationIds,
      })),
    };
    if (
      encoder.encode(JSON.stringify(projection)).byteLength >
      SESSION_WORK_ITEM_READ_MAX_SERIALIZED_BYTES
    )
      return { kind: 'corrupt', code: 'bound-exceeded' };
    return { kind: 'available', projection };
  } catch {
    return { kind: 'corrupt', code: 'serialization-failed' };
  }
}
