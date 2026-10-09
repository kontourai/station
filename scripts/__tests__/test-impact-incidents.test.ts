/**
 * #3149: pull requests whose fast-checks plan did not run a suite they broke,
 * found first by scheduled qualification. Each case runs the REAL selector
 * (`prepareChangedSelection` over the real manifest and the real tree) on the
 * incident's own changed-path list, recorded from `git diff --name-only
 * <merge>^1 <merge>` in fixtures/test-impact-incidents/changed-paths.json, and
 * asserts the broken suite is selected. Suite paths are spelled out here, not
 * read from the manifest under test.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { prepareChangedSelection } from '../run-changed-verification.mjs';
import { FAST_STATIC_COMMANDS } from '../run-ci-fast.mjs';
import {
  dependencyChangeEdges,
  REPO_SCAN_SUITES,
} from '../test-impact-manifest.mjs';

const root = process.cwd();
const incidents: Record<string, { merge: string; paths: string[] }> =
  JSON.parse(
    readFileSync(
      join(
        root,
        'scripts/__tests__/fixtures/test-impact-incidents/changed-paths.json',
      ),
      'utf8',
    ),
  );

const head = (path: string): string | null => {
  const absolute = join(root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
};

function select(
  paths: readonly string[],
  readBaseFile: (path: string) => string | null = head,
) {
  return prepareChangedSelection('incident', {
    root,
    changedPathsFn: () => ({ mergeBase: 'incident-base', paths: [...paths] }),
    readBaseFile,
  });
}

const selected = (result: ReturnType<typeof select>) =>
  result.selection.tests.map((entry: { path: string }) => entry.path);
const executed = (result: ReturnType<typeof select>) =>
  result.executionSelection.tests.map((entry: { path: string }) => entry.path);

// Every test or lane reason a dependency-change edge contributed.
const dependencyReasons = (result: ReturnType<typeof select>) =>
  [...result.selection.tests, ...result.selection.lanes]
    .flatMap((entry: { reasons: string[] }) => entry.reasons)
    .filter((reason: string) =>
      /dependency .*\(#3149\)|import this changed dependency/.test(reason),
    );

describe('#3200: a sibling dependency bump selects the suites importing it', () => {
  const FLOW_AGENTS = '@kontourai/flow-agents';
  const AGENT_POLICY =
    'src-server/services/agents/__tests__/agent-policy-service.test.ts';
  const BASE_VERSION = '6.4.0';

  // The base side of the bump: the real head files with flow-agents moved back
  // to an older version, so the fixture keeps the exact shape pnpm writes.
  function flowAgentsBase(path: string): string | null {
    const text = head(path);
    if (text === null) return null;
    if (path.endsWith('package.json')) {
      const manifest = JSON.parse(text);
      for (const section of ['dependencies', 'devDependencies'])
        if (manifest[section]?.[FLOW_AGENTS])
          manifest[section][FLOW_AGENTS] = BASE_VERSION;
      return `${JSON.stringify(manifest, null, 2)}\n`;
    }
    if (path === 'pnpm-lock.yaml') {
      const rewritten = text.replace(
        /('@kontourai\/flow-agents':\n\s+specifier: )[^\n]+(\n\s+version: )[^\n]+/g,
        `$1${BASE_VERSION}$2${BASE_VERSION}`,
      );
      expect(rewritten).not.toBe(text);
      return rewritten;
    }
    return text;
  }

  test('the incident diff selects agent-policy-service for the bump', () => {
    const result = select(incidents['3200'].paths, flowAgentsBase);
    const entry = result.selection.tests.find(
      (test: { path: string }) => test.path === AGENT_POLICY,
    );
    expect(entry?.reasons.join('\n')).toContain(FLOW_AGENTS);
    // The incident escalates; explicit tests are what an escalated plan runs.
    expect(
      result.selection.lanes.map((lane: { id: string }) => lane.id),
    ).toContain('ci-fast');
    expect(executed(result)).toContain(AGENT_POLICY);
  });

  test('a lockfile-only bump of a direct dependency selects it too', () => {
    const result = select(['pnpm-lock.yaml'], flowAgentsBase);
    expect(executed(result)).toContain(AGENT_POLICY);
  });

  test('the same paths with no version change select nothing for it', () => {
    const result = select(['package.json', 'pnpm-lock.yaml'], head);
    expect(selected(result)).not.toContain(AGENT_POLICY);
    expect(dependencyReasons(result)).toEqual([]);
  });

  test('third-party and workspace bumps do not select external importers', () => {
    for (const [section, name] of [
      ['devDependencies', 'vitest'],
      ['dependencies', '@kontourai/station-sdk'],
    ]) {
      const result = select(['package.json'], (path) => {
        const manifest = JSON.parse(head(path) as string);
        manifest[section][name] = '0.0.1';
        return JSON.stringify(manifest);
      });
      expect(dependencyReasons(result), name).toEqual([]);
    }
  });
});

describe('#3251: CLI service entry points that compose shared modules', () => {
  const ENTRY_POINTS =
    'packages/cli/src/__tests__/service-dev-home-entry-points.test.ts';

  test('the incident diff runs the entry-point suite despite escalating', () => {
    const result = select(incidents['3251'].paths);
    expect(
      result.selection.lanes.map((lane: { id: string }) => lane.id),
    ).toContain('ci-fast');
    expect(executed(result)).toContain(ENTRY_POINTS);
  });

  test('a shared host-owner claim change alone runs it', () => {
    const result = select(['packages/shared/src/instance-registry.ts']);
    expect(executed(result)).toContain(ENTRY_POINTS);
  });

  test('a service.ts change keeps its import graph, not just the docs check', () => {
    const result = select(['packages/cli/src/commands/service.ts']);
    expect(result.selection.relatedPaths).toContain(
      'packages/cli/src/commands/service.ts',
    );
    expect(selected(result)).toContain(
      'scripts/__tests__/native-recovery-docs.test.ts',
    );
  });
});

describe('#3114: security gates and the native platform boundary', () => {
  const AUTHORITY_OBSERVATION =
    'src-server/routes/system/__tests__/authority-observation.routes.test.ts';

  test('the incident diff selects the runtime security composition suite', () => {
    expect(selected(select(incidents['3114'].paths))).toContain(
      AUTHORITY_OBSERVATION,
    );
  });

  test('an escalated gate change still runs it', () => {
    const result = select([
      'src-server/runtime/bootstrap/account-bound-device-gate.ts',
      'packages/contracts/src/application-session.ts',
    ]);
    expect(executed(result)).toContain(AUTHORITY_OBSERVATION);
    const audience = select([
      'src-server/runtime/bootstrap/agent-audience-gate.ts',
      'packages/contracts/src/application-session.ts',
    ]);
    expect(executed(audience)).toContain(AUTHORITY_OBSERVATION);
    expect(executed(audience)).toContain(
      'src-server/runtime/routes/__tests__/runtime-routes-agent-audience.test.ts',
    );
  });

  test('every runtime bootstrap gate and a request-authority module select it', () => {
    const gates = readdirSync(join(root, 'src-server/runtime/bootstrap'))
      .filter((name) => /gate/.test(name) && /\.ts$/.test(name))
      .map((name) => `src-server/runtime/bootstrap/${name}`);
    expect(gates).toContain(
      'src-server/runtime/bootstrap/account-bound-device-gate.ts',
    );
    for (const path of [
      ...gates,
      'src-server/security/native-device-request-authority.ts',
    ])
      expect(selected(select([path])), path).toContain(AUTHORITY_OBSERVATION);
  });

  test('fast-checks statics run the renderer-wide native platform scan', () => {
    // No path edge can select the scan for every renderer file, so the
    // required statics run it directly.
    expect(FAST_STATIC_COMMANDS).toContainEqual([
      'npm',
      ['run', 'native-platform:ratchet'],
    ]);
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      .scripts as Record<string, string>;
    expect(scripts['native-platform:ratchet']).toBe(
      'node scripts/native-platform-boundary.mjs',
    );
  });
});

describe('#3170: the SDK client portability scan', () => {
  const PORTABILITY =
    'packages/sdk/src/__tests__/client-entry-portability.test.ts';

  test('the incident diff selects it', () => {
    expect(selected(select(incidents['3170'].paths))).toContain(PORTABILITY);
  });

  test('it runs on every pull request as a repository scan', () => {
    // The incident escalated with more than 32 explicit tests, so its plan ran
    // none of them; the repo-scans job runs this suite regardless.
    expect(REPO_SCAN_SUITES).toContain(PORTABILITY);
  });
});

describe('dependency fan-out limit (#3149 review)', () => {
  // A package imported by more suites than the limit defers to the full lane
  // instead of naming them all; at the limit it still names each suite.
  const makeTempDir = trackTempDirs();
  function edgesFor(importers: number) {
    const fixture = makeTempDir('dependency-fanout-');
    const testFiles = Array.from(
      { length: importers },
      (_, index) => `src/__tests__/consumer-${index}.test.ts`,
    );
    mkdirSync(join(fixture, 'src', '__tests__'), { recursive: true });
    for (const file of testFiles)
      writeFileSync(
        join(fixture, file),
        "import { thing } from '@kontourai/fanout-fixture';\n",
      );
    const manifest = (version: string) =>
      JSON.stringify({
        dependencies: { '@kontourai/fanout-fixture': version },
      });
    return dependencyChangeEdges({
      root: fixture,
      paths: ['package.json'],
      readBase: () => manifest('1.0.0'),
      readHead: () => manifest('1.1.0'),
      testFiles,
    });
  }

  test('17 importers defer to test-full rather than naming every suite', () => {
    const [edge] = edgesFor(17);
    expect(edge?.deferredLanes).toEqual(['test-full']);
    expect(edge && 'tests' in edge ? edge.tests : undefined).toBeUndefined();
  });

  test('16 importers are each named', () => {
    const [edge] = edgesFor(16);
    expect(edge?.deferredLanes).toBeUndefined();
    expect(edge && 'tests' in edge ? edge.tests : []).toHaveLength(16);
  });
});
