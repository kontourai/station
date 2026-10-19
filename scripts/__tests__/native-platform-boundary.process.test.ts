import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

/**
 * #3851: the gate as a child process, against a temp desktop root that holds
 * the real default capability plus one way of granting the webview updater
 * or process authority. Each shape is one Tauri really loads.
 */
const tempDir = trackTempDirs();

function desktopRoot(files: Record<string, string>): string {
  const root = tempDir('station-native-boundary-');
  mkdirSync(join(root, 'capabilities'));
  copyFileSync(
    'src-desktop/capabilities/default.json',
    join(root, 'capabilities/default.json'),
  );
  copyFileSync('src-desktop/tauri.conf.json', join(root, 'tauri.conf.json'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function gate(root: string) {
  const result = spawnSync(
    process.execPath,
    ['scripts/native-platform-boundary.mjs', '--desktop-root', root],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

const capability = (permission: unknown) => ({
  identifier: 'extra',
  windows: ['main'],
  permissions: [permission],
});

const BYPASSES: Record<string, Record<string, string>> = {
  'a JSON array of capabilities': {
    'capabilities/list.json': JSON.stringify([
      capability('updater:allow-check'),
    ]),
  },
  'a { capabilities: [...] } file': {
    'capabilities/named.json': JSON.stringify({
      capabilities: [capability('process:allow-restart')],
    }),
  },
  'a capability in a subdirectory': {
    'capabilities/extra/x.json': JSON.stringify(
      capability('updater:allow-download-and-install'),
    ),
  },
  'an object-form permission': {
    'capabilities/object.json': JSON.stringify(
      capability({ identifier: 'process:allow-restart' }),
    ),
  },
  'an inline capability in a platform overlay config': {
    'tauri.macos.conf.json': JSON.stringify({
      app: {
        security: {
          capabilities: ['default', capability('updater:allow-check')],
        },
      },
    }),
  },
  'a custom permission set bundling updater': {
    'permissions/everything.json': JSON.stringify({
      set: [
        {
          identifier: 'everything',
          permissions: ['core:default', 'updater:allow-check'],
        },
      ],
    }),
  },
  'a benign TOML capability (any non-JSON file)': {
    'capabilities/x.toml':
      'identifier = "extra"\nwindows = ["main"]\npermissions = ["core:default"]\n',
  },
  'a benign JSON5 capability (any non-JSON file)': {
    'capabilities/x.json5':
      "{ identifier: 'extra', windows: ['main'], permissions: ['core:default'] }",
  },
  'a TOML permission file': {
    'permissions/sets.toml':
      '[[set]]\nidentifier = "x"\npermissions = ["core:default"]\n',
  },
  'the retired desktop-updater manifest, even empty': {
    'capabilities/desktop-updater.json': JSON.stringify({
      identifier: 'desktop-updater',
      permissions: [],
    }),
  },
};

describe('native platform boundary gate (#3851)', () => {
  test('passes a clean desktop root', () => {
    const result = gate(desktopRoot({}));
    expect(result.output).toContain('OK: native access remains');
    expect(result.status).toBe(0);
  });

  test.each(Object.entries(BYPASSES))('refuses %s', (_name, files) => {
    const result = gate(desktopRoot(files));
    expect(result.output).toContain('FAIL: native platform boundary');
    expect(result.output).toMatch(
      /grants (?:updater|process):|must not exist|must be JSON/,
    );
    expect(result.status).toBe(1);
  });
});
