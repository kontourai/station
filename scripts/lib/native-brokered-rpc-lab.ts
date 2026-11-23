/** Real CLI/MCP transport probe with synthetic replies; no parent grant or paid call. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v3';
import { prepareNativeBrokeredModelRequest } from '../../src-server/runtime/conversation/native-text-model-request.js';
import { NativeModelContainer } from '../../src-server/services/connections/native-model-container.js';
import {
  nativeMessagesTextStream,
  nativeResponsesStream,
  nativeToolCallStream,
} from './native-provider-stream-fixture.js';

const packetSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .passthrough();

export async function runNativeBrokeredRpcLab(input: {
  artifacts: string;
  imageId: string;
  dockerExecutable: string;
  endpoint: string;
  producers: readonly {
    name: 'claude' | 'codex';
    version: string;
    sha256: string;
  }[];
}) {
  const results: unknown[] = [];
  for (const engine of ['claude', 'codex'] as const) {
    const root = join(input.artifacts, `native-brokered-rpc-${engine}`);
    mkdirSync(root, { mode: 0o700 });
    const nonce = randomUUID(),
      callId = `broker-${randomUUID()}`;
    const marker = join(root, 'effect.txt');
    const namespaceId = `brokered-rpc-${randomUUID()}`;
    const modelId =
      engine === 'claude' ? 'claude-sonnet-4-5' : 'station-channel-fixture';
    const toolName = 'mcp__station_delegation__report_probe';
    const tool = {
      name: 'report_probe',
      description: 'Return the controlled probe receipt.',
      inputSchema: {
        type: 'object',
        properties: { nonce: { type: 'string' } },
        required: ['nonce'],
        additionalProperties: false,
      },
    };
    const reply = 'BROKERED_NATIVE_COMPLETE',
      effect = `NATIVE_BROKER_EFFECT_CONFIRMED:${nonce}`;
    let active = true,
      calls = 0,
      effects = 0;
    const methods: string[] = [];
    const receipt: Record<string, unknown> = {
      engine,
      status: 'NOT_VERIFIED',
      paidCalls: 0,
      parentAuthorityQualified: false,
      portableAuthorityQualified: false,
      methods,
    };
    const save = () =>
      writeFileSync(
        join(root, 'receipt.json'),
        JSON.stringify(receipt, null, 2),
        { mode: 0o600 },
      );
    const owner = NativeModelContainer.prepare({
      namespaceId,
      imageId: input.imageId,
      dockerExecutable: input.dockerExecutable,
      endpoint: input.endpoint,
      controllerRoot: root,
      delegationRpc: (request, signal) => {
        signal.throwIfAborted();
        assert.ok(active);
        const packet = packetSchema.parse(
          JSON.parse(request.body.toString('utf8')),
        );
        methods.push(packet.method);
        let result: unknown;
        if (packet.id === undefined) {
          assert.equal(packet.method, 'notifications/initialized');
          return {
            response: Promise.resolve(new Response(null, { status: 202 })),
            settled: Promise.resolve(),
            invokeDelivery: async (write) => {
              assert.ok(active);
              write();
            },
          };
        }
        if (packet.method === 'initialize') {
          const params = z
            .object({ protocolVersion: z.string() })
            .passthrough()
            .parse(packet.params);
          result = {
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'controlled-broker', version: '1' },
          };
        } else if (packet.method === 'tools/list') {
          result = {
            tools: [tool],
          };
        } else if (packet.method === 'tools/call') {
          z.object({
            name: z.literal('report_probe'),
            arguments: z.object({ nonce: z.literal(nonce) }).strict(),
          })
            .strict()
            .parse(packet.params);
          assert.equal(effects++, 0, 'probe effect must execute once');
          writeFileSync(marker, effect, { flag: 'wx', mode: 0o600 });
          result = {
            content: [{ type: 'text', text: effect }],
            isError: false,
          };
        } else {
          assert.equal(packet.method, 'ping');
          result = {};
        }
        return {
          response: Promise.resolve(
            Response.json({ jsonrpc: '2.0', id: packet.id, result }),
          ),
          settled: Promise.resolve(),
          invokeDelivery: async (write) => {
            signal.throwIfAborted();
            assert.ok(active);
            write();
          },
        };
      },
      request: (request, signal) => {
        signal.throwIfAborted();
        assert.ok(active);
        assert.ok(++calls <= 2, 'unexpected physical model request');
        writeFileSync(
          join(root, `native-request-${calls}.json`),
          request.body,
          {
            mode: 0o600,
          },
        );
        const final = prepareNativeBrokeredModelRequest(request, {
          provider: engine === 'claude' ? 'anthropic' : 'openai',
          modelId,
          maxOutputTokens: 2048,
          tools: [tool],
        });
        const body = JSON.parse(final.body.toString('utf8'));
        assert.ok(
          (engine === 'claude' ? body.max_tokens : body.max_output_tokens) <=
            2048,
        );
        writeFileSync(join(root, `request-${calls}.json`), final.body, {
          mode: 0o600,
        });
        let response: Response;
        if (calls === 1) {
          if (engine === 'claude') {
            assert.equal(
              body.tools.filter(
                (tool: { name?: string }) => tool.name === toolName,
              ).length,
              1,
              'owned MCP tool must reach Claude',
            );
            response = nativeToolCallStream(engine, modelId, callId, toolName, {
              nonce,
            });
          } else {
            const namespace = body.tools.find(
              (tool: { type?: string; name?: string }) =>
                tool.type === 'namespace' &&
                tool.name === 'mcp__station_delegation',
            );
            assert.ok(namespace, 'owned MCP namespace must reach Codex');
            assert.equal(
              namespace.tools.filter(
                (tool: { name?: string }) => tool.name === 'report_probe',
              ).length,
              1,
            );
            response = nativeResponsesStream(
              modelId,
              {
                id: 'fc-broker-probe',
                type: 'function_call',
                status: 'completed',
                call_id: callId,
                name: 'report_probe',
                namespace: 'mcp__station_delegation',
                arguments: JSON.stringify({ nonce }),
              },
              'resp-broker-call',
            );
          }
        } else {
          assert.equal(effects, 1, 'actual RPC effect must precede follow-up');
          assert.equal(readFileSync(marker, 'utf8'), effect);
          const results =
            engine === 'claude'
              ? body.messages
                  .filter(
                    (message: { role: string }) => message.role === 'user',
                  )
                  .flatMap((message: { content: unknown }) =>
                    Array.isArray(message.content) ? message.content : [],
                  )
                  .filter(
                    (part: { type: string; tool_use_id?: string }) =>
                      part.type === 'tool_result' &&
                      part.tool_use_id === callId,
                  )
              : body.input.filter(
                  (item: { type: string; call_id?: string }) =>
                    item.type === 'function_call_output' &&
                    item.call_id === callId,
                );
          assert.equal(
            results.length,
            1,
            'exact native call must have one result',
          );
          assert.ok(
            JSON.stringify(
              engine === 'claude' ? results[0].content : results[0].output,
            ).includes(effect),
            'broker result must reach the next model request as the exact tool result',
          );
          response =
            engine === 'claude'
              ? nativeMessagesTextStream(modelId, reply, {
                  input_tokens: 4,
                  output_tokens: 2,
                })
              : nativeResponsesStream(
                  modelId,
                  {
                    id: 'msg-broker-final',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                      { type: 'output_text', text: reply, annotations: [] },
                    ],
                  },
                  'resp-broker-final',
                );
        }
        return {
          response: Promise.resolve(response),
          settled: Promise.resolve(),
          invokeDelivery: async (write) => {
            signal.throwIfAborted();
            assert.ok(active);
            write();
          },
        };
      },
    });
    let run:
      | Awaited<ReturnType<NativeModelContainer['startBrokeredText']>>
      | undefined;
    let failure: unknown;
    save();
    try {
      await owner.start();
      run = await owner.startBrokeredText({
        engine,
        modelId,
        ...(engine === 'codex'
          ? { modelCatalogPath: '/station/fixture-models.json' }
          : {}),
        signal: AbortSignal.timeout(60_000),
        writePrompt: async (stdin) =>
          new Promise<void>((resolve, reject) =>
            stdin.write(
              'Use report_probe once, then return BROKERED_NATIVE_COMPLETE.',
              (error) => (error ? reject(error) : resolve()),
            ),
          ),
      });
      const result = await run.result;
      await run.settled;
      writeFileSync(join(root, 'native-stdout.txt'), result.stdout, {
        mode: 0o600,
      });
      writeFileSync(join(root, 'native-stderr.txt'), result.stderr, {
        mode: 0o600,
      });
      assert.equal(calls, 2);
      assert.equal(effects, 1);
      assert.ok(
        methods.includes('initialize') &&
          methods.includes('tools/list') &&
          methods.includes('tools/call'),
      );
      if (engine === 'claude') {
        const completed = JSON.parse(result.stdout);
        assert.equal(completed.type, 'result');
        assert.equal(completed.subtype, 'success');
        assert.equal(completed.is_error, false);
        assert.equal(completed.result, reply);
        assert.deepEqual(completed.permission_denials, []);
        assert.ok(completed.num_turns >= 2);
      } else {
        const events = result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        for (const type of ['thread.started', 'turn.started', 'turn.completed'])
          assert.equal(events.filter((event) => event.type === type).length, 1);
        assert.equal(
          events.filter(
            (event) => event.type === 'error' || event.type === 'turn.failed',
          ).length,
          0,
        );
        assert.ok(
          events.some(
            (event) =>
              event.type === 'item.completed' &&
              event.item?.type === 'agent_message' &&
              event.item.text === reply,
          ),
        );
      }
      await assert.rejects(
        owner.captureTextExecutionReceipt(),
        /native_text_completion_unavailable/,
      );
      const producer = owner.inspectTextProducerReceipt(
        await owner.captureTextProducerReceipt(),
      );
      const expected = input.producers.find((entry) => entry.name === engine);
      assert.ok(expected);
      assert.equal(producer.executableSha256, expected.sha256);
      assert.equal(producer.cliVersion, expected.version);
      Object.assign(receipt, {
        producer,
        modelRequests: calls,
        effects,
        stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
        status: 'PASS_SCOPED_NATIVE_BROKER_RPC',
      });
    } catch (error) {
      failure = error;
      receipt.failure = {
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      active = false;
      const cleanup: unknown[] = [];
      try {
        await run?.close();
      } catch (error) {
        cleanup.push(error);
      }
      try {
        await owner.close();
      } catch (error) {
        cleanup.push(error);
      }
      try {
        await run?.settled;
      } catch (error) {
        cleanup.push(error);
      }
      const state = owner.inspect();
      const privateOutputPath = join(
        createHash('sha256').update(namespaceId).digest('hex'),
        'native-text-output.json',
      );
      if (existsSync(join(root, privateOutputPath)))
        receipt.privateOutputPath = privateOutputPath;
      receipt.cleanup = state;
      try {
        assert.equal(state.removed, true);
        assert.equal(state.modelChannel?.workerSettled, true);
        assert.equal(state.modelChannel?.pending, 0);
      } catch (error) {
        cleanup.push(error);
      }
      if (cleanup.length || failure) receipt.status = 'NOT_VERIFIED';
      receipt.cleanupFailures = cleanup.map((error) =>
        error instanceof Error ? error.message : String(error),
      );
      try {
        save();
      } catch (error) {
        cleanup.push(error);
      }
      if (cleanup.length)
        failure = new AggregateError(
          [...(failure ? [failure] : []), ...cleanup],
          'native_brokered_rpc_cleanup_unconfirmed',
        );
    }
    if (failure) throw failure;
    results.push(receipt);
  }
  return results;
}
