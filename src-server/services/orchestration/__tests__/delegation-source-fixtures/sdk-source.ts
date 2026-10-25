import { boundedApiWireOptionsSha256 } from '../../../../runtime/conversation/bounded-api-provider-contract.js';
import { reportInputToolDefinition } from '../../../../runtime/conversation/report-input-profile.js';
import { createPreparedSdkSourceWireOwner } from '../../delegation-group-sdk-source-wire-owner.js';
import { fixture as qualification } from './qualification.js';
import { fixture, sdkCredentialFixture, selection, subject } from './source.js';

type ContractConfiguration = Extract<
  Parameters<typeof createPreparedSdkSourceWireOwner>[0],
  { contract: object }
>;
type FixtureConfiguration = {
  -readonly [K in keyof ContractConfiguration]: ContractConfiguration[K];
};

export function mockResponse(
  provider: 'anthropic' | 'google',
  continued = false,
) {
  return new Response(
    JSON.stringify(
      provider === 'anthropic'
        ? {
            id: 'msg-fixture',
            type: 'message',
            role: 'assistant',
            model: 'fixture-model',
            content: [{ type: 'text', text: 'OK' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 4,
              output_tokens: 2,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          }
        : {
            modelVersion: 'fixture-revision',
            candidates: [
              {
                finishReason: continued ? 'CONTINUATION' : 'STOP',
                ...(continued
                  ? { continuationToken: 'controlled-continuation' }
                  : {}),
                index: 0,
                content: { role: 'model', parts: [{ text: 'OK' }] },
              },
            ],
            usageMetadata: {
              promptTokenCount: 4,
              candidatesTokenCount: 2,
              totalTokenCount: 6,
            },
          },
    ),
    { headers: { 'content-type': 'application/json' } },
  );
}
export function requestContext(request: Request) {
  return () => ({
    env: undefined,
    req: {
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
  });
}
export async function sdkFixture(
  provider: 'anthropic' | 'google' = 'anthropic',
  path = '/api/orchestration/chat',
  response: () => Response | Promise<Response> = () => mockResponse(provider),
  requestSignal?: AbortSignal,
  outputDelivery?: 'streamed',
  inputTool?: true,
) {
  const f = await fixture();
  const request = f.request(path, { signal: requestSignal });
  f.req = request;
  f.context = requestContext(request);
  const q = qualification(provider);
  const credentialOwner = await sdkCredentialFixture(f, provider);
  Object.assign(q.binding, {
    connectionId: credentialOwner.observed.connectionId,
    connectionRevision: credentialOwner.observed.connectionRevision,
    credentialRevision: credentialOwner.observed.credentialRevision,
  });
  if (outputDelivery === 'streamed') {
    if (provider === 'google')
      q.binding.endpointUrl = q.wire.url.replace(
        ':generateContent',
        ':streamGenerateContent?alt=sse',
      );
    const body = {
      ...q.body,
      ...(provider === 'anthropic' ? { stream: true } : {}),
      ...(inputTool
        ? {
            tools: [reportInputToolDefinition()],
            tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          }
        : {}),
    };
    q.binding.optionsSha256 = boundedApiWireOptionsSha256(provider, {
      ...q.wire,
      url: q.binding.endpointUrl,
      body: JSON.stringify(body),
    });
  }
  if (inputTool) {
    q.raw.schema = 'report-input-single-request-v1';
    q.raw.limits.thinkingModes = ['omitted'];
  }
  q.publishFixture();
  let starts = 0;
  let sentBody = '';
  const abort = new AbortController();
  const configuration: FixtureConfiguration = {
    ...(outputDelivery ? { outputDelivery } : {}),
    ...(inputTool ? { inputTool } : {}),
    provider,
    modelId: 'fixture-model',
    credential: credentialOwner.credential,
    brief: 'inspect exactly this source',
    instructions: 'report only',
    maxOutputTokens: 10,
    contract: q.resolve(),
    remaining: {
      inputTokens: 1000,
      outputTokens: 1000,
      costMicros: 100000,
      currency: 'USD' as const,
    },
    now: () => 1000,
    signal: abort.signal,
    rawFetch: (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      starts++;
      sentBody = String(init?.body);
      return Promise.resolve(response());
    },
  };
  const owner = createPreparedSdkSourceWireOwner(configuration);
  const sealed = await f.owner.captureSnapshot(f.context(), subject, selection);
  return {
    ...f,
    q,
    sdkOwner: owner,
    credentialOwner,
    configuration,
    sealed,
    abort,
    get starts() {
      return starts;
    },
    get sentBody() {
      return sentBody;
    },
  };
}
