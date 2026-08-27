import { _getApiBase, _resolveAgent, getPluginHeaders } from './api-core';
import { telemetry } from './telemetry';

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOperationResponse(value: unknown, defaultError: string): unknown {
  if (!isJsonRecord(value) || value.success !== true) {
    const message =
      isJsonRecord(value) &&
      typeof value.error === 'string' &&
      value.error.length > 0
        ? value.error
        : defaultError;
    throw new Error(message);
  }

  return value.response;
}

export class NativeInvocationIndeterminateError extends Error {
  readonly code:
    | 'native_invocation_indeterminate'
    | 'native_invocation_partial';
  readonly outcome = 'indeterminate' as const;
  readonly retryable = false as const;

  constructor(
    message: string,
    readonly runId?: string,
    readonly relatedRunIds: string[] = [],
    readonly structureOutcome?: 'not_started' | 'indeterminate',
    code:
      | 'native_invocation_indeterminate'
      | 'native_invocation_partial' = 'native_invocation_indeterminate',
  ) {
    super(message);
    this.name = 'NativeInvocationIndeterminateError';
    this.code = code;
  }
}

/** Complete non-OK HTTP envelopes remain ordinary SDK errors. */
const receivedInvokeResponseErrors = new WeakSet<Error>();

function receivedInvokeResponseError(message: string): Error {
  const error = new Error(message);
  receivedInvokeResponseErrors.add(error);
  return error;
}

function isReceivedInvokeResponseError(error: unknown): boolean {
  return error instanceof Error && receivedInvokeResponseErrors.has(error);
}

function nativeInvocationIndeterminate(
  value: unknown,
): NativeInvocationIndeterminateError | undefined {
  if (
    !isJsonRecord(value) ||
    (value.code !== 'native_invocation_indeterminate' &&
      value.code !== 'native_invocation_partial') ||
    value.outcome !== 'indeterminate'
  ) {
    return undefined;
  }
  const relatedRunIds = Array.isArray(value.relatedRunIds)
    ? value.relatedRunIds.filter(
        (runId): runId is string =>
          typeof runId === 'string' && runId.length > 0,
      )
    : [];
  return new NativeInvocationIndeterminateError(
    typeof value.error === 'string' && value.error.length > 0
      ? value.error
      : 'The provider invocation may have started. Do not retry automatically.',
    typeof value.runId === 'string' && value.runId.length > 0
      ? value.runId
      : undefined,
    relatedRunIds,
    value.structureOutcome === 'not_started' ||
      value.structureOutcome === 'indeterminate'
      ? value.structureOutcome
      : undefined,
    value.code,
  );
}

function isDefiniteNativeInvokeConflict(value: unknown): boolean {
  if (
    !isJsonRecord(value) ||
    value.success !== false ||
    typeof value.error !== 'string' ||
    value.error.length === 0
  ) {
    return false;
  }
  // Any remnant of the uncertainty envelope means a proxy may have removed
  // the facts needed to distinguish a definite conflict from provider work.
  return !(
    (typeof value.code === 'string' &&
      value.code.startsWith('native_invocation_')) ||
    'outcome' in value ||
    'runId' in value ||
    'relatedRunIds' in value ||
    'structureOutcome' in value
  );
}

async function requireInvokeResponse(
  response: Response,
  fallback: string,
): Promise<unknown> {
  if (!response.ok) {
    // A received non-OK status is definite even when a proxy stripped or
    // replaced the JSON body. Only the explicit 409 uncertainty envelope is
    // allowed to change that classification.
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      if (response.status === 409) {
        throw new NativeInvocationIndeterminateError(
          'The provider invocation may have started. Do not retry automatically.',
        );
      }
      throw receivedInvokeResponseError(fallback);
    }
    const indeterminate =
      response.status === 409
        ? nativeInvocationIndeterminate(value)
        : undefined;
    if (indeterminate) throw indeterminate;
    if (response.status === 409 && !isDefiniteNativeInvokeConflict(value)) {
      // A 409 is shared by ordinary conflicts and post-boundary uncertainty.
      // Without a complete definite-conflict envelope, response loss cannot
      // prove no provider effect happened.
      throw new NativeInvocationIndeterminateError(
        'The provider invocation may have started. Do not retry automatically.',
      );
    }
    throw receivedInvokeResponseError(
      isJsonRecord(value) && typeof value.error === 'string'
        ? value.error
        : fallback,
    );
  }
  const value: unknown = await response.json();
  const indeterminate = nativeInvocationIndeterminate(value);
  if (indeterminate) throw indeterminate;
  if (!isJsonRecord(value) || value.success !== true) {
    throw new Error(`${fallback}: invalid response`);
  }
  return value;
}

async function readArrayResponse(
  response: Response,
  resource: string,
): Promise<any[]> {
  const value: unknown = await response.json();
  if (!Array.isArray(value)) {
    throw new Error(`Failed to fetch ${resource}: invalid response`);
  }
  return value;
}

export interface SendMessageOptions {
  model?: string;
  conversationId?: string;
  userId?: string;
  attachments?: Array<{
    type: string;
    content: string;
    mimeType?: string;
  }>;
}

export interface StreamMessageOptions extends SendMessageOptions {
  onChunk?: (chunk: string) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}

export interface InvokeOptions {
  prompt: string;
  schema?: any;
  tools?: string[];
  maxSteps?: number;
  model?: string;
  structureModel?: string;
  system?: string;
}

/** Additive direct-invoke observation receipt; older servers omit `runId`. */
export interface InvokeRunReceipt<T = unknown> {
  response: T;
  runId?: string;
  relatedRunIds?: string[];
}

export async function createChatSession(
  _agentSlug: string,
  _sessionId: string,
  _title?: string,
): Promise<void> {
  throw new Error('createChatSession must be implemented by core app');
}

export async function sendMessage(
  agentSlug: string,
  content: string,
  options: SendMessageOptions = {},
): Promise<any> {
  const start = performance.now();
  try {
    const apiBase = await _getApiBase();
    const resolvedAgent = _resolveAgent(agentSlug);
    const response = await fetch(
      `${apiBase}/agents/${encodeURIComponent(resolvedAgent)}/text`,
      {
        method: 'POST',
        headers: getPluginHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          input: content,
          options: {
            model: options.model,
            conversationId: options.conversationId,
            userId: options.userId,
          },
          attachments: options.attachments,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.statusText}`);
    }

    const result = await response.json();
    telemetry.track('sdk.sendMessage', {
      duration_ms: Math.round(performance.now() - start),
      status: 'ok',
    });
    return result;
  } catch (err) {
    telemetry.track('sdk.sendMessage', {
      duration_ms: Math.round(performance.now() - start),
      status: 'error',
    });
    throw err;
  }
}

export async function streamMessage(
  agentSlug: string,
  content: string,
  options: StreamMessageOptions = {},
): Promise<void> {
  const start = performance.now();
  try {
    const apiBase = await _getApiBase();
    const resolvedAgent = _resolveAgent(agentSlug);
    const response = await fetch(
      `${apiBase}/agents/${encodeURIComponent(resolvedAgent)}/stream`,
      {
        method: 'POST',
        headers: getPluginHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          input: content,
          options: {
            model: options.model,
            conversationId: options.conversationId,
            userId: options.userId,
          },
          attachments: options.attachments,
        }),
      },
    );

    if (!response.ok) {
      const error = new Error(
        `Failed to stream message: ${response.statusText}`,
      );
      options.onError?.(error);
      throw error;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          options.onComplete?.();
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        options.onChunk?.(chunk);
      }
    } catch (error) {
      options.onError?.(error as Error);
      throw error;
    }

    telemetry.track('sdk.streamMessage', {
      duration_ms: Math.round(performance.now() - start),
      status: 'ok',
    });
  } catch (err) {
    telemetry.track('sdk.streamMessage', {
      duration_ms: Math.round(performance.now() - start),
      status: 'error',
    });
    throw err;
  }
}

export async function invokeAgent(
  agentSlug: string,
  content: string,
  options: SendMessageOptions & { schema?: any } = {},
): Promise<any> {
  const start = performance.now();
  let requestSubmitted = false;
  try {
    const apiBase = await _getApiBase();
    const resolvedAgent = _resolveAgent(agentSlug);
    requestSubmitted = true;
    const response = await fetch(
      `${apiBase}/agents/${encodeURIComponent(resolvedAgent)}/invoke`,
      {
        method: 'POST',
        headers: getPluginHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          input: content,
          schema: options.schema,
          options: {
            model: options.model,
            conversationId: options.conversationId,
            userId: options.userId,
          },
          attachments: options.attachments,
        }),
      },
    );

    const result = await requireInvokeResponse(
      response,
      `Failed to invoke agent: ${response.statusText}`,
    );
    telemetry.track('sdk.invokeAgent', {
      duration_ms: Math.round(performance.now() - start),
      status: 'ok',
    });
    return result;
  } catch (err) {
    telemetry.track('sdk.invokeAgent', {
      duration_ms: Math.round(performance.now() - start),
      status: 'error',
    });
    if (
      err instanceof NativeInvocationIndeterminateError ||
      isReceivedInvokeResponseError(err)
    )
      throw err;
    // Once fetch has been entered, a transport/JSON failure cannot prove the
    // server did not cross its provider boundary. There is no pre-existing
    // direct-invoke request identity to look up, so retain that limitation
    // rather than encouraging an automatic retry.
    if (requestSubmitted) {
      throw new NativeInvocationIndeterminateError(
        'The invocation response was unavailable. The provider may have started; do not retry automatically.',
      );
    }
    throw err;
  }
}

export async function callTool(
  agentSlug: string,
  toolName: string,
  toolArgs: any = {},
): Promise<any> {
  const start = performance.now();
  try {
    const apiBase = await _getApiBase();
    const resolvedAgent = _resolveAgent(agentSlug);
    const response = await fetch(
      `${apiBase}/agents/${encodeURIComponent(resolvedAgent)}/tools/${encodeURIComponent(toolName)}`,
      {
        method: 'POST',
        headers: getPluginHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(toolArgs),
      },
    );

    if (!response.ok) {
      throw new Error(`Tool call failed: ${response.statusText}`);
    }

    const data: unknown = await response.json();
    const toolResponse = readOperationResponse(data, 'Tool call failed');

    telemetry.track('sdk.callTool', {
      duration_ms: Math.round(performance.now() - start),
      status: 'ok',
    });
    return toolResponse;
  } catch (err) {
    telemetry.track('sdk.callTool', {
      duration_ms: Math.round(performance.now() - start),
      status: 'error',
    });
    throw err;
  }
}

export async function invoke(options: InvokeOptions): Promise<any> {
  return (await invokeWithRunReceipt(options)).response;
}

/**
 * New observation-aware companion to {@link invoke}. The original method
 * deliberately continues returning the raw response for extension version
 * compatibility; callers that need `/runs` correlation opt into this shape.
 */
export async function invokeWithRunReceipt(
  options: InvokeOptions,
): Promise<InvokeRunReceipt> {
  const start = performance.now();
  let requestSubmitted = false;
  try {
    const apiBase = await _getApiBase();
    requestSubmitted = true;
    const response = await fetch(`${apiBase}/invoke`, {
      method: 'POST',
      headers: getPluginHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(options),
    });

    const data = await requireInvokeResponse(
      response,
      `Failed to invoke: ${response.statusText}`,
    );
    if (!isJsonRecord(data) || data.success !== true) {
      readOperationResponse(data, 'Invoke failed');
      throw new Error('Invoke failed');
    }
    const invokeResponse: InvokeRunReceipt = {
      response: data.response,
      ...(typeof data.runId === 'string' && data.runId.length > 0
        ? { runId: data.runId }
        : {}),
      ...(Array.isArray(data.relatedRunIds) &&
      data.relatedRunIds.every(
        (runId): runId is string =>
          typeof runId === 'string' && runId.length > 0,
      )
        ? { relatedRunIds: data.relatedRunIds }
        : {}),
    };

    telemetry.track('sdk.invoke', {
      duration_ms: Math.round(performance.now() - start),
      status: 'ok',
    });
    return invokeResponse;
  } catch (err) {
    telemetry.track('sdk.invoke', {
      duration_ms: Math.round(performance.now() - start),
      status: 'error',
    });
    if (
      err instanceof NativeInvocationIndeterminateError ||
      isReceivedInvokeResponseError(err)
    )
      throw err;
    if (requestSubmitted) {
      throw new NativeInvocationIndeterminateError(
        'The invocation response was unavailable. The provider may have started; do not retry automatically.',
      );
    }
    throw err;
  }
}

export async function fetchAgents(): Promise<any[]> {
  const apiBase = await _getApiBase();
  const response = await fetch(`${apiBase}/agents`, {
    headers: getPluginHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch agents: ${response.statusText}`);
  }

  return readArrayResponse(response, 'agents');
}

export async function fetchConversations(agentSlug?: string): Promise<any[]> {
  const apiBase = await _getApiBase();
  const resolvedAgent = agentSlug ? _resolveAgent(agentSlug) : undefined;
  const url = resolvedAgent
    ? `${apiBase}/agents/${encodeURIComponent(resolvedAgent)}/conversations`
    : `${apiBase}/conversations`;

  const response = await fetch(url, {
    headers: getPluginHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch conversations: ${response.statusText}`);
  }

  return readArrayResponse(response, 'conversations');
}

export async function fetchConversationMessages(
  conversationId: string,
): Promise<any[]> {
  const apiBase = await _getApiBase();
  const response = await fetch(
    `${apiBase}/conversations/${conversationId}/messages`,
    { headers: getPluginHeaders() },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch messages: ${response.statusText}`);
  }

  return readArrayResponse(response, 'messages');
}

export async function fetchConfig(): Promise<any> {
  const apiBase = await _getApiBase();
  const response = await fetch(`${apiBase}/config/app`, {
    headers: getPluginHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch config: ${response.statusText}`);
  }

  return response.json();
}
