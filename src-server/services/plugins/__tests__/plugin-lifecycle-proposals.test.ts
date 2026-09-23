import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  MAX_OPEN_PROPOSALS_PER_AUTHOR,
  MAX_OPEN_PROPOSALS_PER_ENGINE,
  PLUGIN_LIFECYCLE_PROPOSALS_FILE,
  PluginLifecycleProposalService,
  PluginProposalInvalidError,
  PluginProposalLimitError,
  PluginProposalNotOpenError,
  pluginProposalSourceKey,
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

  test('completing a proposal frees its cap and lets the same ask be proposed again', async () => {
    const { proposals } = service();
    const ids: string[] = [];
    for (let index = 0; index < MAX_OPEN_PROPOSALS_PER_AUTHOR; index++) {
      const { proposal } = await proposals.propose({
        kind: 'install',
        source: `/tmp/plugins/c${index}`,
        rationale: 'r',
        author: agent('conv-complete'),
      });
      ids.push(proposal.id);
    }
    const next = {
      kind: 'install' as const,
      source: '/tmp/plugins/after-complete',
      rationale: 'r',
      author: agent('conv-complete'),
    };
    await expect(proposals.propose(next)).rejects.toBeInstanceOf(
      PluginProposalLimitError,
    );
    expect(
      await proposals.complete(ids[0]!, {
        kind: 'install',
        source: '/tmp/plugins/c0',
      }),
    ).toMatchObject({ status: 'completed' });
    await expect(proposals.propose(next)).resolves.toMatchObject({
      deduplicated: false,
    });

    // The completed install's source, asked again: a new open proposal,
    // not the completed record.
    const again = await proposals.propose({
      kind: 'install',
      source: '/tmp/plugins/c0',
      rationale: 'Again.',
      author: agent('conv-again'),
    });
    expect(again.deduplicated).toBe(false);
    expect(again.proposal.id).not.toBe(ids[0]);
    expect(again.proposal.status).toBe('open');
    expect(proposals.get(ids[0]!)?.status).toBe('completed');
  });

  test('every mutation holds the store lock around its write; a lock that fails writes nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-s5-proposals-lock-'));
    cleanup.push(home);
    const file = join(home, PLUGIN_LIFECYCLE_PROPOSALS_FILE);
    const events: string[] = [];
    const locked = new PluginLifecycleProposalService(home, {
      acquireMutationLock: async (lockPath) => {
        events.push(`acquire:${lockPath}`);
        return async () => {
          // What is on disk when the lock is released: the write happened
          // inside it.
          events.push(`release:written=${existsSync(file)}`);
        };
      },
    });
    await locked.propose({
      kind: 'update',
      pluginName: 'pulse',
      rationale: 'r',
      author: agent('c'),
    });
    expect(events).toEqual([
      `acquire:${file}.mutation`,
      'release:written=true',
    ]);

    const failingHome = mkdtempSync(
      join(tmpdir(), 'station-s5-proposals-lockfail-'),
    );
    cleanup.push(failingHome);
    const failing = new PluginLifecycleProposalService(failingHome, {
      acquireMutationLock: async () => {
        throw new Error('lock unavailable');
      },
    });
    await expect(
      failing.propose({
        kind: 'update',
        pluginName: 'pulse',
        rationale: 'r',
        author: agent('c'),
      }),
    ).rejects.toThrow('lock unavailable');
    expect(existsSync(join(failingHome, PLUGIN_LIFECYCLE_PROPOSALS_FILE))).toBe(
      false,
    );
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

  test('git sources are stored normalized, with host and path apart, and never fetched', () => {
    expect(
      resolvePluginProposalSource('https://GitHub.com/org/plugin.git/'),
    ).toEqual({
      kind: 'git',
      source: 'https://github.com/org/plugin.git',
      host: 'github.com',
      path: 'org/plugin.git',
    });
    expect(
      resolvePluginProposalSource('git@github.com:org/plugin.git'),
    ).toEqual({
      kind: 'git',
      source: 'git@github.com:org/plugin.git',
      host: 'github.com',
      path: 'org/plugin.git',
    });
  });

  /**
   * #2323 S5 review M2, the reviewer's probe cases. Each is refused, and
   * refused before anything is stored: a credential in a URL, a query or
   * fragment carrying a token, a homoglyph or punycode host, an invisible or
   * direction-changing character, a host that is really a path, a loopback,
   * metadata or private-network host, and an argument-shaped path.
   */
  test.each([
    ['https://:ghp_SECRET@github.com/kontourai/x', 'source-unsupported'],
    ['https://user@github.com/org/plugin.git', 'source-unsupported'],
    ['https://github.com/kontourai/x?token=ghp_SECRET', 'source-unsupported'],
    ['https://github.com/kontourai/x#access_token=abc', 'source-unsupported'],
    ['https://gіthub.com/kontourai/x', 'source-unsupported'],
    ['https://xn--gthub-n4a.com/kontourai/x', 'source-unsupported'],
    ['https://github.com/kontourai/‮txt.x', 'source-invalid'],
    ['https://github.com/kontourai/x​', 'source-invalid'],
    ['git@github.com:kontourai/x‮', 'source-invalid'],
    ['/Users/brian/dev/x‮abc', 'source-invalid'],
    ['https://github.com@evil.com/x', 'source-unsupported'],
    ['https://127.0.0.1:3141/api/x', 'source-unsupported'],
    ['https://127.0.0.1/api/x', 'source-unsupported'],
    ['https://169.254.169.254/latest', 'source-unsupported'],
    ['https://[::1]/x', 'source-unsupported'],
    ['https://localhost/x', 'source-unsupported'],
    ['https://git.corp.internal/x', 'source-unsupported'],
    ['https://github.com:8443/org/x', 'source-unsupported'],
    ['https://github.com/org/../x', 'source-unsupported'],
    ['https://github.com/', 'source-unsupported'],
    ['git@evil.com:--upload-pack=touch', 'source-unsupported'],
    ['git@127.0.0.1:org/x', 'source-unsupported'],
    ['git@exa_mple.com:org/x', 'source-unsupported'],
    ['ftp://example.com/plugin', 'source-unsupported'],
  ])('refuses %j (%s)', (source, code) => {
    let caught: unknown;
    try {
      resolvePluginProposalSource(source);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PluginProposalInvalidError);
    expect((caught as PluginProposalInvalidError).code).toBe(code);
  });

  test('a refused credential, query or fragment is named as such, so the agent learns what to drop', () => {
    // The host and path rules would also refuse these, with a sentence about
    // hosts and paths; the specific sentence is what tells an agent to remove
    // the token rather than retype the host.
    const message = (source: string) => {
      try {
        resolvePluginProposalSource(source);
      } catch (error) {
        return (error as Error).message;
      }
      return 'accepted';
    };
    expect(message('https://:ghp_SECRET@github.com/kontourai/x')).toBe(
      'A git URL must not carry a user name or password.',
    );
    expect(message('https://github.com/kontourai/x?token=ghp_SECRET')).toBe(
      'A git URL must not carry a query or fragment.',
    );
    expect(message('https://github.com/kontourai/x#access_token=abc')).toBe(
      'A git URL must not carry a query or fragment.',
    );
  });

  test('a git@host:path host that looks like a path is judged on its host alone', () => {
    // `git@evil.com:github.com/kontourai/x` is evil.com; the review shows the
    // host by itself, so it is accepted here and displayed as evil.com.
    expect(
      resolvePluginProposalSource('git@evil.com:github.com/kontourai/x'),
    ).toMatchObject({ host: 'evil.com', path: 'github.com/kontourai/x' });
  });

  test('a git path keeps its case; case-distinct paths are distinct keys', () => {
    expect(
      resolvePluginProposalSource('https://gitlab.example.com/Org/My-Plugin'),
    ).toEqual({
      kind: 'git',
      source: 'https://gitlab.example.com/Org/My-Plugin',
      host: 'gitlab.example.com',
      path: 'Org/My-Plugin',
    });
    expect(
      pluginProposalSourceKey('https://gitlab.example.com/Org/My-Plugin'),
    ).not.toBe(
      pluginProposalSourceKey('https://gitlab.example.com/org/my-plugin'),
    );
  });

  test('a source with a leading byte-order mark is refused, not trimmed away', () => {
    try {
      resolvePluginProposalSource('\uFEFF/tmp/plugins/pulse');
      expect.unreachable('a BOM-prefixed source was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginProposalInvalidError);
      expect((error as PluginProposalInvalidError).code).toBe('source-invalid');
    }
  });

  test('the same repository in different spellings is one key', () => {
    const keys = new Set(
      [
        'https://github.com/a/b',
        'https://github.com/a/b/',
        'https://github.com/a/b.git',
        'https://GITHUB.com/a/b',
        'git@github.com:a/b.git',
      ].map(pluginProposalSourceKey),
    );
    expect([...keys]).toEqual(['repo:github.com/a/b']);
    expect(pluginProposalSourceKey('https://github.com/a/c')).not.toBe(
      'repo:github.com/a/b',
    );
  });
});

describe('#2323 S5 review M4: dedupe and caps', () => {
  test('different spellings of one repository from one conversation make one proposal', async () => {
    const { proposals } = service();
    for (const source of [
      'https://github.com/a/b',
      'https://github.com/a/b/',
      'https://github.com/a/b.git',
      'https://GITHUB.com/a/b',
    ]) {
      await proposals.propose({
        kind: 'install',
        source,
        rationale: 'r',
        author: agent('one'),
      });
    }
    expect(proposals.listOpen()).toHaveLength(1);
  });

  test('one engine cannot fill the inbox by varying the conversation id', async () => {
    const { proposals } = service();
    let created = 0;
    let refused = 0;
    for (let index = 0; index < 60; index++) {
      try {
        await proposals.propose({
          kind: 'install',
          source: `https://github.com/a/repo-${index}`,
          rationale: 'r',
          // Self-reported: an external engine writing its own names.
          author: {
            principal: 'agent',
            agentSlug: `agent-${index}`,
            conversationId: `c${index}`,
            reportedBy: 'caller',
          },
        });
        created++;
      } catch (error) {
        expect(error).toBeInstanceOf(PluginProposalLimitError);
        refused++;
      }
    }
    expect(created).toBe(MAX_OPEN_PROPOSALS_PER_ENGINE);
    expect(refused).toBe(60 - MAX_OPEN_PROPOSALS_PER_ENGINE);
    // A runtime-verified agent still has its own allowance.
    await expect(
      proposals.propose({
        kind: 'install',
        source: 'https://github.com/a/verified',
        rationale: 'r',
        author: {
          principal: 'agent',
          agentSlug: 'station',
          conversationId: 'c-verified',
          reportedBy: 'runtime',
        },
      }),
    ).resolves.toMatchObject({ deduplicated: false });
  });

  test('people are counted one by one, not as one shared bucket', async () => {
    const { proposals } = service();
    const person = (principalId: string) => ({
      principal: 'person' as const,
      principalId,
    });
    for (let index = 0; index < MAX_OPEN_PROPOSALS_PER_ENGINE; index++) {
      await proposals.propose({
        kind: 'install',
        source: `https://github.com/p/${index}`,
        rationale: 'r',
        author: person('human:device:alice'),
      });
    }
    await expect(
      proposals.propose({
        kind: 'install',
        source: 'https://github.com/p/over',
        rationale: 'r',
        author: person('human:device:alice'),
      }),
    ).rejects.toBeInstanceOf(PluginProposalLimitError);
    await expect(
      proposals.propose({
        kind: 'install',
        source: 'https://github.com/p/bob',
        rationale: 'r',
        author: person('human:device:bob'),
      }),
    ).resolves.toMatchObject({ deduplicated: false });
  });

  test('precheck deduplicates and refuses without writing', async () => {
    const { proposals, home } = service();
    const input = {
      kind: 'install' as const,
      source: 'https://github.com/a/b',
      rationale: 'r',
      author: agent('c'),
    };
    expect(proposals.precheck(input)).toEqual({ admitted: true });
    expect(() =>
      readFileSync(join(home, PLUGIN_LIFECYCLE_PROPOSALS_FILE), 'utf8'),
    ).toThrow();
    const { proposal } = await proposals.propose(input);
    expect(
      proposals.precheck({ ...input, source: 'https://github.com/a/b.git' }),
    ).toEqual({ existing: proposal });
  });

  test('a rationale with an invisible or direction-changing character is refused', async () => {
    const { proposals } = service();
    for (const rationale of ['Safe‮.exe', 'zero​width', 'bom﻿']) {
      await expect(
        proposals.propose({
          kind: 'update',
          pluginName: 'pulse',
          rationale,
          author: agent('c'),
        }),
      ).rejects.toMatchObject({ code: 'rationale-invalid' });
    }
  });
});
