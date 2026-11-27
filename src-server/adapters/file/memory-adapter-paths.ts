import { isAbsolute, join, relative, sep } from 'node:path';
import type { WorkingMemoryScope } from '@voltagent/core';

/**
 * Characters Windows refuses in a file name. Native engine conversation ids
 * carry a colon (`codex:<id>`), which NTFS reads as an alternate data stream,
 * so writing those conversations failed with ENOENT and every fork of an
 * engine chat failed on Windows. They are percent-encoded there, `%` first so
 * the encoding stays reversible. Other platforms keep the plain id: they
 * could always write it, and existing files must keep their names.
 */
const WINDOWS_RESERVED_FILE_NAME_CHARS = /[%<>:"|?*]/g;

/** A conversation id whose file would resolve outside its directory. */
export class ConversationPathEscapeError extends Error {
  constructor() {
    super('Conversation id resolves outside its conversations directory');
    this.name = 'ConversationPathEscapeError';
  }
}

export class MemoryAdapterPaths {
  constructor(
    private readonly projectHomeDir: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private fileName(id: string): string {
    return this.platform === 'win32'
      ? id.replace(
          WINDOWS_RESERVED_FILE_NAME_CHARS,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        )
      : id;
  }

  getAgentsDir(): string {
    return join(this.projectHomeDir, 'agents');
  }

  getAgentMemoryDir(resourceId: string): string {
    return join(this.getAgentsDir(), resourceId, 'memory');
  }

  getConversationsDir(resourceId: string): string {
    return join(this.getAgentMemoryDir(resourceId), 'conversations');
  }

  /**
   * Refuses (`ConversationPathEscapeError`) an id whose file would resolve
   * outside the conversations directory (#3075 review: `../escaped` read
   * `memory/escaped.json`). Callers that take an id from a request parse it
   * first; this is the containment every caller gets.
   */
  getConversationPath(resourceId: string, conversationId: string): string {
    const directory = this.getConversationsDir(resourceId);
    const path = join(directory, `${this.fileName(conversationId)}.json`);
    const inside = relative(directory, path);
    if (inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new ConversationPathEscapeError();
    return path;
  }

  getSessionsDir(resourceId: string): string {
    return join(this.getAgentMemoryDir(resourceId), 'sessions');
  }

  getMessagesPath(resourceId: string, conversationId: string): string {
    return join(
      this.getSessionsDir(resourceId),
      `${this.fileName(conversationId)}.ndjson`,
    );
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
      `${this.fileName(conversationId)}.json`,
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
