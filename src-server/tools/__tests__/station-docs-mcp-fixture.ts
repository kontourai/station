import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createStationDocsMcpServer } from '../station-docs-mcp-server.js';

export async function callTool(name: string, args: Record<string, unknown>) {
  const server = createStationDocsMcpServer();
  const client = new Client({ name: 'docs-test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    const result = await client.callTool({ name, arguments: args });
    const content = result.content[0];
    if (result.isError) {
      const detail = content?.type === 'text' ? content.text : 'No error text';
      throw new Error(`Documentation tool '${name}' failed: ${detail}`);
    }
    if (content?.type !== 'text') {
      throw new Error(`Expected a documentation text result from '${name}'.`);
    }
    return JSON.parse(content.text);
  } finally {
    try {
      await client.close();
    } finally {
      await server.close();
    }
  }
}
