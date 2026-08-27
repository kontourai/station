import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCoreCommand } from '../commands/core.js';

/**
 * Unknown-input parity (#CLI audit item 4). `station connections bogus` already
 * named its valid actions; `station agents bogus` said only "Unknown agents
 * action: bogus" and left the user to guess. These pin the shared sentence.
 *
 * A throwaway STATION_HOME keeps host resolution off the developer's registry;
 * none of these cases reaches the network, because the action is rejected
 * before any request is issued.
 */
describe('core command unknown-action messages', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.STATION_HOME;
    home = mkdtempSync(join(tmpdir(), 'station-core-actions-'));
    process.env.STATION_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('names the valid actions for an unknown agents action', async () => {
    await expect(runCoreCommand('agents', ['bogus'])).rejects.toThrow(
      /Unknown agents action: bogus\. Use 'list', 'get', 'create', 'update', 'delete', 'chat', 'conversations', 'messages', 'workflows'\./,
    );
  });

  it('suggests the nearest action when the typo is close', async () => {
    await expect(runCoreCommand('agents', ['lst'])).rejects.toThrow(
      /Did you mean 'list'\?/,
    );
    await expect(runCoreCommand('projects', ['delet'])).rejects.toThrow(
      /Did you mean 'delete'\?/,
    );
  });

  it('names the valid actions when the action word is missing entirely', async () => {
    await expect(runCoreCommand('tasks', [])).rejects.toThrow(
      /Missing action for tasks\. Use 'list', 'get', 'create', 'attach-turn', 'show-turn', 'attach-input', 'show-inputs', 'attach-result', 'show-results', 'basis', 'show-support', 'list-support-bundles', 'list-support-claims', 'attach-support', 'replace-support', 'remove-support', 'list-outputs', 'get-output', 'keep-output', 'download-output', 'delete-output'\./,
    );
  });

  it('covers every core resource, not just agents', async () => {
    for (const command of ['projects', 'skills', 'tasks']) {
      await expect(runCoreCommand(command, ['bogus'])).rejects.toThrow(
        new RegExp(`Unknown ${command} action: bogus\\. Use 'list'`),
      );
    }
  });

  // The Playbooks→Skills merge DELETED these verbs outright; there is no
  // alias window, so the dispatcher must not know them at all.
  it('does not route the retired playbooks/prompts verbs', async () => {
    for (const retired of ['playbooks', 'prompts']) {
      await expect(runCoreCommand(retired, ['list'])).rejects.toThrow(
        `Unknown core command: ${retired}`,
      );
    }
  });
});
