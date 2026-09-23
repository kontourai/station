/**
 * Plugin lifecycle proposals (#2323 S5): the store behind "agent proposes,
 * person installs".
 *
 * Station's agent tools cannot install, update or remove a plugin (the
 * routes refuse the internal caller class; see
 * `routes/plugins/plugin-person-approval.ts`). An agent that wants one of
 * those changes records a proposal here instead. A person sees it in Needs
 * attention, opens it in Plugins, and completes it through the ordinary
 * flow; completing marks it `completed`, and a person can `dismiss` it.
 *
 * Properties, each structural:
 *
 * - **No decision authority.** A record holds what was asked and who asked.
 *   Nothing in it is read by `/install` as a consent basis, and its digest is
 *   only the comparison point for "changed since proposed".
 * - **Deduplicated.** An open proposal with the same kind and target
 *   (normalized source, or plugin name) is returned instead of a second one,
 *   whoever asked, so repeating a tool call cannot flood the inbox.
 * - **Capped.** At most {@link MAX_OPEN_PROPOSALS_PER_AUTHOR} open proposals
 *   per author (conversation when known, else agent, else principal) and
 *   {@link MAX_OPEN_PROPOSALS} open in total. Resolved records are retained
 *   up to {@link MAX_RETAINED_RESOLVED_PROPOSALS}, newest first.
 * - **Serialized read-decide-write.** Every mutation runs inside one file
 *   mutation lock around read → decide → write, the same shape
 *   `ProposedChangeService` uses, so a concurrent create and dismiss cannot
 *   interleave into a lost update. The store is stateless per call, so
 *   separate instances over the same file (the routes and the attention
 *   projection) agree.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  PluginLifecycleProposal,
  PluginLifecycleProposalAuthor,
  PluginLifecycleProposalKind,
} from '@kontourai/station-contracts/plugin';
import {
  acquireFileMutationLockAsync,
  type FileMutationLock,
} from '@kontourai/station-shared/lifecycle-events';
import { isRecord } from '../../utils/is-record.js';
import { JsonFileStore } from '../infra/json-store.js';
import { resolvePluginValidateSource } from './plugin-validate-source.js';

export const PLUGIN_LIFECYCLE_PROPOSALS_FILE =
  'plugin-lifecycle-proposals.json';
export const MAX_OPEN_PROPOSALS_PER_AUTHOR = 5;
export const MAX_OPEN_PROPOSALS = 50;
export const MAX_RETAINED_RESOLVED_PROPOSALS = 100;
export const MAX_PROPOSAL_RATIONALE_LENGTH = 2000;
export const MAX_PROPOSAL_SOURCE_LENGTH = 4096;

interface PluginLifecycleProposalStoreData {
  proposals: PluginLifecycleProposal[];
}

export class PluginProposalLimitError extends Error {
  readonly code = 'proposal-limit';
  constructor(message: string) {
    super(message);
    this.name = 'PluginProposalLimitError';
  }
}

export class PluginProposalNotFoundError extends Error {
  readonly code = 'proposal-not-found';
  constructor(id: string) {
    super(`Plugin proposal not found: ${id}`);
    this.name = 'PluginProposalNotFoundError';
  }
}

export class PluginProposalNotOpenError extends Error {
  readonly code = 'proposal-not-open';
  constructor(id: string, status: string) {
    super(`Plugin proposal ${id} is already ${status}.`);
    this.name = 'PluginProposalNotOpenError';
  }
}

export class PluginProposalInvalidError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'PluginProposalInvalidError';
  }
}

export type PluginProposalSource =
  | { kind: 'local'; source: string }
  | { kind: 'git'; source: string };

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/**
 * What an install proposal may name, and its normalized spelling.
 *
 * A local folder goes through S1's `resolvePluginValidateSource` (absolute,
 * no UNC/device/automount path), so a proposal never makes Station stat a
 * network path on an agent's say-so. A remote source must be a git HTTPS URL
 * or an scp-style `git@host:path`; proposing never clones it. Pure string
 * checks, no filesystem access.
 */
export function resolvePluginProposalSource(raw: string): PluginProposalSource {
  const source = raw.trim();
  if (!source) {
    throw new PluginProposalInvalidError(
      'source-required',
      'An install proposal needs a source: the absolute path of a local plugin folder, or a git URL.',
    );
  }
  if (
    source.length > MAX_PROPOSAL_SOURCE_LENGTH ||
    hasControlCharacter(source)
  ) {
    throw new PluginProposalInvalidError(
      'source-invalid',
      'That plugin source is not a path or URL Station accepts.',
    );
  }
  const local = resolvePluginValidateSource(source);
  if (local.ok) return { kind: 'local', source: local.path };
  if (local.diagnostic.code === 'remote-source-refused') {
    if (/\s/.test(source)) {
      throw new PluginProposalInvalidError(
        'source-invalid',
        'A git source cannot contain whitespace.',
      );
    }
    if (/^git@[^/\\:\s]+:[^\s]+$/.test(source)) {
      return { kind: 'git', source };
    }
    let url: URL | undefined;
    try {
      url = new URL(source);
    } catch {
      url = undefined;
    }
    if (url?.protocol === 'https:' && url.hostname && !url.username) {
      return { kind: 'git', source };
    }
    throw new PluginProposalInvalidError(
      'source-unsupported',
      'A remote plugin source must be a git HTTPS URL (https://…) or git@host:path.',
    );
  }
  throw new PluginProposalInvalidError(
    local.diagnostic.code,
    local.diagnostic.message,
  );
}

/** Bounded, canonical, human-written text. */
export function normalizeProposalRationale(raw: string): string {
  const rationale = raw.trim();
  if (!rationale) {
    throw new PluginProposalInvalidError(
      'rationale-required',
      'Say why: a proposal needs a rationale the person can read.',
    );
  }
  if (rationale.length > MAX_PROPOSAL_RATIONALE_LENGTH) {
    throw new PluginProposalInvalidError(
      'rationale-too-long',
      `A rationale is at most ${MAX_PROPOSAL_RATIONALE_LENGTH} characters.`,
    );
  }
  return rationale;
}

export type PluginLifecycleProposalInput =
  | {
      kind: 'install';
      source: string;
      rationale: string;
      author: PluginLifecycleProposalAuthor;
      proposedContentDigest?: string;
    }
  | {
      kind: 'update' | 'remove';
      pluginName: string;
      rationale: string;
      author: PluginLifecycleProposalAuthor;
    };

/** What a completing route actually did, so only a matching proposal closes. */
export type PluginProposalCompletion =
  | { kind: 'install'; source: string }
  | { kind: 'update' | 'remove'; pluginName: string };

export type PluginProposalCompletionOutcome =
  | { status: 'completed'; proposal: PluginLifecycleProposal }
  | { status: 'not-found' }
  | { status: 'not-open'; proposal: PluginLifecycleProposal }
  | { status: 'mismatch'; proposal: PluginLifecycleProposal };

function target(proposal: {
  kind: PluginLifecycleProposalKind;
  source?: string;
  pluginName?: string;
}): string {
  return proposal.kind === 'install'
    ? `install:${proposal.source ?? ''}`
    : `${proposal.kind}:${proposal.pluginName ?? ''}`;
}

function authorKey(author: PluginLifecycleProposalAuthor): string {
  if (author.conversationId) return `conversation:${author.conversationId}`;
  if (author.agentSlug) return `agent:${author.agentSlug}`;
  return `principal:${author.principal}`;
}

const KINDS = new Set(['install', 'update', 'remove']);
const STATUSES = new Set(['open', 'completed', 'dismissed']);

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function validateRecord(value: unknown): PluginLifecycleProposal {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !KINDS.has(value.kind as string) ||
    !STATUSES.has(value.status as string) ||
    typeof value.rationale !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !isOptionalString(value.source) ||
    !isOptionalString(value.pluginName) ||
    !isOptionalString(value.proposedContentDigest) ||
    !isOptionalString(value.resolvedAt) ||
    !isRecord(value.author) ||
    (value.author.principal !== 'agent' &&
      value.author.principal !== 'person') ||
    !isOptionalString(value.author.agentSlug) ||
    !isOptionalString(value.author.conversationId) ||
    (value.kind === 'install'
      ? typeof value.source !== 'string'
      : typeof value.pluginName !== 'string')
  ) {
    throw new Error('Invalid plugin lifecycle proposal store');
  }
  return value as unknown as PluginLifecycleProposal;
}

function validateStore(value: unknown): PluginLifecycleProposalStoreData {
  if (!isRecord(value) || !Array.isArray(value.proposals)) {
    throw new Error('Invalid plugin lifecycle proposal store');
  }
  return { proposals: value.proposals.map(validateRecord) };
}

export interface PluginLifecycleProposalServiceOptions {
  /** Injectable only for deterministic concurrency tests. */
  acquireMutationLock?: FileMutationLock;
  now?: () => Date;
}

export class PluginLifecycleProposalService {
  private readonly filePath: string;
  private readonly store: JsonFileStore<PluginLifecycleProposalStoreData>;
  private readonly acquireMutationLock: FileMutationLock;
  private readonly now: () => Date;

  constructor(
    projectHomeDir: string,
    options: PluginLifecycleProposalServiceOptions = {},
  ) {
    this.filePath = join(projectHomeDir, PLUGIN_LIFECYCLE_PROPOSALS_FILE);
    this.store = new JsonFileStore(
      this.filePath,
      { proposals: [] },
      { onCorruption: 'throw', durableAtomicWrite: true },
    );
    this.acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
    this.now = options.now ?? (() => new Date());
  }

  private read(): PluginLifecycleProposalStoreData {
    return validateStore(this.store.read());
  }

  listOpen(): PluginLifecycleProposal[] {
    return this.read().proposals.filter(
      (proposal) => proposal.status === 'open',
    );
  }

  get(id: string): PluginLifecycleProposal | null {
    return this.read().proposals.find((proposal) => proposal.id === id) ?? null;
  }

  async propose(
    input: PluginLifecycleProposalInput,
  ): Promise<{ proposal: PluginLifecycleProposal; deduplicated: boolean }> {
    const rationale = normalizeProposalRationale(input.rationale);
    const draft =
      input.kind === 'install'
        ? {
            kind: input.kind,
            source: resolvePluginProposalSource(input.source).source,
          }
        : { kind: input.kind, pluginName: input.pluginName.trim() };
    if (draft.kind !== 'install' && !draft.pluginName) {
      throw new PluginProposalInvalidError(
        'plugin-name-required',
        'Name the installed plugin this proposal is about.',
      );
    }
    return this.mutate((data) => {
      const open = data.proposals.filter(
        (proposal) => proposal.status === 'open',
      );
      const existing = open.find(
        (proposal) => target(proposal) === target(draft),
      );
      if (existing) {
        return { result: { proposal: existing, deduplicated: true } };
      }
      const key = authorKey(input.author);
      if (
        open.filter((proposal) => authorKey(proposal.author) === key).length >=
        MAX_OPEN_PROPOSALS_PER_AUTHOR
      ) {
        throw new PluginProposalLimitError(
          `This conversation already has ${MAX_OPEN_PROPOSALS_PER_AUTHOR} open plugin proposals. Wait for a person to complete or dismiss one.`,
        );
      }
      if (open.length >= MAX_OPEN_PROPOSALS) {
        throw new PluginProposalLimitError(
          `Station already has ${MAX_OPEN_PROPOSALS} open plugin proposals. Wait for a person to complete or dismiss some.`,
        );
      }
      const at = this.now().toISOString();
      const proposal: PluginLifecycleProposal = {
        id: randomUUID(),
        ...draft,
        rationale,
        author: {
          principal: input.author.principal,
          ...(input.author.agentSlug
            ? { agentSlug: input.author.agentSlug }
            : {}),
          ...(input.author.conversationId
            ? { conversationId: input.author.conversationId }
            : {}),
        },
        createdAt: at,
        updatedAt: at,
        ...(input.kind === 'install' && input.proposedContentDigest
          ? { proposedContentDigest: input.proposedContentDigest }
          : {}),
        status: 'open',
      };
      return {
        result: { proposal, deduplicated: false },
        next: { proposals: [proposal, ...data.proposals] },
      };
    });
  }

  /**
   * Called by the install, update and remove routes AFTER the change
   * succeeded. Closes the proposal only when it asked for what was done: an
   * install of a different source, or an update of a different plugin,
   * leaves it open and says so.
   */
  async complete(
    id: string,
    completion: PluginProposalCompletion,
  ): Promise<PluginProposalCompletionOutcome> {
    const done =
      completion.kind === 'install'
        ? {
            kind: completion.kind,
            source: safeNormalizedSource(completion.source),
          }
        : { kind: completion.kind, pluginName: completion.pluginName };
    return this.mutate((data) => {
      const current = data.proposals.find((proposal) => proposal.id === id);
      if (!current) return { result: { status: 'not-found' as const } };
      if (current.status !== 'open') {
        return { result: { status: 'not-open' as const, proposal: current } };
      }
      if (target(current) !== target(done)) {
        return { result: { status: 'mismatch' as const, proposal: current } };
      }
      const updated = this.resolve(current, 'completed');
      return {
        result: { status: 'completed' as const, proposal: updated },
        next: this.replace(data, updated),
      };
    });
  }

  async dismiss(id: string): Promise<PluginLifecycleProposal> {
    return this.mutate((data) => {
      const current = data.proposals.find((proposal) => proposal.id === id);
      if (!current) throw new PluginProposalNotFoundError(id);
      if (current.status !== 'open') {
        throw new PluginProposalNotOpenError(id, current.status);
      }
      const updated = this.resolve(current, 'dismissed');
      return { result: updated, next: this.replace(data, updated) };
    });
  }

  private resolve(
    proposal: PluginLifecycleProposal,
    status: 'completed' | 'dismissed',
  ): PluginLifecycleProposal {
    const at = this.now().toISOString();
    return { ...proposal, status, updatedAt: at, resolvedAt: at };
  }

  private replace(
    data: PluginLifecycleProposalStoreData,
    updated: PluginLifecycleProposal,
  ): PluginLifecycleProposalStoreData {
    const proposals = data.proposals.map((proposal) =>
      proposal.id === updated.id ? updated : proposal,
    );
    const open = proposals.filter((proposal) => proposal.status === 'open');
    const resolved = proposals
      .filter((proposal) => proposal.status !== 'open')
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .slice(0, MAX_RETAINED_RESOLVED_PROPOSALS);
    return { proposals: [...open, ...resolved] };
  }

  private async mutate<T>(
    mutation: (data: PluginLifecycleProposalStoreData) => {
      result: T;
      next?: PluginLifecycleProposalStoreData;
    },
  ): Promise<T> {
    const release = await this.acquireMutationLock(`${this.filePath}.mutation`);
    try {
      const outcome = mutation(this.read());
      if (outcome.next) this.store.write(validateStore(outcome.next));
      return outcome.result;
    } finally {
      await release();
    }
  }
}

/** A completing install's source, normalized the way proposals store it. */
function safeNormalizedSource(source: string): string {
  try {
    return resolvePluginProposalSource(source).source;
  } catch {
    return source.trim();
  }
}
