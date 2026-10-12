import type { ToolDef } from '@kontourai/station-contracts/tool';
import {
  type MCPLocalClaim,
  type MCPLocalConnectionCustody,
} from '@kontourai/station-shared/mcp';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { stationKnowledgeToolCatalog } from '../../tools/station-knowledge-mcp-server.js';
import { currentTenantExecutionContext } from '../bootstrap/runtime-tenant-context.js';
import { currentAuthorizedTurnCorrelation } from '../conversation/authorized-turn-correlation.js';
import {
  mintStationControlMcpHeaderAuth,
  verifyStationControlMcpTokenEntry,
} from './station-control-mcp-token.js';

type NativeKnowledgeSession = {
  active: boolean;
  turn?: { id: string; signal: AbortSignal };
  auth?: { url: string; token: string };
  clients: Set<Client>;
};
type NativeKnowledgeBridge = {
  claim: MCPLocalClaim;
  tools: ReturnType<typeof registerNativeKnowledgeTools>;
};
const bridges = new WeakMap<MCPLocalConnectionCustody, NativeKnowledgeBridge>();

export function createNativeStationKnowledgeTools(
  definition: ToolDef,
  port: number,
  claim: MCPLocalClaim,
  custody: MCPLocalConnectionCustody,
) {
  const existing = bridges.get(custody);
  if (existing?.claim.isCurrent())
    return { tools: existing.tools, retained: false };
  const tools = registerNativeKnowledgeTools(definition, port, claim);
  bridges.set(custody, { claim, tools });
  return { tools, retained: true };
}

const sessions = new Map<string, NativeKnowledgeSession>();

export function startNativeKnowledgeSession(sessionId: string): void {
  sessions.set(sessionId, { active: true, clients: new Set() });
}

export function beginNativeKnowledgeTurn(
  sessionId: string,
  turnId: string,
  signal: AbortSignal,
): void {
  const session = sessions.get(sessionId);
  if (session?.active) session.turn = { id: turnId, signal };
}

export function finishNativeKnowledgeTurn(
  sessionId: string,
  turnId: string,
): void {
  const session = sessions.get(sessionId);
  if (session?.turn?.id === turnId) session.turn = undefined;
}

export async function stopNativeKnowledgeSession(
  sessionId: string,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.active = false;
  sessions.delete(sessionId);
  await Promise.all([...session.clients].map((client) => client.close()));
}

/** Native registration is static; only an authorized turn may open a data connection. */
function registerNativeKnowledgeTools(
  definition: ToolDef,
  port: number,
  claim: MCPLocalClaim,
) {
  const clients = new Set<Client>();
  let phase: 'prepared' | 'closing' | 'closed' | 'close-failed' = 'prepared';
  claim.attach(
    {
      inspect: () => ({ phase, pendingOperations: clients.size }),
      close: async () => {
        phase = 'closing';
        try {
          await Promise.all([...clients].map((client) => client.close()));
          phase = 'closed';
        } catch (error) {
          phase = 'close-failed';
          throw error;
        }
      },
    },
    definition,
  );
  return stationKnowledgeToolCatalog().map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: tool.description,
    // Plain JSON Schema, like every other MCP tool's `parameters`: Strands
    // hands it to `FunctionTool` as-is, and `toVoltAgentTool` marks it with
    // the AI SDK's `jsonSchema()` on the VoltAgent side. These tools must NOT
    // claim `type: 'user-defined'` — that sends them to the AI SDK untouched,
    // where the catalog's `z.toJSONSchema()` output (which carries zod's
    // hidden `~standard` marker) is misread as a zod v3 schema ("reading
    // 'typeName'") and every turn of an agent holding them fails.
    parameters: tool.inputSchema,
    execute: (input: Record<string, unknown>) => {
      const correlation = currentAuthorizedTurnCorrelation();
      const session = correlation
        ? sessions.get(correlation.sessionId)
        : undefined;
      if (
        !correlation ||
        !session?.active ||
        session.turn?.id !== correlation.turnId ||
        session.turn.signal.aborted
      )
        throw new Error(
          'Knowledge requires an active authorized session turn.',
        );
      const turn = session.turn;
      return claim.run(async () => {
        if (!session.active || session.turn !== turn || turn.signal.aborted)
          throw new Error('Knowledge session turn has stopped.');
        const existing = session.auth;
        const entry = verifyStationControlMcpTokenEntry(existing?.token);
        const auth =
          existing &&
          entry?.serverId === 'station-knowledge' &&
          entry.channel === 'http-header-token'
            ? existing
            : mintStationControlMcpHeaderAuth(
                port,
                correlation.sessionId,
                currentTenantExecutionContext(),
                'station-knowledge',
              );
        session.auth = auth;
        const client = new Client({
          name: 'station-native-knowledge',
          version: '1.0.0',
        });
        clients.add(client);
        session.clients.add(client);
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(auth.url), {
              requestInit: {
                headers: { Authorization: `Bearer ${auth.token}` },
              },
            }),
            { signal: turn.signal },
          );
          if (
            !claim.isCurrent() ||
            !session.active ||
            session.turn !== turn ||
            turn.signal.aborted
          )
            throw new Error('Knowledge integration or session was retired.');
          return await client.callTool(
            { name: tool.name, arguments: input },
            { signal: turn.signal },
          );
        } finally {
          await client.close();
          clients.delete(client);
          session.clients.delete(client);
        }
      });
    },
  }));
}
