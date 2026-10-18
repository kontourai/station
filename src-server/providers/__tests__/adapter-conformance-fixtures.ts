import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import { vi } from 'vitest';
import type { ProviderAdapterShape } from '../adapter-shape.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { BedrockAdapter } from '../adapters/bedrock-adapter.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { MuseAdapter } from '../adapters/muse-adapter.js';
import { OllamaAdapter } from '../adapters/ollama-adapter.js';
import { StationAgentAdapter } from '../adapters/station-agent-adapter.js';
import { BedrockLLMProvider } from '../llm/bedrock-llm-provider.js';
import { FakeClaudeChild } from './claude-engine-process-test-utils.js';
import { FakeCodexProcess } from './codex-adapter-wire-harness.js';
import { FakeAcpProcess } from './fake-acp-process.js';
import { FakeMuseProcess } from './fake-muse-process.js';
import {
  MUSE_ECHO_OUTPUT_DELTA,
  MUSE_ECHO_RUN_TERMINAL,
} from './muse-adapter-fixtures.js';

export const THREAD = 'conformance-thread';
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
export const IMAGE: ChatAttachmentInput = {
  kind: 'image',
  name: 'pixel.png',
  mimeType: 'image/png',
  size: PNG.length,
  dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
};
export const FILE: ChatAttachmentInput = {
  kind: 'file',
  name: 'note.txt',
  mimeType: 'text/plain',
  size: 4,
  dataUrl: 'data:text/plain;base64,bm90ZQ==',
};

/** Only engine input/output is faked. The adapter and canonical queue are real. */
export interface ConformanceEngine {
  adapter: ProviderAdapterShape;
  start(): Promise<unknown>;
  /** Number of prompts actually observed by the engine, excluding handshake. */
  inputs(): unknown[];
  text(value: string): void;
  complete(): void;
  late(): void;
  receivedImage(): Buffer | undefined;
  stopped(): boolean;
  refuseImage?(): void;
  outputFile?(path: string, id: string): void;
  /** Simulates an OS which never confirms process death. */
  unconfirmTermination?(): void;
  cleanup(): Promise<void>;
}
export type AdapterName =
  | 'claude'
  | 'codex'
  | 'acp'
  | 'muse'
  | 'station-agent'
  | 'bedrock'
  | 'ollama';
export const ADAPTERS: AdapterName[] = [
  'claude',
  'codex',
  'acp',
  'muse',
  'station-agent',
  'bedrock',
  'ollama',
];

/** Reuses the process fake with the REAL Agent SDK, including control replies. */
export class ConformanceClaudeChild extends FakeClaudeChild {
  static current: ConformanceClaudeChild;
  interrupted = false;
  readonly prompts: Array<{ message: { content: unknown } }> = [];
  constructor(
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) {
    super(command, args, options);
    ConformanceClaudeChild.current = this;
    let buffered = '';
    this.stdin.on('data', (bytes) => {
      buffered += bytes.toString();
      let end = buffered.indexOf('\n');
      while (end >= 0) {
        const message = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        if (message.type === 'user') this.prompts.push(message);
        if (message.type === 'control_request') {
          this.frame({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: message.request_id,
              response:
                message.request.subtype === 'initialize'
                  ? {
                      commands: [],
                      agents: [],
                      models: [],
                      account: {},
                      output_style: 'normal',
                      available_output_styles: ['normal'],
                    }
                  : {},
            },
          });
          if (message.request.subtype === 'interrupt') {
            this.interrupted = true;
            this.complete();
          }
        }
        end = buffered.indexOf('\n');
      }
    });
  }
  frame(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  text(text: string) {
    this.frame({
      type: 'stream_event',
      session_id: 'native-claude',
      uuid: randomUUID(),
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    });
  }
  complete() {
    this.frame({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      stop_reason: 'end_turn',
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: 'native-claude',
    });
  }
  override kill(signal?: NodeJS.Signals) {
    super.kill(signal);
    this.exit(0);
    this.stdout.end();
    this.closeStderr();
    return true;
  }
}

/** AWS event-stream framing: headers, prelude CRC and message CRC, not SSE. */
function bedrockFrame(type: string, body: unknown): Buffer {
  const headers = Buffer.concat(
    Object.entries({
      ':message-type': 'event',
      ':event-type': type,
      ':content-type': 'application/json',
    }).map(([name, value]) => {
      const key = Buffer.from(name);
      const data = Buffer.from(value);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(data.length);
      return Buffer.concat([
        Buffer.from([key.length]),
        key,
        Buffer.from([7]),
        length,
        data,
      ]);
    }),
  );
  const data = Buffer.from(JSON.stringify(body));
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(16 + headers.length + data.length, 0);
  prelude.writeUInt32BE(headers.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const message = Buffer.concat([prelude, headers, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(message));
  return Buffer.concat([message, checksum]);
}

export function createConformanceEngine(
  name: AdapterName,
  cwd: string,
): ConformanceEngine {
  const startInput = { threadId: THREAD, cwd, modelId: 'test-model' };
  if (name === 'claude') {
    const adapter = new ClaudeAdapter({ findBinary: async () => null });
    return {
      adapter,
      start: () => adapter.startSession({ ...startInput, provider: 'claude' }),
      inputs: () => ConformanceClaudeChild.current?.prompts ?? [],
      text: (value) => ConformanceClaudeChild.current.text(value),
      complete: () => ConformanceClaudeChild.current.complete(),
      late: () => ConformanceClaudeChild.current.text('late-after-stop'),
      receivedImage: () => {
        const content =
          ConformanceClaudeChild.current.prompts.at(-1)?.message.content;
        if (!Array.isArray(content)) return;
        const image = content.find((part) => part.type === 'image');
        return image ? Buffer.from(image.source.data, 'base64') : undefined;
      },
      stopped: () => ConformanceClaudeChild.current.interrupted,
      cleanup: () => adapter.stopAll(),
    };
  }
  if (name === 'codex') {
    const process = new FakeCodexProcess();
    const prompts: Array<{ input: Array<{ type: string; url?: string }> }> = [];
    let nativeTurn = '';
    let lineIndex = 0;
    const frame = (message: unknown) =>
      process.stdout.write(`${JSON.stringify(message)}\n`);
    // React to real writes, rather than assuming RPC ids or reaching into records.
    const write = process.stdin._write.bind(process.stdin);
    process.stdin._write = (chunk, encoding, callback) => {
      write(chunk, encoding, callback);
      for (const line of process.stdin.lines.slice(lineIndex)) {
        lineIndex++;
        const message = JSON.parse(line);
        if (!message.method || message.id === undefined) continue;
        let result: unknown = {};
        if (message.method === 'thread/start')
          result = { thread: { id: 'native-codex' } };
        if (message.method === 'turn/start') {
          prompts.push(message.params);
          nativeTurn = `native-turn-${prompts.length}`;
          result = { turn: { id: nativeTurn } };
        }
        queueMicrotask(() => frame({ id: message.id, result }));
      }
    };
    const adapter = new CodexAdapter({
      processFactory: () => process as never,
    });
    const text = (delta: string) => {
      frame({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'native-codex',
          turnId: nativeTurn,
          itemId: 'text',
          delta,
        },
      });
    };
    return {
      adapter,
      start: () => adapter.startSession({ ...startInput, provider: 'codex' }),
      inputs: () => prompts,
      text,
      complete: () => {
        frame({
          method: 'turn/completed',
          params: {
            threadId: 'native-codex',
            turn: { id: nativeTurn, status: 'completed' },
          },
        });
      },
      late: () => text('late-after-stop'),
      receivedImage: () => {
        const image = prompts
          .at(-1)
          ?.input.find((part) => part.type === 'image');
        return image?.url
          ? Buffer.from(image.url.split(',')[1], 'base64')
          : undefined;
      },
      stopped: () =>
        process.stdin.lines.some(
          (line) => JSON.parse(line).method === 'turn/interrupt',
        ),
      outputFile: (path, id) => {
        frame({
          method: 'item/completed',
          params: {
            threadId: 'native-codex',
            turnId: nativeTurn,
            item: { type: 'imageView', id, path },
          },
        });
      },
      cleanup: () => adapter.stopAll(),
    };
  }
  if (name === 'acp') {
    let process: FakeAcpProcess;
    const adapter = new AcpAdapter({
      getConnections: async () => [
        {
          id: 'conformance',
          name: 'Conformance',
          command: 'fake-acp',
          args: [],
          enabled: true,
        },
      ],
      managedWorkspaceHomeDir: cwd,
      processFactory: (options) => {
        process = new FakeAcpProcess(options);
        return process as never;
      },
    });
    const text = (value: string) => {
      void process.client.sessionUpdate({
        sessionId: process.sessionId!,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: value },
        },
      });
    };
    return {
      adapter,
      start: () =>
        adapter.startSession({
          ...startInput,
          provider: 'acp',
          modelId: undefined,
          metadata: { connectionId: 'conformance' },
        }),
      inputs: () => process.promptContents,
      stopped: () => process.cancelCalls > 0,
      refuseImage: () => {
        process.initResult!.agentCapabilities.promptCapabilities.image = false;
      },
      text,
      complete: () => process.resolvePrompt('end_turn'),
      late: () => text('late-after-stop'),
      receivedImage: () => {
        const image = process.promptContents
          .at(-1)
          ?.find((part: ContentBlock) => part.type === 'image');
        return image?.type === 'image'
          ? Buffer.from(image.data, 'base64')
          : undefined;
      },
      cleanup: async () => {
        process?.resolvePrompt('cancelled');
        await adapter.stopAll();
      },
    };
  }
  if (name === 'muse') {
    const processes: FakeMuseProcess[] = [];
    const prompts: string[][] = [];
    let unconfirmed = false;
    const adapter = new MuseAdapter({
      env: {},
      processFactory: (args) => {
        const process = new FakeMuseProcess();
        processes.push(process);
        prompts.push(args);
        return { process };
      },
      terminateProcess: async (process) => {
        if (unconfirmed) throw new Error('OS did not confirm process exit');
        process.kill();
      },
    });
    const frame = (line: string) => processes.at(-1)!.stdout.write(`${line}\n`);
    const text = (value: string) => {
      const message = JSON.parse(MUSE_ECHO_OUTPUT_DELTA);
      message.payload.text = value;
      frame(JSON.stringify(message));
    };
    return {
      adapter,
      start: () => adapter.startSession({ ...startInput, provider: 'muse' }),
      inputs: () => prompts,
      stopped: () => processes.at(-1)?.killed === true,
      text,
      complete: () => {
        frame(MUSE_ECHO_RUN_TERMINAL);
        processes.at(-1)!.exit(0);
      },
      late: () => text('late-after-stop'),
      receivedImage: () => {
        const args = prompts.at(-1)!;
        const index = args.indexOf('--image');
        return index < 0 ? undefined : readFileSync(args[index + 1]);
      },
      unconfirmTermination: () => {
        unconfirmed = true;
      },
      cleanup: async () => {
        unconfirmed = false;
        for (const process of processes) process.exit(0);
        await adapter.stopAll();
      },
    };
  }
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let requestSignal: AbortSignal | null | undefined;
  const encoder = new TextEncoder();
  const enqueue = (value: Uint8Array) => {
    if (!closed) controller.enqueue(value);
  };
  const sse = (value: unknown) =>
    enqueue(
      encoder.encode(
        `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`,
      ),
    );
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/tags'))
      return Response.json({ models: [{ name: 'test-model' }] });
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    closed = false;
    requestSignal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        controller = stream;
        const abort = () => {
          if (!closed) {
            closed = true;
            stream.error(new DOMException('Aborted', 'AbortError'));
          }
        };
        init?.signal?.addEventListener('abort', abort, { once: true });
        if (init?.signal?.aborted) abort();
      },
      cancel() {
        closed = true;
      },
    });
    return new Response(body, {
      headers: {
        'content-type':
          name === 'bedrock'
            ? 'application/vnd.amazon.eventstream'
            : 'text/event-stream',
      },
    });
  };
  let adapter: ProviderAdapterShape;
  if (name === 'station-agent') {
    adapter = new StationAgentAdapter({
      apiBase: 'http://conformance.invalid',
      hasAgent: () => true,
      fetch: fakeFetch,
      approvalRegistry: { has: () => false, resolve: () => false },
      eventBus: { subscribe: () => () => {} },
    });
  } else {
    // Fail-closed network substrate: neither provider can make a live call.
    vi.stubGlobal('fetch', fakeFetch);
    adapter =
      name === 'ollama'
        ? new OllamaAdapter('http://conformance.invalid')
        : new BedrockAdapter(
            {},
            {
              llm: new BedrockLLMProvider({
                authMode: 'api-key',
                apiKey: 'deterministic-fake-key',
              }),
              modelCatalog: { resolveModelId: async (id) => id },
            },
          );
  }
  const text = (value: string) => {
    if (name === 'bedrock')
      enqueue(
        bedrockFrame('contentBlockDelta', {
          contentBlockIndex: 0,
          delta: { text: value },
        }),
      );
    else
      sse(
        name === 'ollama'
          ? { choices: [{ delta: { content: value } }] }
          : { type: 'text-delta', text: value },
      );
  };
  return {
    adapter,
    start: () =>
      adapter.startSession({
        ...startInput,
        provider: adapter.provider,
        metadata: { agentId: 'test-agent' },
      }),
    inputs: () => requests,
    stopped: () => requestSignal?.aborted === true,
    text,
    complete: () => {
      if (name === 'bedrock')
        enqueue(bedrockFrame('messageStop', { stopReason: 'end_turn' }));
      else if (name === 'ollama') {
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        sse('[DONE]');
      } else {
        sse({ type: 'finish', finishReason: 'stop' });
        sse('[DONE]');
      }
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
    late: () => text('late-after-stop'),
    receivedImage: () => {
      const input = requests.at(-1)?.body.input;
      if (!Array.isArray(input)) return;
      for (const message of input) {
        const part = message.parts?.find(
          (part: { type: string; mediaType?: string }) =>
            part.type === 'file' && part.mediaType === 'image/png',
        );
        if (part) return Buffer.from(part.url.split(',')[1], 'base64');
      }
      return undefined;
    },
    cleanup: async () => {
      if (controller && !closed) {
        closed = true;
        controller.close();
      }
      await adapter.stopAll();
    },
  };
}
