import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { expect, test } from 'vitest';
import { workloadBudgetEngineContext } from '../../../services/infra/workload-budget.js';
import { hostImageAgentInstruction } from '../../../services/orchestration/host-image-turn-capture.js';
import { createStationBrowserMcpServer } from '../../../tools/station-browser-mcp-server.js';
import {
  createSelectedStationControlMcpServer,
  stationControlToolCatalog,
} from '../../../tools/station-control-mcp-server.js';
import { createStationDocsMcpServer } from '../../../tools/station-docs-mcp-server.js';
import {
  composeStationInstructions,
  effectiveStationControlTools,
} from '../station-orchestration-instructions.js';

/**
 * The context Station itself adds to every engine session, in UTF-8 bytes.
 * Pull-request CI (`.github/workflows/agent-context-budget.yml`) fails when a
 * change raises any value above main's copy of the JSON, unless a maintainer
 * adds the `agent-context-increase` label; this test keeps the JSON equal to
 * the live source, so the context cannot grow by leaving the file alone.
 * Lower a value when the text shrinks. See docs/guides/testing.md
 * (#agent-context-budget).
 */
const BUDGET_URL = new URL('../agent-context-budget.json', import.meta.url);

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * What `tools/list` puts in front of the model, over a real MCP connection.
 * Claude and Codex give the model each tool's name, description and input
 * schema; title, annotations and `_meta` are protocol metadata.
 */
async function toolListJsonBytes(server: McpServer): Promise<number> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'agent-context-budget', version: '1' });
  try {
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    return utf8Bytes(
      JSON.stringify(
        tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      ),
    );
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Station's orchestration instructions as a Claude session with the whole
 * station-control catalog receives them (the largest composition: browser,
 * devices and the ToolSearch loading line all apply).
 */
function claudeStationInstructions(): string {
  const catalog = stationControlToolCatalog().map((tool) => tool.name);
  const composed = composeStationInstructions({
    controlTools: effectiveStationControlTools({}, catalog, 'bound'),
    browser: true,
    devices: true,
    delegated: false,
    harness: 'claude',
    toolSearch: true,
    progressiveFamilies: false,
  });
  if (!composed) throw new Error('Station instructions composed to nothing');
  return composed.text;
}

test('Station-injected agent context matches the committed budget', async () => {
  const measured = {
    // Claude's in-process delivery: the session credential is `bound`, the
    // widest listing. Codex and ACP see the `delegated-custody` subset.
    stationControlToolListJsonBytes: await toolListJsonBytes(
      createSelectedStationControlMcpServer(
        undefined,
        undefined,
        'station-control',
        'bound',
      ),
    ),
    stationBrowserToolListJsonBytes: await toolListJsonBytes(
      createStationBrowserMcpServer(),
    ),
    stationKnowledgeToolListJsonBytes: await toolListJsonBytes(
      createSelectedStationControlMcpServer(
        undefined,
        undefined,
        'station-knowledge',
        'bound',
      ),
    ),
    stationDocsToolListJsonBytes: await toolListJsonBytes(
      createStationDocsMcpServer(),
    ),
    stationInstructionsClaudeBytes: utf8Bytes(claudeStationInstructions()),
    workloadBudgetContextBytes: utf8Bytes(
      workloadBudgetEngineContext({
        memoryMaxBytes: 4096 * 1024 * 1024,
        swapMaxBytes: 1024 * 1024 * 1024,
        tasksMax: 4096,
      }),
    ),
    hostImageInstructionBytes: utf8Bytes(
      hostImageAgentInstruction({ workingFolder: true, tmpdir: true }) ?? '',
    ),
  };
  const budget: unknown = JSON.parse(readFileSync(BUDGET_URL, 'utf8'));

  expect(
    measured,
    'Set src-server/runtime/agents/agent-context-budget.json to the measured values. Growth needs the agent-context-increase label on the pull request.',
  ).toEqual(budget);
});
