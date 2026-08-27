import { join } from 'node:path';
import type { WorkingMemoryScope } from '@voltagent/core';

export class MemoryAdapterPaths {
  constructor(private readonly projectHomeDir: string) {}

  getAgentsDir(): string {
    return join(this.projectHomeDir, 'agents');
  }

  getAgentMemoryDir(resourceId: string): string {
    return join(this.getAgentsDir(), resourceId, 'memory');
  }

  getConversationsDir(resourceId: string): string {
    return join(this.getAgentMemoryDir(resourceId), 'conversations');
  }

  getConversationPath(resourceId: string, conversationId: string): string {
    return join(this.getConversationsDir(resourceId), `${conversationId}.json`);
  }

  getSessionsDir(resourceId: string): string {
    return join(this.getAgentMemoryDir(resourceId), 'sessions');
  }

  getMessagesPath(resourceId: string, conversationId: string): string {
    return join(this.getSessionsDir(resourceId), `${conversationId}.ndjson`);
  }

  getWorkingMemoryDir(resourceId: string, scope: WorkingMemoryScope): string {
    return join(this.getAgentMemoryDir(resourceId), 'working', scope);
  }

  getConversationWorkingMemoryPath(
    resourceId: string,
    conversationId: string,
  ): string {
    return join(
      this.getWorkingMemoryDir(resourceId, 'conversation'),
      `${conversationId}.json`,
    );
  }

  getUserWorkingMemoryPath(resourceId: string, userId: string): string {
    return join(
      this.getWorkingMemoryDir(resourceId, 'user'),
      `${this.sanitizeId(userId)}.json`,
    );
  }

  getWorkflowStatesDir(): string {
    return join(this.projectHomeDir, 'workflows', 'states');
  }

  getWorkflowStatePath(executionId: string): string {
    return join(this.getWorkflowStatesDir(), `${executionId}.json`);
  }

  sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9-_]/g, '_');
  }
}
