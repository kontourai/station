/**
 * What a new chat in a Project starts with when the Project chooses
 * `last-used` (`@kontourai/station-contracts/project-chat-defaults`).
 *
 * "Last used" is recorded, not guessed: the session start records the model
 * and the approval mode a person's interactive chat in a Project STARTED
 * with, once that start has succeeded (`OrchestrationService`'s
 * `recordStarted`). A failed start records nothing, so a model that could not
 * launch is never offered again as "last used".
 *
 *   <home>/project-chat-last-used.json
 *   { "version": 1, "entries": [ { "projectId", "projectSlug", "userId",
 *     "models": [{ "agentSlug", "modelId", "startedAt" }],
 *     "approval": { "approvalMode", "startedAt" }, "updatedAt" } ] }
 *
 * Entries are per Project AND per user: one person's choice is never another
 * person's default. An entry also names the Project's id, so a Project deleted
 * and re-created under the same slug inherits nothing.
 *
 * Only the person's own interactive chats count ({@link isPersonChatStart}).
 * A delegation, a webhook, an automatic replay or an agent's start neither
 * records a value nor inherits one.
 */
import { renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  isProjectChatApprovalPosture,
  isProjectChatDefaultSelection,
  type ProjectChatApprovalPosture,
  type ProjectChatDefaultsView,
  type ProjectChatLastUsedApproval,
  type ProjectChatLastUsedModel,
  resolveProjectChatApprovalDefault,
} from '@kontourai/station-contracts/project-chat-defaults';
import {
  mutateJsonFileWithGuardedRead,
  readJsonFile,
  readTextFileBounded,
} from '@kontourai/station-shared/json-file-storage';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'project-chat-defaults' });

const LAST_USED_FILE = 'project-chat-last-used.json';
const MAX_DOCUMENT_BYTES = 512 * 1024;
const LABEL = 'Project chat last-used record';
/** Oldest entries (by `updatedAt`) are dropped past this. */
const MAX_ENTRIES = 256;
/** One per Agent, newest first. */
const MAX_MODELS_PER_ENTRY = 16;

export interface LastUsedEntry {
  projectId: string;
  projectSlug: string;
  userId: string;
  models: ProjectChatLastUsedModel[];
  approval?: ProjectChatLastUsedApproval;
  updatedAt: string;
}

export interface LastUsedDocument {
  version: 1;
  entries: LastUsedEntry[];
}

const EMPTY_DOCUMENT: LastUsedDocument = { version: 1, entries: [] };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseModel(value: unknown): ProjectChatLastUsedModel | undefined {
  const entry = value as Partial<ProjectChatLastUsedModel> | null;
  return entry &&
    nonEmpty(entry.agentSlug) &&
    nonEmpty(entry.modelId) &&
    nonEmpty(entry.startedAt)
    ? {
        agentSlug: entry.agentSlug,
        modelId: entry.modelId,
        startedAt: entry.startedAt,
      }
    : undefined;
}

/** Drops any entry or field that is not the shape this module writes. */
function parseDocument(value: unknown): LastUsedDocument {
  const entries = (value as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return { version: 1, entries: [] };
  const parsed: LastUsedEntry[] = [];
  for (const raw of entries) {
    const entry = raw as Partial<LastUsedEntry> | null;
    if (
      !entry ||
      !nonEmpty(entry.projectId) ||
      !nonEmpty(entry.projectSlug) ||
      !nonEmpty(entry.userId) ||
      !nonEmpty(entry.updatedAt)
    )
      continue;
    const models = Array.isArray(entry.models)
      ? entry.models
          .map(parseModel)
          .filter((model): model is ProjectChatLastUsedModel => !!model)
      : [];
    const approval =
      entry.approval &&
      isProjectChatApprovalPosture(entry.approval.approvalMode) &&
      nonEmpty(entry.approval.startedAt)
        ? {
            approvalMode: entry.approval.approvalMode,
            startedAt: entry.approval.startedAt,
          }
        : undefined;
    parsed.push({
      projectId: entry.projectId,
      projectSlug: entry.projectSlug,
      userId: entry.userId,
      models,
      ...(approval ? { approval } : {}),
      updatedAt: entry.updatedAt,
    });
  }
  return { version: 1, entries: parsed };
}

/**
 * Whether a `/chat` request is a person's own interactive chat. Not one: a
 * request that may be an agent's (`requestMayBeAnAgent`: the internal
 * principal, or an agent-originated call such as `station chat` run by an
 * agent through Station's tools), a paired peer Station's delegation
 * credential, a delegation, an automatic replay (`/chat/background`), or a
 * start attributed to an agent.
 */
export function isPersonChatRequest(request: {
  mayBeAnAgent: boolean;
  inboundDeviceKind?: 'device' | 'delegation';
  automaticBackground: boolean;
  delegated: boolean;
  ownerAttributed: boolean;
}): boolean {
  return (
    !request.mayBeAnAgent &&
    request.inboundDeviceKind !== 'delegation' &&
    !request.automaticBackground &&
    !request.delegated &&
    !request.ownerAttributed
  );
}

/**
 * Bytes the written document may take: the read bound, less room for the
 * publisher's own serialization differences. A document over it would be
 * refused by the next read, so writes prune to fit instead.
 */
const WRITE_BUDGET_BYTES = MAX_DOCUMENT_BYTES - 4 * 1024;

function serializedBytes(document: LastUsedDocument): number {
  return Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/**
 * `document` pruned to fit {@link WRITE_BUDGET_BYTES}: the oldest entries go
 * first, then the oldest models of the one entry left. The entries arrive
 * newest first. Exported for its test.
 */
export function fitDocument(document: LastUsedDocument): LastUsedDocument {
  const entries = [...document.entries];
  while (
    entries.length > 1 &&
    serializedBytes({ version: 1, entries }) > WRITE_BUDGET_BYTES
  )
    entries.pop();
  const [only] = entries;
  if (
    entries.length === 1 &&
    only &&
    serializedBytes({ version: 1, entries }) > WRITE_BUDGET_BYTES
  ) {
    const models = [...only.models];
    while (
      models.length > 0 &&
      serializedBytes({ version: 1, entries: [{ ...only, models }] }) >
        WRITE_BUDGET_BYTES
    )
      models.pop();
    entries[0] = { ...only, models };
  }
  return { version: 1, entries };
}

/**
 * Whether a session start is a person's own interactive chat in a Project:
 * the only kind that records a last-used value and the only kind that
 * inherits one.
 *
 * - `personChatStart` is set only by the `/chat` route, from the request
 *   ({@link isPersonChatRequest}), and carried by the foreground seam
 *   (`station-control-delegation.ts`) only for a start that is not ephemeral
 *   and carries no delegation. Absent does not count.
 * - The request's actor is the operator or a paired device. An agent's
 *   station-control call is the `internal` actor.
 * - Not a resume: a continuation's child session re-runs what its
 *   conversation already chose.
 */
export function isPersonChatStart(
  input: { metadata?: Record<string, unknown>; resumeCursor?: unknown },
  context: {
    userId?: string;
    clientOrigin?: Pick<ClientOrigin, 'actor'>;
    ownerAttribution?: unknown;
  },
  internal: { personChatStart?: true } | undefined,
): boolean {
  const actor = context.clientOrigin?.actor.kind;
  return (
    internal?.personChatStart === true &&
    (actor === 'operator' || actor === 'device') &&
    context.ownerAttribution === undefined &&
    input.resumeCursor === undefined &&
    input.metadata?.delegation === undefined &&
    nonEmpty(input.metadata?.projectSlug) &&
    nonEmpty(context.userId)
  );
}

export interface ProjectChatStart {
  projectSlug: string;
  userId: string;
  agentSlug?: string;
  modelId?: string;
  /** The mode the start resolved and handed the engine, if any. */
  approvalMode?: unknown;
  startedAt: string;
}

export class ProjectChatDefaultsService {
  private readonly path: string;

  constructor(
    private readonly deps: {
      homeDir: string;
      /** This Station's Project record by slug; `undefined` when none. */
      getProject: (slug: string) => ProjectConfig | undefined;
    },
  ) {
    this.path = join(deps.homeDir, LAST_USED_FILE);
  }

  /**
   * An unreadable document is reported and read as empty: every value it
   * could have held is one a `last-used` Project falls back from to its own
   * fixed default, which the operator chose, so nothing looser than that
   * applies.
   */
  private readDocument(): LastUsedDocument {
    try {
      return parseDocument(
        readJsonFile<unknown>(this.path, EMPTY_DOCUMENT, {
          maxBytes: MAX_DOCUMENT_BYTES,
          label: LABEL,
        }),
      );
    } catch (error) {
      logger.warn('Project chat last-used record unreadable; using none', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { version: 1, entries: [] };
    }
  }

  /**
   * The current document for a write, read under the write's path lock.
   *
   * Only a document this module can prove is unusable is moved aside: one
   * over the size bound (judged from its size, before reading) or one that is
   * not JSON. Either would refuse every later write forever, so it goes to
   * `<file>.corrupt-<time>`, is reported, and the write starts from empty;
   * only last-used values are lost. Any other failure (permissions, too many
   * open files, an I/O error) says nothing about the bytes, so it propagates:
   * the write fails and is logged by its caller, and the history stays.
   */
  private readForWrite(): unknown {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return EMPTY_DOCUMENT;
      throw error;
    }
    if (size > MAX_DOCUMENT_BYTES)
      return this.quarantine(`over its ${MAX_DOCUMENT_BYTES}-byte bound`);
    const text = readTextFileBounded(this.path, MAX_DOCUMENT_BYTES, LABEL);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return this.quarantine(`not JSON: ${error.message}`);
    }
  }

  private quarantine(reason: string): unknown {
    const quarantine = `${this.path}.corrupt-${Date.now()}`;
    try {
      renameSync(this.path, quarantine);
    } catch (renameError) {
      // Nothing to move aside is the same outcome as moving it.
      if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT')
        throw renameError;
    }
    logger.warn('Project chat last-used record unusable; moved aside', {
      quarantine,
      reason,
    });
    return EMPTY_DOCUMENT;
  }

  /** The caller's recorded values in `project`; empty when none. */
  lastUsed(
    project: Pick<ProjectConfig, 'id' | 'slug'>,
    userId: string,
  ): {
    models: ProjectChatLastUsedModel[];
    approval?: ProjectChatLastUsedApproval;
  } {
    const entry = this.readDocument().entries.find(
      (candidate) =>
        candidate.projectId === project.id &&
        candidate.projectSlug === project.slug &&
        candidate.userId === userId,
    );
    return entry
      ? {
          models: entry.models,
          ...(entry.approval ? { approval: entry.approval } : {}),
        }
      : { models: [] };
  }

  /** `GET /api/projects/:slug/chat-defaults` for a person's next chat. */
  view(
    project: ProjectConfig,
    userId: string,
    options: { mayGrantFullAccess: boolean },
  ): ProjectChatDefaultsView {
    const recorded = this.lastUsed(project, userId);
    const fixed = isProjectChatApprovalPosture(project.defaultApprovalMode)
      ? project.defaultApprovalMode
      : undefined;
    const approvalSelection = isProjectChatDefaultSelection(
      project.defaultApprovalModeSelection,
    )
      ? project.defaultApprovalModeSelection
      : 'fixed';
    return {
      version: 'station.project-chat-defaults/v1',
      projectSlug: project.slug,
      model: {
        selection: isProjectChatDefaultSelection(project.defaultModelSelection)
          ? project.defaultModelSelection
          : 'fixed',
        lastUsed: recorded.models,
      },
      approvalMode: {
        selection: approvalSelection,
        ...(fixed ? { fixed } : {}),
        ...(recorded.approval ? { lastUsed: recorded.approval } : {}),
        resolved: resolveProjectChatApprovalDefault({
          selection: approvalSelection,
          fixed,
          lastUsed: recorded.approval,
          lastUsedApplies: true,
          mayGrantFullAccess: options.mayGrantFullAccess,
        }),
      },
    };
  }

  /**
   * The Project's layer of a session start's approval posture, or
   * `undefined` when the Project does not decide (or the slug names no
   * Project here).
   */
  approvalDefault(input: {
    projectSlug: string;
    userId?: string;
    lastUsedApplies: boolean;
    mayGrantFullAccess: boolean;
  }): ProjectChatApprovalPosture | undefined {
    const project = this.deps.getProject(input.projectSlug);
    if (!project) return undefined;
    const lastUsedApplies = input.lastUsedApplies && nonEmpty(input.userId);
    return resolveProjectChatApprovalDefault({
      selection: project.defaultApprovalModeSelection,
      fixed: project.defaultApprovalMode,
      lastUsed:
        lastUsedApplies && input.userId
          ? this.lastUsed(project, input.userId).approval
          : undefined,
      lastUsedApplies,
      mayGrantFullAccess: input.mayGrantFullAccess,
    }).approvalMode;
  }

  /**
   * Record a person's successful chat start. Every Project records, whatever
   * its selection, so switching a Project to `last-used` has history to use.
   */
  async recordStart(start: ProjectChatStart): Promise<void> {
    const project = this.deps.getProject(start.projectSlug);
    if (!project) return;
    const model =
      nonEmpty(start.agentSlug) && nonEmpty(start.modelId)
        ? {
            agentSlug: start.agentSlug,
            modelId: start.modelId.trim(),
            startedAt: start.startedAt,
          }
        : undefined;
    const approval = isProjectChatApprovalPosture(start.approvalMode)
      ? { approvalMode: start.approvalMode, startedAt: start.startedAt }
      : undefined;
    if (!model && !approval) return;
    await mutateJsonFileWithGuardedRead<unknown>(
      this.path,
      EMPTY_DOCUMENT,
      async () => this.readForWrite(),
      (current) => {
        const document = parseDocument(current);
        const existing = document.entries.find(
          (entry) =>
            entry.projectId === project.id &&
            entry.projectSlug === project.slug &&
            entry.userId === start.userId,
        );
        const others = document.entries.filter((entry) => entry !== existing);
        // Two starts can finish writing in either order (each write waits
        // for the path lock on its own), so a value only replaces an older
        // one: the record always names the most recent start.
        const newer = (candidate: { startedAt: string }, than?: string) =>
          than === undefined || candidate.startedAt >= than;
        const previousModel = model
          ? existing?.models.find(
              (entry) => entry.agentSlug === model.agentSlug,
            )
          : undefined;
        const models =
          model && newer(model, previousModel?.startedAt)
            ? [
                model,
                ...(existing?.models ?? []).filter(
                  (entry) => entry.agentSlug !== model.agentSlug,
                ),
              ]
            : (existing?.models ?? []);
        const nextApproval =
          approval && newer(approval, existing?.approval?.startedAt)
            ? approval
            : existing?.approval;
        const next: LastUsedEntry = {
          projectId: project.id,
          projectSlug: project.slug,
          userId: start.userId,
          models: [...models]
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
            .slice(0, MAX_MODELS_PER_ENTRY),
          ...(nextApproval ? { approval: nextApproval } : {}),
          updatedAt:
            existing && existing.updatedAt > start.startedAt
              ? existing.updatedAt
              : start.startedAt,
        };
        const entries = [next, ...others]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, MAX_ENTRIES);
        return fitDocument({ version: 1, entries });
      },
      { maxBytes: MAX_DOCUMENT_BYTES, label: LABEL },
    );
  }
}

/**
 * The service over this Station's own Project store. A slug no Project has is
 * `undefined`; a Project record that cannot be read propagates (a start then
 * fails, as it does for the Agent's own default).
 */
export function createProjectChatDefaultsService(
  homeDir: string,
  projects: {
    listProjects(): readonly { slug: string }[];
    getProject(slug: string): ProjectConfig;
  },
): ProjectChatDefaultsService {
  return new ProjectChatDefaultsService({
    homeDir,
    getProject: (slug) =>
      projects.listProjects().some((project) => project.slug === slug)
        ? projects.getProject(slug)
        : undefined,
  });
}
