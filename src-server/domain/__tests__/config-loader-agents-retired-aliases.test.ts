// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentConfig, saveAgentConfig } from '../config-loader-agents.js';

/**
 * station#2832 — `tools.aliases` is retired from the schema.
 *
 * `tools` is `additionalProperties: false`, so removing the property WITHOUT
 * stripping it first would make every agent config that carries the key fail
 * validation on load — the agent would simply vanish from the product. These
 * tests exist to hold the migration path, not the removal: the removal is
 * proven by the type system (the field no longer exists on `AgentTools`).
 */
describe('config-loader-agents — retired tools.aliases (station#2832)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'station-agent-aliases-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeAgentJson(slug: string, spec: unknown) {
    const dir = join(home, 'agents', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.json'), JSON.stringify(spec, null, 2));
  }

  it('loads an existing config that still carries tools.aliases', async () => {
    writeAgentJson('legacy', {
      name: 'Legacy Agent',
      prompt: 'You predate the removal.',
      tools: {
        mcpServers: ['github'],
        aliases: { github_run_workflow: 'run' },
      },
    });

    const spec = await loadAgentConfig(home, 'legacy');

    expect(spec.name).toBe('Legacy Agent');
    expect(
      (spec.tools as unknown as Record<string, unknown> | undefined)?.aliases,
    ).toBeUndefined();
  });

  it('keeps every sibling tools field while dropping aliases', async () => {
    writeAgentJson('rich', {
      name: 'Rich Agent',
      prompt: 'You have a full tools block.',
      tools: {
        mcpServers: ['github', 'linear'],
        available: ['Read', 'Write'],
        autoApprove: ['Read'],
        env: { TOKEN_NAME: 'x' },
        aliases: { a: 'b' },
      },
    });

    const spec = await loadAgentConfig(home, 'rich');
    const tools = spec.tools as unknown as Record<string, unknown>;

    expect(tools.mcpServers).toEqual(['github', 'linear']);
    expect(tools.available).toEqual(['Read', 'Write']);
    expect(tools.autoApprove).toEqual(['Read']);
    expect(tools.env).toEqual({ TOKEN_NAME: 'x' });
    expect(tools.aliases).toBeUndefined();
  });

  it('erases the key from disk on the next save of that agent', async () => {
    writeAgentJson('rewritten', {
      name: 'Rewritten Agent',
      prompt: 'You are about to be saved.',
      tools: { mcpServers: ['github'], aliases: { a: 'b' } },
    });

    const spec = await loadAgentConfig(home, 'rewritten');
    await saveAgentConfig(home, 'rewritten', spec);

    const onDisk = readFileSync(
      join(home, 'agents', 'rewritten', 'agent.json'),
      'utf-8',
    );
    expect(onDisk).not.toContain('aliases');
    expect(JSON.parse(onDisk).tools.mcpServers).toEqual(['github']);
  });

  it('keeps loading a null tools value, which the schema permits', async () => {
    // `tools` is typed `["object", "null"]`, so null is VALID and must survive
    // the strip. The strip runs before validation on unvalidated bytes, so a
    // naive `typeof tools === 'object'` guard would throw a TypeError here and
    // break a config the schema accepts.
    writeAgentJson('nulled', {
      name: 'Nulled Agent',
      prompt: 'My tools value is null.',
      tools: null,
    });

    await expect(loadAgentConfig(home, 'nulled')).resolves.toMatchObject({
      name: 'Nulled Agent',
    });
  });

  it('keeps loading an agent with no tools block at all', async () => {
    // The commonest shape in the wild, and the one the strip is most dangerous
    // to: `undefined` throws when used as an object receiver, so without the
    // `typeof` guard EVERY tools-less agent becomes unloadable. Named here
    // because a migration's worst failure is on the input nobody thought to
    // write a case for.
    writeAgentJson('plain', {
      name: 'Plain Agent',
      prompt: 'I have no tools block.',
    });

    await expect(loadAgentConfig(home, 'plain')).resolves.toMatchObject({
      name: 'Plain Agent',
    });
  });

  it('surfaces the schema error for a non-object tools value', async () => {
    // NB: this does NOT prove the strip's `typeof`/`Array.isArray` clauses —
    // `delete` on a string, number, or array does not throw, so it passes with
    // or without them. The clauses that ARE load-bearing (undefined, null) are
    // pinned by the two tests above. This only holds the user-facing error.
    for (const tools of ['aliases', 42, ['aliases']]) {
      writeAgentJson('hostile', {
        name: 'Hostile Agent',
        prompt: 'Your tools value is wrong.',
        tools,
      });

      await expect(loadAgentConfig(home, 'hostile')).rejects.toThrow(
        /Invalid agent configuration/,
      );
    }
  });
});
