import { existsSync } from 'node:fs';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import type { WorkflowStateEntry, WorkingMemoryScope } from '@voltagent/core';
import { createLogger } from '../../utils/logger.js';
import { withFileMutation } from './memory-adapter-mutation-queue.js';
import { MemoryAdapterPaths } from './memory-adapter-paths.js';
import {
  deserializeWorkflowState,
  serializeWorkflowState,
  type WorkflowStateJson,
} from './memory-adapter-workflows.js';

const logger = createLogger({ name: 'memory-adapter-state' });

/*
 * Unreachable in Station today (#3564), kept and made safe rather than
 * removed. These are `StorageAdapter` methods that VoltAgent calls, and
 * nothing in Station calls them directly:
 *
 * - Working memory: VoltAgent's `Memory` reads and writes it only when
 *   `workingMemory.enabled` is set. Both `new Memory(...)` sites in
 *   `runtime/frameworks/voltagent-adapter.ts` pass `storage` only.
 * - Workflow state: VoltAgent writes it only for registered workflows. The
 *   only `new VoltAgent(...)` call (`runtime/bootstrap/runtime-initialize.ts`)
 *   registers agents and no workflows.
 *
 * They cannot be deleted: `FileMemoryAdapter` implements VoltAgent's
 * `StorageAdapter`, whose interface requires every one of these methods, and
 * a stub that throws or silently drops would turn enabling either feature
 * into data loss. So each write goes through the same per-path queue as the
 * transcript and is published by temp file, fsync and rename: concurrent
 * writers cannot interleave, and a reader sees the previous document or the
 * new one, never a truncated file. Reads take no lock; the rename makes them
 * safe. Scope is in-process, as for the transcript.
 */

export async function getWorkingMemoryState({
  paths,
  resolveResourceId,
  conversationId,
  userId,
  scope,
}: {
  paths: MemoryAdapterPaths;
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
  conversationId?: string;
  userId?: string;
  scope: WorkingMemoryScope;
}): Promise<string | null> {
  const resourceId = await resolveResourceId(conversationId, userId);

  if (scope === 'conversation') {
    if (!conversationId) return null;
    const path = paths.getConversationWorkingMemoryPath(
      resourceId,
      conversationId,
    );
    if (!existsSync(path)) {
      const legacyPath = join(
        paths.getAgentMemoryDir(resourceId),
        'working',
        `${conversationId}.json`,
      );
      if (!existsSync(legacyPath)) {
        return null;
      }
      const legacyContent = await readFile(legacyPath, 'utf-8');
      const legacyData = JSON.parse(legacyContent) as {
        memory?: string;
        content?: string;
      };
      return legacyData.memory ?? legacyData.content ?? null;
    }
    const content = await readFile(path, 'utf-8');
    const data = JSON.parse(content) as { content?: string };
    return data.content ?? null;
  }

  if (!userId) return null;
  const path = paths.getUserWorkingMemoryPath(resourceId, userId);
  if (!existsSync(path)) {
    return null;
  }
  const content = await readFile(path, 'utf-8');
  const data = JSON.parse(content) as { content?: string };
  return data.content ?? null;
}

export async function setWorkingMemoryState({
  paths,
  resolveResourceId,
  conversationId,
  userId,
  content,
  scope,
}: {
  paths: MemoryAdapterPaths;
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
  conversationId?: string;
  userId?: string;
  content: string;
  scope: WorkingMemoryScope;
}): Promise<void> {
  const resourceId = await resolveResourceId(conversationId, userId);
  const payload = {
    content,
    updatedAt: new Date().toISOString(),
  };

  if (scope === 'conversation') {
    if (!conversationId) {
      throw new Error(
        'conversationId is required for conversation-scoped working memory',
      );
    }
    const path = paths.getConversationWorkingMemoryPath(
      resourceId,
      conversationId,
    );
    await withFileMutation(path, () =>
      publishJsonFileWithOwnedLock(path, payload),
    );
    return;
  }

  if (!userId) {
    throw new Error('userId is required for user-scoped working memory');
  }

  const path = paths.getUserWorkingMemoryPath(resourceId, userId);
  await withFileMutation(path, () =>
    publishJsonFileWithOwnedLock(path, payload),
  );
}

export async function deleteWorkingMemoryState({
  paths,
  resolveResourceId,
  conversationId,
  userId,
  scope,
}: {
  paths: MemoryAdapterPaths;
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
  conversationId?: string;
  userId?: string;
  scope: WorkingMemoryScope;
}): Promise<void> {
  const resourceId = await resolveResourceId(conversationId, userId);

  if (scope === 'conversation') {
    if (!conversationId) return;
    const path = paths.getConversationWorkingMemoryPath(
      resourceId,
      conversationId,
    );
    await withFileMutation(path, () => removeIfPresent(path));
    return;
  }

  if (!userId) return;
  const path = paths.getUserWorkingMemoryPath(resourceId, userId);
  await withFileMutation(path, () => removeIfPresent(path));
}

/** Delete inside the queue slot, so a write queued before it lands first. */
async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function getWorkflowStateEntry(
  paths: MemoryAdapterPaths,
  executionId: string,
): Promise<WorkflowStateEntry | null> {
  const path = paths.getWorkflowStatePath(executionId);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await readFile(path, 'utf-8');
    return deserializeWorkflowState(JSON.parse(content) as WorkflowStateJson);
  } catch (error) {
    logger.error('Failed to read workflow state', { error });
    return null;
  }
}

export async function setWorkflowStateEntry(
  paths: MemoryAdapterPaths,
  executionId: string,
  state: WorkflowStateEntry,
): Promise<void> {
  const path = paths.getWorkflowStatePath(executionId);
  await withFileMutation(path, () => publishWorkflowState(path, state));
}

function publishWorkflowState(
  path: string,
  state: WorkflowStateEntry,
): Promise<void> {
  return publishJsonFileWithOwnedLock(path, serializeWorkflowState(state));
}

/**
 * Merge `updates` into the stored entry. The read, the merge and the write
 * share one queue slot: with the read outside it, two updates to different
 * fields both start from the same entry and the later write drops the
 * earlier one's change.
 */
export async function updateWorkflowStateEntry(
  paths: MemoryAdapterPaths,
  executionId: string,
  updates: Partial<WorkflowStateEntry>,
): Promise<void> {
  const path = paths.getWorkflowStatePath(executionId);
  await withFileMutation(path, async () => {
    const existing = await getWorkflowStateEntry(paths, executionId);
    if (!existing) {
      throw new Error(`Workflow state ${executionId} not found`);
    }

    const merged: WorkflowStateEntry = {
      ...existing,
      ...updates,
      createdAt: existing.createdAt,
      updatedAt: updates.updatedAt ?? new Date(),
    };

    if (merged.suspension && existing.suspension) {
      merged.suspension = {
        ...existing.suspension,
        ...updates.suspension,
      };
    }

    await publishWorkflowState(path, merged);
  });
}

export async function getSuspendedWorkflowStateEntries(
  paths: MemoryAdapterPaths,
  workflowId: string,
): Promise<WorkflowStateEntry[]> {
  const dir = paths.getWorkflowStatesDir();
  if (!existsSync(dir)) {
    return [];
  }

  const files = await readdir(dir);
  const states: WorkflowStateEntry[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const path = join(dir, file);
    try {
      const content = await readFile(path, 'utf-8');
      const parsed = JSON.parse(content) as WorkflowStateJson;
      const state = deserializeWorkflowState(parsed);
      if (
        state &&
        state.status === 'suspended' &&
        state.workflowId === workflowId
      ) {
        states.push(state);
      }
    } catch (error) {
      logger.error('Failed to parse workflow state', { error });
    }
  }

  return states;
}
