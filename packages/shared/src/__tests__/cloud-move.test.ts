import {
  Dir,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { prepareCloudEnvironment, previewCloudMove } from '../cloud-move.js';
import {
  ensureStationHomeSchemaSync,
  STATION_HOME_SCHEMA_FILE,
} from '../station-home-schema.js';

const target = {
  providerId: 'aws-ec2',
  region: 'us-east-1',
  instanceType: 't3.micro',
};
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-cloud-preview-'));
  roots.push(root);
  ensureStationHomeSchemaSync(root);
  const put = (path: string, value: unknown) => {
    const parts = path.split('/');
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  return { root, put };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('cloud move preview', () => {
  test('reads selected actual setup metadata without exporting secrets or changing source files', () => {
    const { root, put } = fixture();
    put('agents/writer/agent.json', {
      name: 'Writer',
      prompt: 'PRIVATE-PROMPT',
      execution: {
        agentConnectionId: 'engine',
        credentialProfileRef: 'PRIVATE-ACCOUNT',
      },
    });
    put('projects/demo/project.json', {
      id: 'project-id',
      slug: 'demo',
      workingDirectory: '/private/workspace',
    });
    put('plugins/example/manifest.json', { secret: 'PRIVATE-PLUGIN' });
    put('credentials/private.json', { apiKey: 'PRIVATE-SECRET' });
    put('data/authority.json', { token: 'PRIVATE-AUTHORITY' });
    const source = readFileSync(join(root, 'agents/writer/agent.json'), 'utf8');
    const result = previewCloudMove({ homeDir: root, target });
    expect(result.items.map((item) => item.kind)).toEqual([
      'agent',
      'project',
      'plugin',
      'credentials',
      'history',
      'execution',
    ]);
    expect(result.transferAvailable).toBe(false);
    expect(result.executionResumeAvailable).toBe(false);
    expect(result.observation).toBe('non-atomic-preview');
    expect(result.warnings.some((warning) => warning.includes('1-GiB'))).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-|private\/workspace/);
    expect(readFileSync(join(root, 'agents/writer/agent.json'), 'utf8')).toBe(
      source,
    );
  });
  test('selects GCP without inheriting AWS provisioning or availability claims', () => {
    const { root } = fixture();
    const gcp = {
      providerId: 'gcp-compute',
      region: 'us-central1',
      instanceType: 'e2-micro',
    };
    const result = previewCloudMove({ homeDir: root, target: gcp });
    expect(result.target).toEqual(gcp);
    expect(result.transferAvailable).toBe(false);
    expect(
      result.warnings.some((warning) => warning.includes('Google credentials')),
    ).toBe(true);
    expect(() =>
      previewCloudMove({
        homeDir: root,
        target: { ...gcp, region: 'us-central1-a' },
      }),
    ).toThrow('region');
    expect(() =>
      previewCloudMove({
        homeDir: root,
        target: { ...gcp, instanceType: 't3.micro' },
      }),
    ).toThrow('machine type');
    expect(() =>
      prepareCloudEnvironment({ target: gcp, image: 'unused' }),
    ).toThrow('does not support environment preparation');
  });
  test('treats tilde-literal and nonexistent workspaces as metadata rather than opening them', () => {
    const { root, put } = fixture();
    for (const workingDirectory of [
      '~/station-preview-workspace-not-inspected',
      join(root, 'missing-workspace'),
    ]) {
      put('projects/demo/project.json', {
        id: 'project-id',
        slug: 'demo',
        workingDirectory,
      });
      const result = previewCloudMove({ homeDir: root, target });
      expect(
        result.items.find((item) => item.kind === 'project'),
      ).toMatchObject({ disposition: 'review-required' });
      expect(JSON.stringify(result)).not.toContain(workingDirectory);
      expect(result.transferAvailable).toBe(false);
    }
  });
  test('rejects unsupported target configuration before inspecting a home', () => {
    expect(() =>
      previewCloudMove({
        homeDir: '/does-not-exist',
        target: { ...target, providerId: 'unknown' },
      }),
    ).toThrow('Unsupported cloud provider');
    const { root } = fixture();
    expect(() =>
      previewCloudMove({
        homeDir: root,
        target: { ...target, region: 'region; command' },
      }),
    ).toThrow('region');
    expect(() =>
      previewCloudMove({
        homeDir: root,
        target: { ...target, instanceType: 'unbounded' },
      }),
    ).toThrow('instance type');
  });
  test('composes a provider explicitly without granting it transfer authority', () => {
    const { root } = fixture();
    const provider = {
      id: 'test-provider',
      validateTarget: () => ['test profile'],
    };
    const result = previewCloudMove({
      homeDir: root,
      target: { ...target, providerId: provider.id },
      providers: [provider],
    });
    expect(result.warnings).toEqual(['test profile']);
    expect(result.transferAvailable).toBe(false);
    expect(() =>
      previewCloudMove({
        homeDir: root,
        target,
        providers: [provider, provider],
      }),
    ).toThrow('Duplicate');
  });
  test('fails on corrupt or oversized selected records instead of reporting an empty setup', () => {
    const { root, put } = fixture();
    put('agents/writer/agent.json', []);
    expect(() => previewCloudMove({ homeDir: root, target })).toThrow(
      'bounded configuration',
    );
    put('agents/writer/agent.json', { prompt: 'x'.repeat(256 * 1024) });
    expect(() => previewCloudMove({ homeDir: root, target })).toThrow(
      'bounded configuration',
    );
  });
  test('does not reset an incompatible home', () => {
    const { root, put } = fixture();
    put(STATION_HOME_SCHEMA_FILE, { schemaVersion: 999 });
    const before = readFileSync(join(root, STATION_HOME_SCHEMA_FILE), 'utf8');
    expect(() => previewCloudMove({ homeDir: root, target })).toThrow(
      'does not migrate or reset',
    );
    expect(readFileSync(join(root, STATION_HOME_SCHEMA_FILE), 'utf8')).toBe(
      before,
    );
  });
  test('stops directory reads at the configured entry bound', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'agents'));
    for (let index = 0; index < 1005; index++)
      mkdirSync(join(root, 'agents', `agent-${index}`));
    const reads = vi.spyOn(Dir.prototype, 'readSync');
    try {
      expect(() => previewCloudMove({ homeDir: root, target })).toThrow(
        'inventory exceeds its bound',
      );
      expect(reads).toHaveBeenCalledTimes(1001);
    } finally {
      reads.mockRestore();
    }
  });
  test('does not interpret managed plugin storage, reserved directories, or compatibility links as active plugins', () => {
    const { root } = fixture();
    const other = fixture();
    mkdirSync(join(root, 'plugins', '.incarnations'), { recursive: true });
    symlinkSync(
      other.root,
      join(root, 'plugins', 'compatibility'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const result = previewCloudMove({ homeDir: root, target });
    expect(result.items.filter((item) => item.kind === 'plugin')).toEqual([
      expect.objectContaining({
        id: 'plugin-inventory',
        disposition: 'review-required',
      }),
    ]);
    expect(
      result.items
        .filter((item) => item.kind === 'plugin')
        .map((item) => item.id),
    ).not.toContain('compatibility');
  });
  test('refuses linked configuration directories', () => {
    const { root } = fixture();
    const other = fixture();
    symlinkSync(
      other.root,
      join(root, 'agents'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => previewCloudMove({ homeDir: root, target })).toThrow(
      'configuration directory',
    );
  });
});
