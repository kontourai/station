import { isDeepStrictEqual } from 'node:util';
import type { DelegationEnvelopeV2 } from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  delegationEnvelopeDigestV2,
  validateDelegationEnvelopeV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import type { InputRequestResponse } from '@kontourai/station-contracts/input-request';
import { readInputRequestResponse } from '@kontourai/station-shared/input-request';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { inputRequestFromMcpElicitation } from '@kontourai/station-shared/mcp-elicitation';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  inputRequired,
  inputResponse,
  McpServer,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { StationDelegationPersistence } from '../../services/orchestration/delegation-group-persistence.js';
import {
  type ReportInputBinding,
  ReportInputLedger,
  reportInputBindingSchema,
} from '../../services/orchestration/report-input-ledger.js';
import {
  REPORT_INPUT_TOOL_NAME,
  readReportInputQuestion,
} from '../conversation/report-input-profile.js';
import type { ReservedStationInputRuntime } from '../conversation/reserved-station-turn.js';

const SERVER_ID = 'station-report-input';
const ENDPOINT = 'https://station-report-input.invalid/mcp';
function requireInput(value: unknown): asserts value {
  if (!value) throw new Error('report_input_unavailable');
}
function formRequest(question: string) {
  return {
    message: question,
    requestedSchema: {
      type: 'object' as const,
      properties: {
        answer: { type: 'string' as const, minLength: 1, maxLength: 512 },
      },
      required: ['answer'],
      additionalProperties: false,
    },
  };
}
function serverFactory(question: string) {
  const server = new McpServer({ name: SERVER_ID, version: '1.0.0' });
  server.registerTool(
    REPORT_INPUT_TOOL_NAME,
    {
      description: 'Ask the operator for report clarification.',
      inputSchema: { question: z.string().min(1).max(512) },
    },
    async (args, context) => {
      requireInput(args.question === question);
      const response = inputResponse(
        context.mcpReq.inputResponses,
        'clarification',
      );
      if (response.kind === 'missing')
        return inputRequired({
          inputRequests: {
            clarification: inputRequired.elicit(formRequest(question)),
          },
        });
      requireInput(response.kind === 'elicit');
      const answer = readInputRequestResponse(
        response.action === 'accept'
          ? { action: 'accept', content: response.content }
          : { action: response.action },
      );
      requireInput(answer);
      return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
    },
  );
  return server;
}

// UNWIRED(#91): the report producer still needs explicit input-profile and root-tool admission.
export function createReportInputRuntime(owners: {
  persistence: StationDelegationPersistence;
  authorize(binding: ReportInputBinding): Promise<DelegationEnvelopeV2>;
}): ReservedStationInputRuntime {
  return async (request, open, signal, assertCurrent) => {
    const binding = reportInputBindingSchema.parse(
      structuredClone(request.binding),
    );
    requireInput(
      binding.providerToolCallId === request.id &&
        binding.question === request.question &&
        isDeepStrictEqual(binding.providerEvidence, request.providerEvidence),
    );
    const current = (): undefined => {
      assertCurrent();
      signal.throwIfAborted();
      return undefined;
    };
    const authorize = async () => {
      current();
      const envelope = validateDelegationEnvelopeV2(
        await owners.authorize(structuredClone(binding)),
      );
      current();
      requireInput(
        envelope.envelope_id === binding.envelope.id &&
          envelope.generation === binding.envelope.generation &&
          delegationEnvelopeDigestV2(envelope) === binding.envelope.digest &&
          isDeepStrictEqual(envelope.root_authority_ref, binding.authority) &&
          binding.rootId === binding.authority.id &&
          envelope.execution_id === binding.executionId &&
          envelope.execution_authority.posture === 'report-only' &&
          envelope.execution_authority.approval === 'automatic' &&
          envelope.execution_authority.escalation === 'deny' &&
          isDeepStrictEqual(envelope.execution_authority.allowed_tools, [
            REPORT_INPUT_TOOL_NAME,
          ]) &&
          envelope.execution_authority.readable_resources.length === 0 &&
          envelope.execution_authority.mutable_resources.length === 0,
      );
    };
    await authorize();
    await owners.persistence.assertProviderEvidenceReference(
      binding.providerEvidence,
      {
        groupId: binding.groupId,
        rootId: binding.rootId,
        invocationId: binding.invocationId,
        executionId: binding.executionId,
        usage: binding.usage,
        inputIntent: {
          seatId: binding.seatId,
          root: binding.authority,
          envelope: binding.envelope,
        },
      },
      current,
    );
    current();
    const ledger = new ReportInputLedger(
      owners.persistence.reportInputStore(current),
    );
    await ledger.begin(binding);
    current();
    const handler = createMcpHandler(() => serverFactory(binding.question), {
      legacy: 'reject',
    });
    const custody = new MCPLocalConnectionCustody({ capacity: 1 });
    const claim = custody.acquire(SERVER_ID, 'managed');
    let result: InputRequestResponse | undefined;
    try {
      const connection = await claim.connect(
        {
          id: SERVER_ID,
          kind: 'mcp',
          transport: 'streamable-http',
          endpoint: ENDPOINT,
        },
        {
          transportFactory: () =>
            new StreamableHTTPClientTransport(new URL(ENDPOINT), {
              requestInit: { redirect: 'error' },
              fetch: async (input, init) => {
                current();
                const received =
                  input instanceof Request ? input : new Request(input, init);
                requireInput(received.url === ENDPOINT);
                return handler.fetch(received);
              },
            }),
          onTransport: (transport) => {
            const send = transport.send.bind(transport);
            transport.send = async (message, options) => {
              current();
              requireInput(claim.isCurrent());
              const snapshot = structuredClone(message);
              if ('method' in snapshot && snapshot.method === 'tools/call') {
                requireInput(
                  snapshot.params?.name === REPORT_INPUT_TOOL_NAME &&
                    readReportInputQuestion(snapshot.params?.arguments) ===
                      binding.question,
                );
                const responses = snapshot.params?.inputResponses;
                let response: InputRequestResponse | undefined;
                if (responses !== undefined) {
                  requireInput(
                    responses &&
                      typeof responses === 'object' &&
                      !Array.isArray(responses) &&
                      Object.keys(responses).length === 1 &&
                      'clarification' in responses,
                  );
                  response =
                    readInputRequestResponse(responses.clarification) ??
                    undefined;
                  requireInput(
                    response &&
                      isDeepStrictEqual(response, responses.clarification),
                  );
                }
                await authorize();
                await ledger.consumeSend(binding, response);
                current();
                requireInput(claim.isCurrent());
              }
              return send(snapshot, options);
            };
          },
        },
      );
      current();
      requireInput(connection.negotiation.era === 'modern');
      requireInput(
        connection.withElicitationRoute &&
          connection.tools.length === 1 &&
          connection.tools[0].originalName === REPORT_INPUT_TOOL_NAME,
      );
      const expectedForm = inputRequestFromMcpElicitation(
        SERVER_ID,
        formRequest(binding.question),
      );
      requireInput(expectedForm);
      const tool = await claim.run(() =>
        connection.withElicitationRoute!(
          async (elicitation) => {
            current();
            const form = inputRequestFromMcpElicitation(
              elicitation.serverId,
              elicitation.params,
            );
            requireInput(isDeepStrictEqual(form, expectedForm));
            await authorize();
            const answer = await open(
              expectedForm,
              async (event) => {
                current();
                await ledger.bindQuestion(binding, event);
                current();
              },
              elicitation.signal,
            );
            current();
            await authorize();
            await ledger.retainAnswer(binding, answer);
            current();
            if (answer.action !== 'accept') return { action: answer.action };
            requireInput(
              typeof answer.content.answer === 'string' &&
                Object.keys(answer.content).length === 1,
            );
            return {
              action: 'accept',
              content: { answer: answer.content.answer },
            };
          },
          () =>
            connection.client.callTool(
              {
                name: REPORT_INPUT_TOOL_NAME,
                arguments: { question: binding.question },
              },
              { signal, timeout: 10 * 60 * 1000 },
            ),
        ),
      );
      current();
      requireInput(
        !tool.isError &&
          tool.content.length === 1 &&
          tool.content[0].type === 'text',
      );
      requireInput(Buffer.byteLength(tool.content[0].text) <= 8192);
      result =
        readInputRequestResponse(JSON.parse(tool.content[0].text)) ?? undefined;
      requireInput(result);
    } finally {
      const cleanup = await Promise.allSettled([
        claim.close(),
        handler.close(),
      ]);
      requireInput(cleanup.every((entry) => entry.status === 'fulfilled'));
    }
    current();
    return ledger.finish(binding, result);
  };
}
