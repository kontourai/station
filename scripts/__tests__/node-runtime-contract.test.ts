import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_NODE_MAJOR as SHARED_SUPPORTED_NODE_MAJOR,
  SUPPORTED_NODE_RANGE as SHARED_SUPPORTED_NODE_RANGE,
} from '../../packages/shared/src/node-runtime.js';
import {
  assertManifestContract,
  assertSupportedNode,
  nodeMajor,
  nodeRuntimeError,
  SUPPORTED_NODE_MAJOR,
  SUPPORTED_NODE_RANGE,
} from '../node-runtime-contract.mjs';

describe('Node runtime contract', () => {
  it('accepts Node 24 releases and rejects adjacent majors actionably', () => {
    expect(nodeMajor('v24.18.0')).toBe(24);
    expect(() => assertSupportedNode('v24.0.0')).not.toThrow();
    expect(() => assertSupportedNode('v22.23.1')).toThrow(
      nodeRuntimeError('v22.23.1'),
    );
    expect(() => assertSupportedNode('v26.2.0')).toThrow(
      nodeRuntimeError('v26.2.0'),
    );
  });

  it('keeps the manifest, nvm, Docker, build, CI, and docs declarations aligned', () => {
    expect(SUPPORTED_NODE_MAJOR).toBe(24);
    expect(SUPPORTED_NODE_RANGE).toBe('24.x');
    expect(SHARED_SUPPORTED_NODE_MAJOR).toBe(SUPPORTED_NODE_MAJOR);
    expect(SHARED_SUPPORTED_NODE_RANGE).toBe(SUPPORTED_NODE_RANGE);
    expect(() => assertManifestContract()).not.toThrow();
    expect(
      JSON.parse(readFileSync('packages/cli/package.json', 'utf8')).engines
        .node,
    ).toBe(SUPPORTED_NODE_RANGE);
    expect(
      JSON.parse(readFileSync('packages/shared/package.json', 'utf8')).engines
        .node,
    ).toBe(SUPPORTED_NODE_RANGE);
    expect(readFileSync('.nvmrc', 'utf8').trim()).toBe('24');
    expect(readFileSync('Dockerfile', 'utf8')).toMatch(/^FROM node:24-slim/gm);
    expect(readFileSync('esbuild.config.mjs', 'utf8')).toContain(
      "target: 'node24'",
    );
    expect(readFileSync('scripts/run-verification.mjs', 'utf8')).toContain(
      'assertSupportedNode();',
    );
    expect(readFileSync('README.md', 'utf8')).toContain('Node.js 24.x');
    expect(readFileSync('docs/user/getting-started.md', 'utf8')).toContain(
      'Node.js 24.x',
    );

    // brian-media deployment is external-host authority, not Station source.
    expect(existsSync('deploy/brian-media')).toBe(false);

    for (const workflow of [
      '.github/workflows/ci.yml',
      '.github/workflows/ci-extended.yml',
      '.github/workflows/android-test.yml',
      '.github/workflows/windows-verification.yml',
      '.github/workflows/build-android.yml',
      '.github/workflows/pages.yml',
      '.github/workflows/publish-packages.yml',
      '.github/workflows/release.yml',
    ]) {
      expect(readFileSync(workflow, 'utf8'), workflow).toContain(
        'node-version-file: .nvmrc',
      );
      expect(readFileSync(workflow, 'utf8'), workflow).not.toMatch(
        /node-version:\s*\d+/,
      );
    }
  });
});
