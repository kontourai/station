import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  EXEMPT_CATEGORIES,
  MANIFEST_PATH,
  missingGrowth,
  validateManifest,
} from '../cli-mcp-parity.mjs';

type Entry = Record<string, unknown>;
type Manifest = Record<'app' | 'cli' | 'tools', Record<string, Entry>>;

const makeTempDir = trackTempDirs();
const realManifest = (): Manifest =>
  JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const sorted = (section: Record<string, Entry>) =>
  Object.fromEntries(
    Object.keys(section)
      .sort()
      .map((key) => [key, section[key]]),
  );

/** The real entry point, as the gate lanes run it, on a fixture manifest. */
function runGate(manifest: Manifest | null, args: string[] = []) {
  const extra: string[] = [];
  if (manifest) {
    const path = join(makeTempDir('cli-mcp-parity-'), 'manifest.json');
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    extra.push(`--manifest=${path}`);
  }
  const result = spawnSync(
    process.execPath,
    ['scripts/cli-mcp-parity.mjs', ...extra, ...args],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** A tool whose entry names a CLI counterpart, to reclassify in fixtures. */
function counterpartTool(manifest: Manifest) {
  const name = Object.keys(manifest.tools).find(
    (tool) => 'cli' in manifest.tools[tool],
  );
  if (!name) throw new Error('fixture needs a tool with a CLI counterpart');
  return name;
}

describe('cli-mcp parity entry point', () => {
  it('passes on the checked-in manifest against its merge base', () => {
    const { status, output } = runGate(null);
    expect(output).toContain('CLI ↔ Station Control parity passed');
    expect(status).toBe(0);
    // Non-vacuous: both registries are loaded, not empty matches.
    expect(output).toMatch(/: 1\d\d tools and 2\d\d CLI actions classified/);
  });

  it('fails an unclassified tool', () => {
    const manifest = realManifest();
    delete manifest.tools.list_agents;
    const { status, output } = runGate(manifest, ['--base=HEAD']);
    expect(output).toContain('tools "list_agents" is unclassified');
    expect(status).toBe(1);
  });

  it('fails an unclassified CLI action', () => {
    const manifest = realManifest();
    delete manifest.cli['agents list'];
    const { status, output } = runGate(manifest, ['--base=HEAD']);
    expect(output).toContain('cli "agents list" is unclassified');
    expect(status).toBe(1);
  });

  it('fails a stale entry for something that no longer exists', () => {
    const manifest = realManifest();
    manifest.cli = sorted({
      ...manifest.cli,
      'agents retired': { exempt: 'local-host', reason: 'Gone.' },
    });
    manifest.tools = sorted({
      ...manifest.tools,
      retired_tool: { cli: ['agents list'] },
    });
    const { status, output } = runGate(manifest, ['--base=HEAD']);
    expect(output).toContain('cli "agents retired" is stale');
    expect(output).toContain('tools "retired_tool" is stale');
    expect(status).toBe(1);
  });

  it('fails a counterpart that does not exist, on either side', () => {
    const manifest = realManifest();
    manifest.tools.list_agents = { cli: ['agents enumerate'] };
    manifest.cli['agents list'] = { tools: ['enumerate_agents'] };
    const { status, output } = runGate(manifest, ['--base=HEAD']);
    expect(output).toContain(
      'counterpart CLI action "agents enumerate" does not exist',
    );
    expect(output).toContain(
      'counterpart Station Control tool "enumerate_agents" does not exist',
    );
    expect(status).toBe(1);
  });

  it('fails a missing entry without a tracking issue number', () => {
    const manifest = realManifest();
    const name = Object.keys(manifest.tools).find(
      (tool) => 'missing' in manifest.tools[tool],
    ) as string;
    manifest.tools[name] = { missing: true, want: 'something' };
    const { status, output } = runGate(manifest, ['--base=HEAD']);
    expect(output).toContain(
      `tools "${name}": "missing" must be the tracking issue number`,
    );
    expect(status).toBe(1);
  });

  it('fails growth of the missing set relative to the base', () => {
    const manifest = realManifest();
    const name = counterpartTool(manifest);
    manifest.tools[name] = { missing: 4282 };
    // HEAD carries the checked-in manifest, where this tool has a
    // counterpart; the output assertion fails if no base was read.
    const { status, output } = runGate(manifest, ['--base=HEAD']);
    expect(output).toContain(
      `tools "${name}" is newly classified missing (not missing at HEAD)`,
    );
    expect(status).toBe(1);
  });

  it('fails an exemption outside the closed categories, or with no reason', () => {
    const manifest = realManifest();
    manifest.cli.start = { exempt: 'convenient' } as Entry;
    const { status, output } = runGate(manifest, ['--base=HEAD']);
    expect(output).toContain('exempt category "convenient" is not one of');
    expect(output).toContain('cli "start": an exemption needs a one-line');
    expect(status).toBe(1);
  });

  it('fails unsorted section keys', () => {
    const manifest = realManifest();
    const names = Object.keys(manifest.tools);
    const [first, ...rest] = names;
    manifest.tools = Object.fromEntries(
      [...rest, first].map((key) => [key, manifest.tools[key]]),
    );
    const { status, output } = runGate(manifest, ['--base=HEAD']);
    expect(output).toContain('section "tools" keys must be sorted');
    expect(status).toBe(1);
  });

  it('fails when the ratchet base cannot be resolved, instead of skipping it', () => {
    const { status, output } = runGate(null, [
      '--base=refs/heads/no-such-ratchet-base',
    ]);
    expect(output).toContain('cannot resolve the ratchet base');
    expect(status).toBe(1);
  });
});

describe('cli-mcp parity rules', () => {
  const surfaces = {
    tools: ['fork_conversation', 'list_agents'],
    cli: ['agents list', 'conversation fork'],
    verbs: ['agents', 'conversation', 'delegate'],
  };
  const base = (): Manifest => ({
    app: {},
    cli: {
      'agents list': { tools: ['list_agents'] },
      'conversation fork': { tools: ['fork_conversation'] },
    },
    tools: {
      fork_conversation: { cli: ['conversation fork'] },
      // A bare verb is a valid CLI counterpart.
      list_agents: { cli: ['delegate'] },
    },
  });

  it('accepts a complete fixture, and pins the exemption vocabulary', () => {
    expect(validateManifest(base(), surfaces)).toEqual([]);
    expect(EXEMPT_CATEGORIES).toContain('person-only');
  });

  it('classifies an app capability: both counterparts, or missing with a partial one', () => {
    const route = 'POST /agents/:slug/conversations/:conversationId/fork';
    const manifest = base();
    manifest.app = {
      'covered fork': {
        route,
        cli: ['conversation fork'],
        tools: ['fork_conversation'],
      },
      'half fork': { route, cli: ['conversation fork'], missing: 4281 },
      'one-sided fork': { route, cli: ['conversation fork'] },
      'unrouted fork': { route: '/fork', missing: 4281 },
    };
    expect(validateManifest(manifest, surfaces)).toEqual([
      'app "one-sided fork": classify it as a counterpart ("cli" and "tools"), "exempt" with a "reason", or "missing" with a tracking issue number.',
      'app "unrouted fork": "route" must read "<METHOD> /path".',
    ]);
  });

  it('rejects a double classification and an unknown field', () => {
    const manifest = base();
    manifest.tools.list_agents = {
      cli: ['agents list'],
      missing: 4286,
      owner: 'x',
    };
    expect(validateManifest(manifest, surfaces)).toEqual([
      'tools "list_agents": unknown field "owner".',
      'tools "list_agents": has more than one classification (missing, counterpart).',
    ]);
  });

  it('ratchets by name, so a renamed gap counts as growth and a closed one does not', () => {
    const before = base();
    before.cli['agents list'] = { missing: 4286 };
    const after = base();
    after.cli['conversation fork'] = { missing: 4281 };
    expect(missingGrowth(after, before)).toEqual(['cli "conversation fork"']);
    expect(missingGrowth(base(), before)).toEqual([]);
    // The change that introduces the manifest has no base to grow from.
    expect(missingGrowth(after, null)).toEqual([]);
  });
});
