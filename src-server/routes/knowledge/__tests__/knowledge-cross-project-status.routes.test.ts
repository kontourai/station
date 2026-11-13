/**
 * `GET /api/knowledge/status` names the vector store and embedding model in
 * use, and a configured one that is turned off when none is on, so the
 * Knowledge page can say "turned off" and open it rather than say "none".
 */
import { describe, expect, test } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { createCrossProjectKnowledgeRoutes } from '../knowledge-cross-project.js';

const connection = (
  id: string,
  capability: 'vectordb' | 'embedding' | 'llm',
  enabled: boolean,
) => ({
  id,
  name: id,
  type: 'openai',
  enabled,
  capabilities: [capability],
});

function status(connections: ReturnType<typeof connection>[]) {
  return createCrossProjectKnowledgeRoutes(
    { listDocuments: async () => [] } as never,
    { listProjects: () => [] } as never,
    { listProviderConnections: () => connections } as never,
  ).request('/status');
}

describe('GET /status', () => {
  test('reports a configured store and embedding model that are turned off', async () => {
    const body = await json(
      await status([
        connection('chat', 'llm', true),
        connection('store', 'vectordb', false),
        connection('embed', 'embedding', false),
      ]),
    );
    expect(body.data.vectorDb).toMatchObject({ id: 'store', enabled: false });
    expect(body.data.embedding).toMatchObject({ id: 'embed', enabled: false });
  });

  test('prefers the one turned on, and reports none when none is configured', async () => {
    const body = await json(
      await status([
        connection('old-embed', 'embedding', false),
        connection('embed', 'embedding', true),
      ]),
    );
    expect(body.data.embedding).toMatchObject({ id: 'embed', enabled: true });
    expect(body.data.vectorDb).toBeNull();
  });
});
