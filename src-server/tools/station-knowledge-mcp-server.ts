import { z } from 'zod';
import { createSelectedStationControlMcpServer } from './station-control-mcp-server.js';

export function createStationKnowledgeMcpServer(
  allowedTools?: readonly string[],
) {
  return createSelectedStationControlMcpServer(
    allowedTools,
    undefined,
    'station-knowledge',
  );
}

export function stationKnowledgeToolCatalog() {
  const tools: {
    name: string;
    description: string;
    title: string;
    readOnly: boolean;
    group: string;
    inputSchema: Record<string, unknown>;
  }[] = [];
  createSelectedStationControlMcpServer(
    undefined,
    (name, description, shape) => {
      tools.push({
        name,
        description,
        title: name
          .replaceAll('_', ' ')
          .replace(/^./, (letter) => letter.toUpperCase()),
        readOnly: name !== 'add_knowledge_record',
        group: 'Knowledge',
        inputSchema: z.toJSONSchema(z.object(shape ?? {})),
      });
    },
    'station-knowledge',
  );
  return tools;
}
