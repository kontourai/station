import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WorkflowStateEntry, WorkingMemoryScope } from '@voltagent/core';
import { createLogger } from '../../utils/logger.js';
import { MemoryAdapterPaths } from './memory-adapter-paths.js';
import {
  deserializeWorkflowState,
  serializeWorkflowState,
  type WorkflowStateJson,
} from './memory-adapter-workflows.js';

const logger = createLogger({ name: 'memory-adapter-state' });

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
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
    return;
  }

  if (!userId) {
    throw new Error('userId is required for user-scoped working memory');
  }

  const path = paths.getUserWorkingMemoryPath(resourceId, userId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
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
    if (existsSync(path)) {
      await unlink(path);
    }
    return;
  }

  if (!userId) return;
  const path = paths.getUserWorkingMemoryPath(resourceId, userId);
  if (existsSync(path)) {
    await unlink(path);
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
  const dir = paths.getWorkflowStatesDir();
  await mkdir(dir, { recursive: true });
  const path = paths.getWorkflowStatePath(executionId);
  await writeFile(
    path,
    JSON.stringify(serializeWorkflowState(state), null, 2),
    'utf-8',
  );
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
