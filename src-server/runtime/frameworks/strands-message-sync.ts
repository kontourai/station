import { type ContentBlockData, Message } from '@strands-agents/sdk';
import type { UIMessage } from 'ai';
import { projectToolServerResult } from '../../services/plugins/tool-server-oauth.js';
import {
  NATIVE_OUTPUT_DECLARATION_TOOL,
  stripOutputDeclarationHandle,
} from '../native-output-declaration.js';
import type { InvocationContext } from '../types.js';

type StrandsContentBlock = {
  type?: string;
  text?: unknown;
  reasoningText?: string;
  toolUseId?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  status?: string;
  isError?: boolean;
  signature?: string;
  format?: string;
  source?: {
    type?: string;
    bytes?: Uint8Array;
    url?: string;
    text?: string;
    location?: unknown;
  };
};

type StrandsMessage = {
  trackingId?: string;
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

const nativeHistoryBaselines = new WeakMap<
  object,
  { inherited: Set<string>; persisted: Set<string> }
>();

/** Invocation-local SDK identity; never inferred from message count or tool-writable metadata. */
export function bindStrandsNativeHistory(
  agent: object,
  messages: readonly { trackingId: string }[],
): void {
  nativeHistoryBaselines.set(agent, {
    inherited: new Set(messages.map((message) => message.trackingId)),
    persisted: new Set(),
  });
}

function historyUnavailable(): never {
  throw new Error(
    'Stored native history cannot be represented by the configured Strands runtime.',
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Convert stored structured UI history using the actual SDK message constructors. */
export function nativeHistoryToStrands(
  messages: readonly UIMessage[],
): Message[] {
  const output: Message[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant')
      historyUnavailable();
    let role = message.role;
    let content: ContentBlockData[] = [];
    const flush = () => {
      if (content.length) output.push(Message.fromJSON({ role, content }));
      content = [];
    };
    const append = (
      nextRole: 'user' | 'assistant',
      block: ContentBlockData,
    ) => {
      if (role !== nextRole) {
        flush();
        role = nextRole;
      }
      content.push(block);
    };
    const result = (
      id: unknown,
      value: unknown,
      failed = false,
      nativeContent = false,
    ) => {
      if (typeof id !== 'string') historyUnavailable();
      append('user', {
        toolResult: {
          toolUseId: id,
          status:
            failed || (record(value) && value.isError === true)
              ? 'error'
              : 'success',
          content:
            nativeContent &&
            Array.isArray(value) &&
            value.every(
              (entry) =>
                record(entry) &&
                Object.keys(entry).length === 1 &&
                ['text', 'json', 'image', 'document'].some(
                  (key) => key in entry,
                ),
            )
              ? JSON.parse(JSON.stringify(value))
              : [{ json: JSON.parse(JSON.stringify(value ?? null)) }],
        },
      });
    };
    for (const raw of message.parts) {
      const part = raw as unknown;
      if (!record(part)) historyUnavailable();
      if (part.type === 'step-start') continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        append(message.role, { text: part.text });
        continue;
      }
      if (part.type === 'reasoning' && typeof part.text === 'string') {
        const metadata =
          record(part.providerMetadata) && record(part.providerMetadata.strands)
            ? part.providerMetadata.strands
            : undefined;
        append(message.role, {
          reasoning: {
            text: part.text,
            ...(typeof metadata?.signature === 'string'
              ? { signature: metadata.signature }
              : {}),
          },
        });
        continue;
      }
      if (part.type === 'tool-invocation' && record(part.toolInvocation)) {
        const invocation = part.toolInvocation;
        if (
          typeof invocation.toolCallId !== 'string' ||
          typeof invocation.toolName !== 'string'
        )
          historyUnavailable();
        append('assistant', {
          toolUse: {
            name: invocation.toolName,
            toolUseId: invocation.toolCallId,
            input: JSON.parse(JSON.stringify(invocation.args ?? {})),
          },
        });
        if ('result' in invocation)
          result(invocation.toolCallId, invocation.result);
        continue;
      }
      if (part.type === 'tool-result') {
        result(part.toolCallId, part.result, false, true);
        continue;
      }
      if (
        typeof part.type === 'string' &&
        (part.type === 'dynamic-tool' || part.type.startsWith('tool-'))
      ) {
        const name =
          part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5);
        if (typeof name !== 'string' || typeof part.toolCallId !== 'string')
          historyUnavailable();
        append('assistant', {
          toolUse: {
            name,
            toolUseId: part.toolCallId,
            input: JSON.parse(JSON.stringify(part.input ?? {})),
          },
        });
        if (part.state === 'output-available')
          result(part.toolCallId, part.output);
        else if (part.state === 'output-error')
          result(part.toolCallId, part.errorText, true);
        else if (part.state !== 'input-available') historyUnavailable();
        continue;
      }
      if (
        part.type === 'file' &&
        typeof part.url === 'string' &&
        typeof part.mediaType === 'string'
      ) {
        const formats = {
          'image/png': 'png',
          'image/jpeg': 'jpeg',
          'image/gif': 'gif',
          'image/webp': 'webp',
        } as const;
        const imageFormat = formats[part.mediaType as keyof typeof formats];
        const data = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(
          part.url,
        );
        if (data && data[1] !== part.mediaType) historyUnavailable();
        if (imageFormat) {
          if (!data && !/^https?:\/\//.test(part.url)) historyUnavailable();
          append(message.role, {
            image: {
              format: imageFormat,
              source: data
                ? { bytes: Buffer.from(data[2], 'base64') }
                : { url: part.url },
            },
          });
          continue;
        }
        const documentFormat =
          part.mediaType === 'application/pdf'
            ? 'pdf'
            : part.mediaType === 'text/plain'
              ? 'txt'
              : undefined;
        if (!data || !documentFormat) historyUnavailable();
        append(message.role, {
          document: {
            format: documentFormat,
            name:
              typeof part.filename === 'string' ? part.filename : 'attachment',
            source: { bytes: Buffer.from(data[2], 'base64') },
          },
        });
        continue;
      }
      historyUnavailable();
    }
    flush();
  }
  return output;
}

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
    if (block.reasoningText !== undefined || block.type === 'reasoningBlock') {
      parts.push({
        type: 'reasoning' as const,
        text:
          block.reasoningText ||
          (typeof block.text === 'string' ? block.text : ''),
        ...(block.signature
          ? { providerMetadata: { strands: { signature: block.signature } } }
          : {}),
      });
      continue;
    }

    if (typeof block.text === 'string') {
      parts.push({ type: 'text' as const, text: block.text });
      continue;
    }

    if (block.type === 'imageBlock' || block.type === 'documentBlock') {
      const image = block.type === 'imageBlock';
      const mediaType = image
        ? `image/${block.format === 'jpg' ? 'jpeg' : block.format}`
        : block.format === 'pdf'
          ? 'application/pdf'
          : block.format === 'txt'
            ? 'text/plain'
            : undefined;
      const bytes =
        block.source?.bytes ??
        (typeof block.source?.text === 'string'
          ? Buffer.from(block.source.text, 'utf8')
          : undefined);
      const url = bytes
        ? `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
        : block.source?.url;
      if (!mediaType || !url) historyUnavailable();
      parts.push({
        type: 'file',
        mediaType,
        url,
        ...(block.name ? { filename: block.name } : {}),
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
  agent,
  invocation,
  logger,
  memoryAdapter,
  resolvedModel,
}: {
  agentMessages: StrandsMessage[];
  agent?: object;
  invocation: InvocationContext;
  logger: StrandsLogger;
  memoryAdapter: StrandsMessageMemory;
  resolvedModel: string;
}): Promise<void> {
  if (!agentMessages.length || !invocation.conversationId) {
    return;
  }

  try {
    const baseline = agent ? nativeHistoryBaselines.get(agent) : undefined;
    const existing = baseline
      ? []
      : await memoryAdapter.getMessages(
          invocation.userId || '',
          invocation.conversationId,
        );
    const delta = baseline
      ? agentMessages.filter((message) => {
          if (!message.trackingId) historyUnavailable();
          return (
            !baseline.inherited.has(message.trackingId) &&
            !baseline.persisted.has(message.trackingId)
          );
        })
      : agentMessages.slice(existing?.length || 0);

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
      if (baseline && msg.trackingId) baseline.persisted.add(msg.trackingId);
    }
  } catch (error) {
    logger.error('Failed to sync Strands messages', { error });
    if (agent && nativeHistoryBaselines.has(agent)) throw error;
  }
}
