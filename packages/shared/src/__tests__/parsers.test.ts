import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { copyPluginIntegrations } from '../parsers.js';

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('copyPluginIntegrations', () => {
  test('rejects symlinked integration definitions before annotating plugin ownership', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-parser-plugin-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugin');
    const integrationDir = join(pluginDir, 'integrations', 'evil');
    const projectIntegrationsDir = join(root, 'project-integrations');
    const outside = join(root, 'outside.json');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'evil-plugin', version: '1.0.0' }),
    );
    writeFileSync(outside, JSON.stringify({ safe: true }));
    symlinkSync(outside, join(integrationDir, 'integration.json'));

    expect(() =>
      copyPluginIntegrations(pluginDir, projectIntegrationsDir),
    ).toThrow(/symlink/);
    expect(JSON.parse(readFileSync(outside, 'utf-8'))).toEqual({ safe: true });
  });

  test('rejects a symlinked plugin integrations root', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-parser-plugin-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugin');
    const outsideIntegrations = join(root, 'outside-integrations');
    const integrationDir = join(outsideIntegrations, 'external');
    const projectIntegrationsDir = join(root, 'project-integrations');
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'evil-plugin', version: '1.0.0' }),
    );
    writeFileSync(join(integrationDir, 'integration.json'), '{}');
    symlinkSync(outsideIntegrations, join(pluginDir, 'integrations'));

    expect(() =>
      copyPluginIntegrations(pluginDir, projectIntegrationsDir),
    ).toThrow(/integrations directory is a symlink/);
  });

  test('does not overwrite an existing integration without plugin ownership', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-parser-plugin-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugin');
    const integrationDir = join(pluginDir, 'integrations', 'shared');
    const projectIntegrationsDir = join(root, 'project-integrations');
    const existingDir = join(projectIntegrationsDir, 'shared');
    mkdirSync(integrationDir, { recursive: true });
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'new-plugin', version: '1.0.0' }),
    );
    writeFileSync(
      join(integrationDir, 'integration.json'),
      '{"plugin":"new-plugin"}',
    );
    writeFileSync(join(existingDir, 'integration.json'), '{"userOwned":true}');

    expect(() =>
      copyPluginIntegrations(pluginDir, projectIntegrationsDir),
    ).toThrow(/already exists/);
    expect(
      JSON.parse(readFileSync(join(existingDir, 'integration.json'), 'utf-8')),
    ).toEqual({
      userOwned: true,
    });
  });

  test('rejects malformed integration definitions without leaving an unowned copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-parser-plugin-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugin');
    const integrationDir = join(pluginDir, 'integrations', 'broken');
    const projectIntegrationsDir = join(root, 'project-integrations');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'broken-plugin', version: '1.0.0' }),
    );
    writeFileSync(join(integrationDir, 'integration.json'), '{not json');

    expect(() =>
      copyPluginIntegrations(pluginDir, projectIntegrationsDir),
    ).toThrow(SyntaxError);
    expect(existsSync(join(projectIntegrationsDir, 'broken'))).toBe(false);
  });

  test('rejects integration commands that are not single executable tokens', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-parser-plugin-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugin');
    const integrationDir = join(pluginDir, 'integrations', 'unsafe');
    const projectIntegrationsDir = join(root, 'project-integrations');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'unsafe-command-plugin', version: '1.0.0' }),
    );
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({ command: 'node;touch-marker' }),
    );

    expect(() =>
      copyPluginIntegrations(pluginDir, projectIntegrationsDir),
    ).toThrow(/one executable token/);
    expect(existsSync(join(projectIntegrationsDir, 'unsafe'))).toBe(false);
  });

  test('replaces an existing integration owned by the same plugin', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-parser-plugin-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugin');
    const integrationDir = join(pluginDir, 'integrations', 'owned');
    const projectIntegrationsDir = join(root, 'project-integrations');
    const existingDir = join(projectIntegrationsDir, 'owned');
    mkdirSync(integrationDir, { recursive: true });
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'owned-plugin', version: '1.0.0' }),
    );
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({ command: 'new-command' }),
    );
    writeFileSync(
      join(existingDir, 'integration.json'),
      JSON.stringify({ command: 'old-command', plugin: 'owned-plugin' }),
    );

    expect(copyPluginIntegrations(pluginDir, projectIntegrationsDir)).toEqual([
      'owned',
    ]);
    expect(
      JSON.parse(readFileSync(join(existingDir, 'integration.json'), 'utf-8')),
    ).toEqual({ command: 'new-command', plugin: 'owned-plugin' });
  });

  test('preflights every integration before copying any of them', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-parser-plugin-'));
    cleanupDirs.push(root);
    const pluginDir = join(root, 'plugin');
    const validDir = join(pluginDir, 'integrations', 'valid');
    const brokenDir = join(pluginDir, 'integrations', 'broken');
    const projectIntegrationsDir = join(root, 'project-integrations');
    mkdirSync(validDir, { recursive: true });
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'multi-plugin', version: '1.0.0' }),
    );
    writeFileSync(join(validDir, 'integration.json'), '{}');
    writeFileSync(join(brokenDir, 'integration.json'), '{not json');

    expect(() =>
      copyPluginIntegrations(pluginDir, projectIntegrationsDir),
    ).toThrow(SyntaxError);
    expect(existsSync(join(projectIntegrationsDir, 'valid'))).toBe(false);
    expect(existsSync(join(projectIntegrationsDir, 'broken'))).toBe(false);
  });
});
