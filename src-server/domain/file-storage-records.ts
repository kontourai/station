import {
  listProjectSlugs,
  mutateJsonFile,
  readJsonFile,
  resolveProjectSlugById,
} from './file-storage-helpers.js';
import { ProjectFileTransactions } from './project-file-transactions.js';
import type {
  ConversationRecord,
  DocumentRecord,
  LayoutAgentReference,
} from './storage-adapter.js';

type RecordListParser<T> = (value: unknown) => T[];

export function listStoredRecords<T>(
  path: string,
  fallback: T[] = [],
  parse: RecordListParser<T> = (value) => value as T[],
): T[] {
  return parse(readJsonFile<unknown>(path, fallback));
}

export function saveStoredRecord<T extends { id: string }>(
  path: string,
  record: T,
  parse: RecordListParser<T> = (value) => value as T[],
): Promise<void> {
  return mutateJsonFile<unknown>(path, [], (value) => {
    const records = parse(value);
    const index = records.findIndex((entry) => entry.id === record.id);
    if (index >= 0) records[index] = record;
    else records.push(record);
    return records;
  }).then(() => undefined);
}

export function deleteStoredRecord<T extends { id: string }>(
  path: string,
  id: string,
  parse: RecordListParser<T> = (value) => value as T[],
): Promise<boolean> {
  let deleted = false;
  return mutateJsonFile<unknown>(path, [], (value) => {
    const records = parse(value);
    const index = records.findIndex((entry) => entry.id === id);
    if (index < 0) return records;
    records.splice(index, 1);
    deleted = true;
    return records;
  }).then(() => deleted);
}

export function findStoredRecordAcrossProjects<T extends { id: string }>(
  projectHomeDir: string,
  resolvePath: (projectSlug: string) => string,
  id: string,
  parse: RecordListParser<T> = (value) => value as T[],
): T | null {
  for (const slug of listProjectSlugs(projectHomeDir)) {
    const found = listStoredRecords<T>(resolvePath(slug), [], parse).find(
      (record) => record.id === id,
    );
    if (found) return found;
  }
  return null;
}

export function saveProjectScopedRecord<
  T extends { id: string; projectId: string },
>(
  projectHomeDir: string,
  resolvePath: (projectSlug: string) => string,
  record: T,
  parse: RecordListParser<T> = (value) => value as T[],
  transactions: ProjectFileTransactions = new ProjectFileTransactions(
    projectHomeDir,
  ),
): Promise<void> {
  const projectSlug = resolveProjectSlugById(projectHomeDir, record.projectId);
  return transactions.upsertRecord(
    projectSlug,
    record.projectId,
    resolvePath(projectSlug),
    record,
    parse,
  );
}

export function deleteProjectScopedRecord<
  T extends { id: string; projectId: string },
>(
  projectHomeDir: string,
  resolvePath: (projectSlug: string) => string,
  id: string,
  parse: RecordListParser<T> = (value) => value as T[],
  transactions: ProjectFileTransactions = new ProjectFileTransactions(
    projectHomeDir,
  ),
): Promise<boolean> {
  return deleteProjectScopedRecordFromSlugs<T>(
    listProjectSlugs(projectHomeDir),
    resolvePath,
    id,
    parse,
    transactions,
  );
}

async function deleteProjectScopedRecordFromSlugs<
  T extends { id: string; projectId: string },
>(
  slugs: readonly string[],
  resolvePath: (projectSlug: string) => string,
  id: string,
  parse: RecordListParser<T>,
  transactions: ProjectFileTransactions,
): Promise<boolean> {
  for (const slug of slugs) {
    const candidate = listStoredRecords(resolvePath(slug), [], parse).find(
      (record) => record.id === id,
    );
    if (!candidate) continue;
    try {
      if (
        await transactions.deleteRecord(
          slug,
          candidate.projectId,
          resolvePath(slug),
          candidate,
          parse,
        )
      )
        return true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'file_storage_not_found') {
        throw error;
      }
    }
  }
  return false;
}

export function listSortedConversations(
  path: string,
  opts?: { limit?: number; offset?: number },
  parse?: RecordListParser<ConversationRecord>,
): ConversationRecord[] {
  let records = listStoredRecords<ConversationRecord>(path, [], parse);
  records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (opts?.offset) records = records.slice(opts.offset);
  if (opts?.limit) records = records.slice(0, opts.limit);
  return records;
}

export function buildLayoutAgentReferences(
  projects: Array<{ slug: string }>,
  listLayouts: (projectSlug: string) => Array<{ slug: string }>,
  getLayoutConfig: (projectSlug: string, layoutSlug: string) => any,
  agentSlug: string,
  // Agent identity is exact; no synthetic aliases are accepted.
  slugsMatch: (a: string, b: string) => boolean = (a, b) => a === b,
): LayoutAgentReference[] {
  const references: LayoutAgentReference[] = [];

  for (const project of projects) {
    for (const layout of listLayouts(project.slug)) {
      const config = getLayoutConfig(project.slug, layout.slug).config as {
        tabs?: Array<{
          skills?: Array<{ agent?: string }>;
          actions?: Array<{ agent?: string }>;
        }>;
        globalSkills?: Array<{ agent?: string }>;
        actions?: Array<{ agent?: string }>;
        defaultAgent?: string;
        availableAgents?: string[];
      };

      const refersToAgent = (candidate: string | undefined): boolean =>
        candidate !== undefined && slugsMatch(candidate, agentSlug);

      const tabs = config.tabs ?? [];
      const isReferencedInTabs = tabs.some(
        (tab) =>
          (tab.skills ?? []).some((skill) => refersToAgent(skill.agent)) ||
          (tab.actions ?? []).some((action) => refersToAgent(action.agent)),
      );
      const isReferencedGlobally =
        (config.globalSkills ?? []).some((skill) =>
          refersToAgent(skill.agent),
        ) ||
        (config.actions ?? []).some((action) => refersToAgent(action.agent));
      const isConfiguredAgent =
        refersToAgent(config.defaultAgent) ||
        (config.availableAgents ?? []).some((slug) => refersToAgent(slug));

      if (isReferencedInTabs || isReferencedGlobally || isConfiguredAgent) {
        references.push({
          projectSlug: project.slug,
          layoutSlug: layout.slug,
        });
      }
    }
  }

  return references;
}

export type { ConversationRecord, DocumentRecord };
