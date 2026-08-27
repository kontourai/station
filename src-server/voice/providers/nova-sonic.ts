import { EventEmitter } from 'node:events';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  type InvokeModelWithBidirectionalStreamInput,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import type {
  IS2SProvider,
  S2SAudioFormat,
  S2SCorrelatedTurnsV1,
  S2SProviderState,
  S2SSessionConfig,
} from '../s2s-types.js';
import {
  parseNovaSonicRawEvent,
  processNovaSonicStreamEvent,
} from './nova-sonic-events.js';

const DEFAULT_MODEL = 'amazon.nova-2-sonic-v1:0';
const DEFAULT_REGION = 'us-east-1';

const INPUT_FORMAT: S2SAudioFormat = {
  mediaType: 'audio/lpcm',
  sampleRateHertz: 16000,
  sampleSizeBits: 16,
  channelCount: 1,
  encoding: 'base64',
};
const OUTPUT_FORMAT: S2SAudioFormat = {
  mediaType: 'audio/lpcm',
  sampleRateHertz: 24000,
  sampleSizeBits: 16,
  channelCount: 1,
  encoding: 'base64',
};

function uuid() {
  return crypto.randomUUID();
}
function enc(obj: unknown): InvokeModelWithBidirectionalStreamInput {
  return {
    chunk: { bytes: new TextEncoder().encode(JSON.stringify({ event: obj })) },
  };
}

type QueueItem = InvokeModelWithBidirectionalStreamInput | null; // null = done

export class NovaSonicProvider
  extends EventEmitter
  implements IS2SProvider, S2SCorrelatedTurnsV1
{
  /** AWS documents completionId on start, end, and tool-use envelopes. */
  readonly correlatedTurnsVersion = 1 as const;
  readonly correlatedTurnsProviderId = 'nova-sonic';
  private client: BedrockRuntimeClient;
  private _state: S2SProviderState = 'disconnected';
  private promptName = '';
  private audioContentName = '';
  private queue: QueueItem[] = [];
  private queueResolve: (() => void) | null = null;
  private active = false;
  // Per-response tracking
  private currentRole = '';
  private currentGenerationStage = '';
  private currentToolName = '';
  private currentToolUseId = '';
  private currentToolContent = '';
  private currentContentType = '';
  private currentProviderSessionId = '';
  private currentProviderPromptId = '';
  private currentProviderTurnId = '';
  private currentProviderContentId = '';

  readonly outputAudioFormat = OUTPUT_FORMAT;

  constructor(opts: { region?: string; modelId?: string } = {}) {
    super();
    this.client = new BedrockRuntimeClient({
      region: opts.region ?? DEFAULT_REGION,
      requestHandler: new NodeHttp2Handler({
        requestTimeout: 300_000,
        sessionTimeout: 300_000,
      }),
    });
    (this as any)._modelId = opts.modelId ?? DEFAULT_MODEL;
  }

  get state() {
    return this._state;
  }

  private setState(s: S2SProviderState) {
    this._state = s;
    this.emit('stateChange', s);
  }

  private push(chunk: QueueItem) {
    this.queue.push(chunk);
    this.queueResolve?.();
    this.queueResolve = null;
  }

  private async *eventStream(): AsyncGenerator<InvokeModelWithBidirectionalStreamInput> {
    while (true) {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        if (item === null) return;
        yield item;
        await new Promise<void>((r) => setTimeout(r, 30));
      }
      await new Promise<void>((r) => {
        this.queueResolve = r;
      });
    }
  }

  async connect(config: S2SSessionConfig): Promise<S2SAudioFormat> {
    // Reserve activity before notifying subscribers. A synchronous teardown
    // from the connecting notification must observe and clear the live intent
    // before connect can continue.
    this.active = true;
    this.promptName = uuid();
    const systemContentName = uuid();
    this.audioContentName = uuid();
    this.setState('connecting');
    if (!this.active) return INPUT_FORMAT;
    const voice = config.voice ?? 'matthew';

    const tools = (config.tools ?? []).map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: JSON.stringify(t.inputSchema) },
      },
    }));

    // Seed setup events into queue before starting stream
    this.push(
      enc({
        sessionStart: {
          inferenceConfiguration: {
            maxTokens: 1024,
            topP: 0.9,
            temperature: 0.7,
          },
        },
      }),
    );
    this.push(
      enc({
        promptStart: {
          promptName: this.promptName,
          textOutputConfiguration: { mediaType: 'text/plain' },
          audioOutputConfiguration: {
            mediaType: 'audio/lpcm',
            sampleRateHertz: 24000,
            sampleSizeBits: 16,
            channelCount: 1,
            voiceId: voice,
            encoding: 'base64',
            audioType: 'SPEECH',
          },
          ...(tools.length > 0 && {
            toolUseOutputConfiguration: { mediaType: 'application/json' },
            toolConfiguration: { tools, toolChoice: { auto: {} } },
          }),
        },
      }),
    );
    // System prompt
    this.push(
      enc({
        contentStart: {
          promptName: this.promptName,
          contentName: systemContentName,
          type: 'TEXT',
          interactive: false,
          role: 'SYSTEM',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      }),
    );
    this.push(
      enc({
        textInput: {
          promptName: this.promptName,
          contentName: systemContentName,
          content: config.systemPrompt,
        },
      }),
    );
    this.push(
      enc({
        contentEnd: {
          promptName: this.promptName,
          contentName: systemContentName,
        },
      }),
    );
    // Open audio content block
    this.push(
      enc({
        contentStart: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          type: 'AUDIO',
          interactive: true,
          role: 'USER',
          audioInputConfiguration: {
            mediaType: 'audio/lpcm',
            sampleRateHertz: 16000,
            sampleSizeBits: 16,
            channelCount: 1,
            audioType: 'SPEECH',
            encoding: 'base64',
          },
        },
      }),
    );

    const cmd = new InvokeModelWithBidirectionalStreamCommand({
      modelId: (this as any)._modelId,
      body: this.eventStream(),
    });

    const response = await this.client.send(cmd);
    if (!response.body) throw new Error('No response body from Bedrock');
    // A socket may close while Bedrock is still establishing the stream.
    // Teardown owns that intent; a late connect completion must not reactivate
    // the provider or start a response loop after disconnect.
    if (!this.active) return INPUT_FORMAT;
    this.setState('listening');
    this.processStream(response.body).catch((err) => this.emit('error', err));
    return INPUT_FORMAT;
  }

  private async processStream(body: AsyncIterable<any>) {
    try {
      for await (const raw of body) {
        if (!this.active) break;
        const event = parseNovaSonicRawEvent(raw);
        if (!event) continue;
        const state = {
          currentRole: this.currentRole,
          currentGenerationStage: this.currentGenerationStage,
          currentToolName: this.currentToolName,
          currentToolUseId: this.currentToolUseId,
          currentToolContent: this.currentToolContent,
          currentContentType: this.currentContentType,
          currentProviderSessionId: this.currentProviderSessionId,
          currentProviderPromptId: this.currentProviderPromptId,
          currentProviderTurnId: this.currentProviderTurnId,
          currentProviderContentId: this.currentProviderContentId,
        };
        processNovaSonicStreamEvent(event, state, {
          emit: (name, payload) => this.emit(name, payload),
          setState: (state) => this.setState(state),
        });
        this.currentRole = state.currentRole;
        this.currentGenerationStage = state.currentGenerationStage;
        this.currentToolName = state.currentToolName;
        this.currentToolUseId = state.currentToolUseId;
        this.currentToolContent = state.currentToolContent;
        this.currentContentType = state.currentContentType;
        this.currentProviderSessionId = state.currentProviderSessionId;
        this.currentProviderPromptId = state.currentProviderPromptId;
        this.currentProviderTurnId = state.currentProviderTurnId;
        this.currentProviderContentId = state.currentProviderContentId;
      }
    } catch (err: any) {
      if (this.active) this.emit('error', err);
    }
  }

  sendAudio(chunk: Buffer) {
    if (!this.active) return;
    this.push(
      enc({
        audioInput: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          content: chunk.toString('base64'),
        },
      }),
    );
  }

  sendToolResult(toolUseId: string, result: string) {
    if (!this.active) return;
    const contentName = uuid();
    this.push(
      enc({
        contentStart: {
          promptName: this.promptName,
          contentName,
          role: 'TOOL',
          type: 'TOOL',
          toolResultInputConfiguration: {
            toolUseId,
            type: 'TEXT',
            textInputConfiguration: { mediaType: 'text/plain' },
          },
        },
      }),
    );
    this.push(
      enc({
        toolResult: {
          promptName: this.promptName,
          contentName,
          content: result,
        },
      }),
    );
    this.push(
      enc({ contentEnd: { promptName: this.promptName, contentName } }),
    );
  }

  async disconnect() {
    if (!this.active) return;
    this.active = false;
    this.push(
      enc({
        contentEnd: {
          promptName: this.promptName,
          contentName: this.audioContentName,
        },
      }),
    );
    this.push(enc({ promptEnd: { promptName: this.promptName } }));
    this.push(enc({ sessionEnd: {} }));
    this.push(null);
    this.setState('disconnected');
  }
}
