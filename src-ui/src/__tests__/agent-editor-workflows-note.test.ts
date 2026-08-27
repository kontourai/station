import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AGENT_WORKFLOWS_CLI_COMMAND } from '../views/agent-editor/agentWorkflowsCli';

/**
 * The Tools tab tells operators that agent workflow files are CLI-managed
 * (station#2693). Pin that claim to the CLI's own help text so a rename of the
 * command cannot leave the editor advertising something that does not exist.
 */
describe('agent editor workflows note', () => {
  test('names a command the CLI actually documents', () => {
    const cliHelp = readFileSync(
      join(__dirname, '..', '..', '..', 'packages/cli/src/help.ts'),
      'utf8',
    );
    expect(cliHelp).toContain(AGENT_WORKFLOWS_CLI_COMMAND);
  });
});
