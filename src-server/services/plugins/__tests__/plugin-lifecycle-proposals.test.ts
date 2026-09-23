import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  MAX_OPEN_PROPOSALS_PER_AUTHOR,
  PLUGIN_LIFECYCLE_PROPOSALS_FILE,
  PluginLifecycleProposalService,
  PluginProposalInvalidError,
  PluginProposalLimitError,
  PluginProposalNotOpenError,
  resolvePluginProposalSource,
} from '../plugin-lifecycle-proposals.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0, cleanup.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function service() {
  const home = mkdtempSync(join(tmpdir(), 'station-s5-proposals-'));
  cleanup.push(home);
  return { home, proposals: new PluginLifecycleProposalService(home) };
}

const agent = (conversationId: string) => ({
  principal: 'agent' as const,
  agentSlug: 'station',
  conversationId,
});

describe('#2323 S5 plugin lifecycle proposal store', () => {
  test('an identical open proposal is returned, not duplicated, whoever asks', async () => {
    const { proposals } = service();
    const first = await proposals.propose({
      kind: 'install',
      source: '/tmp/plugins/pulse/',
      rationale: 'Adds the pulse pane.',
      author: agent('conv-1'),
    });
    // Same target, normalized spelling, a different conversation.
    const second = await proposals.propose({
      kind: 'install',
      source: '  /tmp/plugins/./pulse ',
      rationale: 'Please.',
      author: agent('conv-2'),
    });
    expect(first.deduplicated).toBe(false);
    expect(second).toEqual({ proposal: first.proposal, deduplicated: true });
    expect(proposals.listOpen()).toHaveLength(1);
    // A different kind for the same plugin is a different ask.
    await proposals.propose({
      kind: 'update',
      pluginName: 'pulse',
      rationale: 'New version.',
      author: agent('conv-1'),
    });
    expect(proposals.listOpen()).toHaveLength(2);
  });

  test('open proposals are capped per conversation, and the cap frees when one resolves', async () => {
    const { proposals } = service();
    const ids: string[] = [];
    for (let index = 0; index < MAX_OPEN_PROPOSALS_PER_AUTHOR; index++) {
      const { proposal } = await proposals.propose({
        kind: 'install',
        source: `/tmp/plugins/p${index}`,
        rationale: 'r',
        author: agent('conv-cap'),
      });
      ids.push(proposal.id);
    }
    await expect(
      proposals.propose({
        kind: 'install',
        source: '/tmp/plugins/one-more',
        rationale: 'r',
        author: agent('conv-cap'),
      }),
    ).rejects.toBeInstanceOf(PluginProposalLimitError);
    // Another conversation is not held by this one's cap.
    await expect(
      proposals.propose({
        kind: 'install',
        source: '/tmp/plugins/one-more',
        rationale: 'r',
        author: agent('conv-other'),
      }),
    ).resolves.toMatchObject({ deduplicated: false });
    await proposals.dismiss(ids[0]!);
    await expect(
      proposals.propose({
        kind: 'install',
        source: '/tmp/plugins/after-dismiss',
        rationale: 'r',
        author: agent('conv-cap'),
      }),
    ).resolves.toMatchObject({ deduplicated: false });
  });

  test('completion closes only a matching open proposal', async () => {
    const { proposals } = service();
    const { proposal } = await proposals.propose({
      kind: 'remove',
      pluginName: 'pulse',
      rationale: 'Unused.',
      author: agent('conv-1'),
    });
    expect(
      await proposals.complete(proposal.id, {
        kind: 'remove',
        pluginName: 'other',
      }),
    ).toMatchObject({ status: 'mismatch' });
    expect(
      await proposals.complete(proposal.id, {
        kind: 'update',
        pluginName: 'pulse',
      }),
    ).toMatchObject({ status: 'mismatch' });
    expect(proposals.get(proposal.id)?.status).toBe('open');
    expect(
      await proposals.complete(proposal.id, {
        kind: 'remove',
        pluginName: 'pulse',
      }),
    ).toMatchObject({ status: 'completed' });
    expect(proposals.get(proposal.id)).toMatchObject({
      status: 'completed',
      resolvedAt: expect.any(String),
    });
    expect(
      await proposals.complete(proposal.id, {
        kind: 'remove',
        pluginName: 'pulse',
      }),
    ).toMatchObject({ status: 'not-open' });
    await expect(proposals.dismiss(proposal.id)).rejects.toBeInstanceOf(
      PluginProposalNotOpenError,
    );
    expect(
      await proposals.complete('00000000-0000-4000-8000-000000000000', {
        kind: 'remove',
        pluginName: 'pulse',
      }),
    ).toEqual({ status: 'not-found' });
  });

  test('concurrent creates serialize: none is lost', async () => {
    const { proposals, home } = service();
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        proposals.propose({
          kind: 'install',
          source: `/tmp/plugins/concurrent-${index}`,
          rationale: 'r',
          author: agent(`conv-${index}`),
        }),
      ),
    );
    expect(proposals.listOpen()).toHaveLength(4);
    // A second instance over the same file reads what the first wrote.
    expect(new PluginLifecycleProposalService(home).listOpen()).toHaveLength(4);
    expect(
      JSON.parse(
        readFileSync(join(home, PLUGIN_LIFECYCLE_PROPOSALS_FILE), 'utf8'),
      ).proposals,
    ).toHaveLength(4);
  });

  test('a proposal carries no field an install reads as a decision', async () => {
    const { proposals } = service();
    const { proposal } = await proposals.propose({
      kind: 'install',
      source: '/tmp/plugins/pulse',
      rationale: 'r',
      author: agent('conv-1'),
      proposedContentDigest: `sha256:${'c'.repeat(64)}`,
    });
    expect(Object.keys(proposal).sort()).toEqual(
      [
        'author',
        'createdAt',
        'id',
        'kind',
        'proposedContentDigest',
        'rationale',
        'source',
        'status',
        'updatedAt',
      ].sort(),
    );
    for (const decisionField of [
      'consent',
      'permissions',
      'contentDigest',
      'grantRevision',
    ]) {
      expect(proposal).not.toHaveProperty(decisionField);
    }
  });

  test('rationale is required and bounded', async () => {
    const { proposals } = service();
    await expect(
      proposals.propose({
        kind: 'update',
        pluginName: 'pulse',
        rationale: '   ',
        author: agent('c'),
      }),
    ).rejects.toMatchObject({ code: 'rationale-required' });
    await expect(
      proposals.propose({
        kind: 'update',
        pluginName: 'pulse',
        rationale: 'x'.repeat(2001),
        author: agent('c'),
      }),
    ).rejects.toMatchObject({ code: 'rationale-too-long' });
  });
});

describe('#2323 S5 install proposal sources', () => {
  test('local folders are normalized; network paths are refused before any filesystem call', () => {
    expect(resolvePluginProposalSource(' /tmp/a/../b ')).toEqual({
      kind: 'local',
      source: '/tmp/b',
    });
    for (const [source, code] of [
      ['//host/share/plugin', 'network-path-refused'],
      ['/net/host/plugin', 'network-path-refused'],
      ['relative/plugin', 'source-not-absolute'],
      ['ftp://example.com/plugin', 'source-unsupported'],
      ['https://user@github.com/org/plugin.git', 'source-unsupported'],
      ['/tmp/a\u0000b', 'source-invalid'],
    ] as const) {
      expect(() => resolvePluginProposalSource(source), source).toThrow(
        PluginProposalInvalidError,
      );
      try {
        resolvePluginProposalSource(source);
      } catch (error) {
        expect((error as PluginProposalInvalidError).code, source).toBe(code);
      }
    }
  });

  test('git sources are accepted as written and never fetched', () => {
    expect(
      resolvePluginProposalSource('https://github.com/org/plugin.git'),
    ).toEqual({ kind: 'git', source: 'https://github.com/org/plugin.git' });
    expect(
      resolvePluginProposalSource('git@github.com:org/plugin.git'),
    ).toEqual({ kind: 'git', source: 'git@github.com:org/plugin.git' });
  });
});
