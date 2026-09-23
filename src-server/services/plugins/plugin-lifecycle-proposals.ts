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
 *   per conversation, {@link MAX_OPEN_PROPOSALS_PER_ENGINE} per engine (a
 *   runtime-verified agent, all self-reported agents together, or one
 *   person by principal id), and {@link MAX_OPEN_PROPOSALS} open in total,
 *   so one engine cannot fill the inbox. Resolved records are retained up to
 *   {@link MAX_RETAINED_RESOLVED_PROPOSALS}, newest first.
 * - **Strict sources (#2323 S5 review M2).** See
 *   {@link resolvePluginProposalSource}: no credentials, query, fragment,
 *   non-ASCII or IP/private hosts, and no invisible format characters in a
 *   source or rationale. Git sources are stored normalized, and deduplicate
 *   by host (case-insensitive) and path (without `.git` or a trailing
 *   slash).
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
  PluginProposalDigestUnavailableReason,
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
export const MAX_OPEN_PROPOSALS_PER_ENGINE = 15;
const MAX_OPEN_PROPOSALS = 50;
const MAX_RETAINED_RESOLVED_PROPOSALS = 100;
const MAX_PROPOSAL_RATIONALE_LENGTH = 2000;
const MAX_PROPOSAL_SOURCE_LENGTH = 4096;

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
  | {
      kind: 'git';
      /** The normalized source Station stores and a person installs. */
      source: string;
      host: string;
      path: string;
    };

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/**
 * Invisible and direction-changing characters: every Unicode format
 * character (Cf: bidi overrides and isolates, zero-width space/joiners, the
 * BOM, soft hyphen…) plus the line and paragraph separators. A source or
 * rationale containing one can render as something other than what it is.
 */
const FORMAT_CHARACTERS = /[\p{Cf}\u2028\u2029]/u;

function hasFormatCharacter(value: string): boolean {
  return FORMAT_CHARACTERS.test(value);
}

/** One DNS name of two or more lowercase ASCII labels, not all-numeric. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRIVATE_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.lan',
  '.home.arpa',
];

/**
 * A git host must be a public-looking DNS name: ASCII only (no IDN, and no
 * `xn--` punycode either, since a person reading a lookalike's punycode is
 * not protected by it), at least two labels, no IP literal, and none of the
 * private-network suffixes. This is a string check; it does not resolve the
 * name, so a public name that resolves privately is not caught here (the
 * clone only happens later, when a person previews it).
 */
function refuseGitHost(host: string): string | null {
  if (!/^[\x21-\x7e]+$/.test(host))
    return 'Git hosts must be plain ASCII names.';
  const lower = host.toLowerCase();
  if (lower.length > 253) return 'That git host name is too long.';
  const labels = lower.split('.');
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label)))
    return 'Git hosts must be DNS names such as github.com.';
  if (labels.some((label) => label.startsWith('xn--')))
    return 'Internationalized (punycode) git host names are refused; ask the person to add this source themselves.';
  if (/^\d+$/.test(labels[labels.length - 1]!))
    return 'IP-address git hosts are refused.';
  if (
    lower === 'localhost' ||
    PRIVATE_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  )
    return 'Loopback and private-network git hosts are refused.';
  return null;
}

/** A repository path: ASCII segments, no `..`, no leading `-`. */
function refuseGitPath(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    !segments.every(
      (segment) =>
        /^[A-Za-z0-9._~-]+$/.test(segment) &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.startsWith('-'),
    )
  )
    return 'A git source path may contain only letters, digits, and . _ ~ - between slashes.';
  return null;
}

function trimRepoPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * What an install proposal may name, and its normalized spelling.
 *
 * A local folder goes through S1's `resolvePluginValidateSource` (absolute,
 * no UNC/device/automount path), so a proposal never makes Station stat a
 * network path on an agent's say-so. A remote source must be
 * `https://<host>/<path>` with no user info, password, port, query or
 * fragment, or `git@<host>:<path>`, with the host and path rules above; it
 * is stored normalized (lowercase host, no trailing slash) and never
 * fetched. Pure string checks, no filesystem or network access.
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
    hasControlCharacter(source) ||
    hasFormatCharacter(raw)
  ) {
    throw new PluginProposalInvalidError(
      'source-invalid',
      'That plugin source contains characters Station does not accept in a path or URL.',
    );
  }
  const local = resolvePluginValidateSource(source);
  if (local.ok) return { kind: 'local', source: local.path };
  if (local.diagnostic.code !== 'remote-source-refused') {
    throw new PluginProposalInvalidError(
      local.diagnostic.code,
      local.diagnostic.message,
    );
  }
  const refuse = (message: string): never => {
    throw new PluginProposalInvalidError('source-unsupported', message);
  };
  if (/\s/.test(source)) refuse('A git source cannot contain whitespace.');
  const scp = /^git@([^/:@]+):(.+)$/.exec(source);
  if (scp) {
    const host = scp[1]!;
    const hostRefusal = refuseGitHost(host);
    if (hostRefusal) refuse(hostRefusal);
    const path = trimRepoPath(scp[2]!);
    const pathRefusal = refuseGitPath(path);
    if (pathRefusal) refuse(pathRefusal);
    const lower = host.toLowerCase();
    return { kind: 'git', source: `git@${lower}:${path}`, host: lower, path };
  }
  if (!/^https:\/\//i.test(source))
    refuse(
      'A remote plugin source must be a git HTTPS URL (https://host/path) or git@host:path.',
    );
  const authority = source.slice('https://'.length).split(/[/?#]/, 1)[0]!;
  if (authority.includes('@'))
    refuse('A git URL must not carry a user name or password.');
  if (source.includes('?') || source.includes('#'))
    refuse('A git URL must not carry a query or fragment.');
  if (authority.includes(':')) refuse('A git URL must not name a port.');
  const hostRefusal = refuseGitHost(authority);
  if (hostRefusal) refuse(hostRefusal);
  const path = trimRepoPath(source.slice('https://'.length + authority.length));
  const pathRefusal = refuseGitPath(path);
  if (pathRefusal) refuse(pathRefusal);
  const host = authority.toLowerCase();
  return { kind: 'git', source: `https://${host}/${path}`, host, path };
}

/**
 * The identity two proposals share when they ask for the same thing: a
 * local folder by its normalized path; a git repository by host and path,
 * whichever spelling (https or git@), without `.git`.
 */
export function pluginProposalSourceKey(source: string): string {
  try {
    const resolved = resolvePluginProposalSource(source);
    if (resolved.kind === 'local') return `local:${resolved.source}`;
    return `repo:${resolved.host}/${resolved.path.replace(/\.git$/, '')}`;
  } catch {
    return `raw:${source.trim()}`;
  }
}

/** Bounded, canonical, human-written text. */
function normalizeProposalRationale(raw: string): string {
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
  // The raw text, not the trimmed one: `trim` removes a leading or trailing
  // BOM, which is exactly a character this refuses.
  if (hasFormatCharacter(raw)) {
    throw new PluginProposalInvalidError(
      'rationale-invalid',
      'A rationale cannot contain invisible or direction-changing characters.',
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
      proposedContentDigestUnavailable?: PluginProposalDigestUnavailableReason;
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
    ? `install:${pluginProposalSourceKey(proposal.source ?? '')}`
    : `${proposal.kind}:${proposal.pluginName ?? ''}`;
}

/**
 * The conversation an author is counted against, when it names one. A
 * self-reported conversation id can be varied freely, so the engine cap
 * below is what actually bounds a single caller.
 */
function conversationKey(author: PluginLifecycleProposalAuthor): string | null {
  return author.principal === 'agent' && author.conversationId
    ? `conversation:${author.reportedBy ?? 'caller'}:${author.conversationId}`
    : null;
}

/**
 * The engine an author is counted against: one person (by principal id), one
 * runtime-verified agent, or every self-reported agent together — a name an
 * external engine writes for itself cannot buy it a fresh allowance.
 */
function engineKey(author: PluginLifecycleProposalAuthor): string {
  if (author.principal === 'person')
    return `person:${author.principalId ?? 'unresolved'}`;
  return author.reportedBy === 'runtime' && author.agentSlug
    ? `agent:${author.agentSlug}`
    : 'agent:self-reported';
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
    !isOptionalString(value.author.principalId) ||
    (value.author.reportedBy !== undefined &&
      value.author.reportedBy !== 'runtime' &&
      value.author.reportedBy !== 'caller') ||
    !isOptionalString(value.proposedContentDigestUnavailable) ||
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

  /**
   * The draft a proposal input names, normalized. Throws the same refusals
   * `propose` would.
   */
  private draftFor(input: PluginLifecycleProposalInput) {
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
    return draft;
  }

  /** Dedupe, then the three caps. `null` means a new proposal is admitted. */
  private admit(
    open: PluginLifecycleProposal[],
    draft: {
      kind: PluginLifecycleProposalKind;
      source?: string;
      pluginName?: string;
    },
    author: PluginLifecycleProposalAuthor,
  ): PluginLifecycleProposal | null {
    const existing = open.find(
      (proposal) => target(proposal) === target(draft),
    );
    if (existing) return existing;
    const conversation = conversationKey(author);
    if (
      conversation &&
      open.filter(
        (proposal) => conversationKey(proposal.author) === conversation,
      ).length >= MAX_OPEN_PROPOSALS_PER_AUTHOR
    ) {
      throw new PluginProposalLimitError(
        `This conversation already has ${MAX_OPEN_PROPOSALS_PER_AUTHOR} open plugin proposals. Wait for a person to complete or dismiss one.`,
      );
    }
    const engine = engineKey(author);
    if (
      open.filter((proposal) => engineKey(proposal.author) === engine).length >=
      MAX_OPEN_PROPOSALS_PER_ENGINE
    ) {
      throw new PluginProposalLimitError(
        `This proposer already has ${MAX_OPEN_PROPOSALS_PER_ENGINE} open plugin proposals. Wait for a person to complete or dismiss some.`,
      );
    }
    if (open.length >= MAX_OPEN_PROPOSALS) {
      throw new PluginProposalLimitError(
        `Station already has ${MAX_OPEN_PROPOSALS} open plugin proposals. Wait for a person to complete or dismiss some.`,
      );
    }
    return null;
  }

  /**
   * Read-only admission check the route runs BEFORE any expensive work (the
   * digest walk): a duplicate returns the existing proposal, a capped caller
   * is refused, and nothing is written. `propose` repeats the check under
   * the lock, so a race between the two can only refuse or deduplicate, never
   * overshoot a cap.
   */
  precheck(
    input: PluginLifecycleProposalInput,
  ): { existing: PluginLifecycleProposal } | { admitted: true } {
    normalizeProposalRationale(input.rationale);
    const draft = this.draftFor(input);
    const existing = this.admit(this.listOpen(), draft, input.author);
    return existing ? { existing } : { admitted: true };
  }

  async propose(
    input: PluginLifecycleProposalInput,
  ): Promise<{ proposal: PluginLifecycleProposal; deduplicated: boolean }> {
    const rationale = normalizeProposalRationale(input.rationale);
    const draft = this.draftFor(input);
    return this.mutate<{
      proposal: PluginLifecycleProposal;
      deduplicated: boolean;
    }>((data) => {
      const open = data.proposals.filter(
        (proposal) => proposal.status === 'open',
      );
      const existing = this.admit(open, draft, input.author);
      if (existing) {
        return { result: { proposal: existing, deduplicated: true } };
      }
      const at = this.now().toISOString();
      const author = input.author;
      const proposal: PluginLifecycleProposal = {
        id: randomUUID(),
        ...draft,
        rationale,
        author: {
          principal: author.principal,
          ...(author.principalId ? { principalId: author.principalId } : {}),
          ...(author.agentSlug ? { agentSlug: author.agentSlug } : {}),
          ...(author.conversationId
            ? { conversationId: author.conversationId }
            : {}),
          ...(author.reportedBy ? { reportedBy: author.reportedBy } : {}),
        },
        createdAt: at,
        updatedAt: at,
        ...(input.kind === 'install' && input.proposedContentDigest
          ? { proposedContentDigest: input.proposedContentDigest }
          : input.kind === 'install' && input.proposedContentDigestUnavailable
            ? {
                proposedContentDigestUnavailable:
                  input.proposedContentDigestUnavailable,
              }
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
        ? { kind: completion.kind, source: completion.source }
        : { kind: completion.kind, pluginName: completion.pluginName };
    return this.mutate<PluginProposalCompletionOutcome>((data) => {
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
