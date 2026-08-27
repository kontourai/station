import { projectToolServerResult } from '../../services/plugins/tool-server-oauth.js';
import {
  NATIVE_OUTPUT_DECLARATION_TOOL,
  stripOutputDeclarationHandle,
} from '../native-output-declaration.js';
import type { InvocationContext } from '../types.js';

type StrandsContentBlock = {
  type?: string;
  text?: string;
  reasoningText?: string;
  toolUseId?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  status?: string;
  isError?: boolean;
};

type StrandsMessage = {
  role?: string;
  content?: StrandsContentBlock[];
};

type StrandsLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
};

type StrandsMessageMemory = {
  getMessages(userId: string, conversationId: string): Promise<any[]>;
  addMessage(
    msg: any,
    userId: string,
    conversationId: string,
    metadata?: any,
  ): Promise<void>;
};

/** The real FunctionTool object return is one JsonBlock holding only the handle. */
function isExactNativeDeclarationResult(block: StrandsContentBlock): boolean {
  const content = block.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const json = (content[0] as { json?: unknown } | undefined)?.json;
  return Boolean(
    json &&
      typeof json === 'object' &&
      !Array.isArray(json) &&
      Object.keys(json as Record<string, unknown>).length === 1 &&
      typeof (json as Record<string, unknown>).declarationHandle === 'string',
  );
}

export function mapStrandsContentBlocksToParts(
  blocks: StrandsContentBlock[] = [],
): any[] {
  const parts: any[] = [];
  // A handle is private only for the known registered native operation. A
  // user/MCP result that happens to use the same field name is ordinary data.
  const declarationCalls = new Set(
    blocks
      .filter(
        (block) =>
          block.type === 'toolUseBlock' &&
          block.name === NATIVE_OUTPUT_DECLARATION_TOOL &&
          typeof block.toolUseId === 'string',
      )
      .map((block) => block.toolUseId!),
  );

  for (const block of blocks) {
    if (block.text !== undefined) {
      parts.push({ type: 'text' as const, text: block.text || '' });
      continue;
    }

    if (block.reasoningText !== undefined || block.type === 'reasoningBlock') {
      parts.push({
        type: 'reasoning' as const,
        text: block.reasoningText || block.text || '',
      });
      continue;
    }

    if (block.type === 'toolUseBlock') {
      parts.push({
        type: 'tool-invocation' as const,
        toolInvocation: {
          toolCallId: block.toolUseId,
          toolName: block.name,
          args: block.input,
          state: 'result',
        },
      });
      continue;
    }

    if (block.type === 'toolResultBlock') {
      parts.push({
        type: 'tool-result' as const,
        toolCallId: block.toolUseId,
        result:
          declarationCalls.has(block.toolUseId ?? '') ||
          isExactNativeDeclarationResult(block)
            ? stripOutputDeclarationHandle(
                projectToolServerResult(block) === block
                  ? block.content
                  : projectToolServerResult(block),
              )
            : projectToolServerResult(block) === block
              ? block.content
              : projectToolServerResult(block),
      });
    }
  }

  return parts;
}

export async function syncStrandsMessagesToMemory({
  agentMessages,
  invocation,
  logger,
  memoryAdapter,
  resolvedModel,
}: {
  agentMessages: StrandsMessage[];
  invocation: InvocationContext;
  logger: StrandsLogger;
  memoryAdapter: StrandsMessageMemory;
  resolvedModel: string;
}): Promise<void> {
  if (!agentMessages.length || !invocation.conversationId) {
    return;
  }

  try {
    const existing = await memoryAdapter.getMessages(
      invocation.userId || '',
      invocation.conversationId,
    );
    const delta = agentMessages.slice(existing?.length || 0);

    logger.info('[Strands] Syncing messages', {
      total: agentMessages.length,
      existing: existing?.length || 0,
      delta: delta.length,
      conversationId: invocation.conversationId,
    });

    for (const msg of delta) {
      const parts = mapStrandsContentBlocksToParts(msg.content || []);
      if (!parts.length) {
        continue;
      }

      await memoryAdapter.addMessage(
        {
          id: crypto.randomUUID(),
          role: msg.role || 'assistant',
          parts,
        },
        invocation.userId || '',
        invocation.conversationId,
        { model: resolvedModel },
      );
    }
  } catch (error) {
    logger.error('Failed to sync Strands messages', { error });
  }
}
