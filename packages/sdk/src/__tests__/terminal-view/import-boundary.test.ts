import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Coding layout renders terminals only through the public SDK entry, the
 * same surface a plugin gets (docs/design/terminal.md, "Client runtime").
 */
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const codingLayout = join(root, 'src-ui/src/components/coding-layout');
/** Station's own renderer for a terminal a plugin opened (related panes). */
const terminalSessionPane = join(
  root,
  'src-ui/src/workspace-panes/TerminalSessionPane.tsx',
);
/** The sample plugin that opens a terminal through related panes. */
const terminalSample = join(root, 'examples/related-terminal');

const PUBLIC_ENTRY = '@kontourai/station-sdk/terminal-view';
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

/** Terminal-internal specifiers a Coding file imported, if any. */
function terminalBoundaryViolations(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? '';
    if (specifier === PUBLIC_ENTRY) continue;
    if (
      specifier.startsWith('@xterm/') ||
      /station-sdk\/(?:src\/)?terminal-view\//.test(specifier) ||
      /packages\/sdk\/src\/terminal-view/.test(specifier) ||
      /(?:^|\/)terminal-view\/(?:engine|render|input|a11y|vendor|controller)/.test(
        specifier,
      )
    )
      out.push(specifier);
  }
  return out;
}

/** The SDK entry points a plugin may import: the package's published exports. */
const sdkEntries = new Set(
  Object.keys(
    JSON.parse(readFileSync(join(root, 'packages/sdk/package.json'), 'utf8'))
      .exports as Record<string, unknown>,
  ).map((key) =>
    key === '.'
      ? '@kontourai/station-sdk'
      : `@kontourai/station-sdk/${key.slice(2)}`,
  ),
);

/**
 * What a plugin source imported other than the public SDK, React, or a
 * module of its own: Station internals, contracts, another package, or a
 * relative path that leaves the plugin.
 */
function pluginBoundaryViolations(
  source: string,
  file: string,
  pluginRoot: string,
): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? '';
    if (sdkEntries.has(specifier)) continue;
    if (specifier === 'react' || specifier.startsWith('react/')) continue;
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier);
      if (!relative(pluginRoot, target).startsWith('..')) continue;
    }
    out.push(specifier);
  }
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('Coding layout terminal boundary', () => {
  it('imports terminal code only through the public SDK entry', () => {
    const violations = [...sources(codingLayout), terminalSessionPane].flatMap(
      (path) =>
        terminalBoundaryViolations(readFileSync(path, 'utf8')).map(
          (specifier) => `${relative(root, path)}: ${specifier}`,
        ),
    );
    expect(violations).toEqual([]);
  });

  it('catches internal and legacy terminal imports', () => {
    expect(
      terminalBoundaryViolations(`
        import { Terminal } from '@xterm/xterm';
        import { TerminalEngine } from '@kontourai/station-sdk/terminal-view/engine/terminal-engine';
        import x from '../../../../packages/sdk/src/terminal-view/render/screen-model';
        const lazy = import('@kontourai/station-sdk/src/terminal-view/controller');
        import '@xterm/xterm/css/xterm.css';
      `),
    ).toHaveLength(5);
  });

  it('allows the public entry and unrelated modules', () => {
    expect(
      terminalBoundaryViolations(`
        import { TerminalView } from '@kontourai/station-sdk/terminal-view';
        import { useApiBase } from '../../contexts/ApiBaseContext';
        import { terminalSelectionHandoff } from './terminalSelectionHandoff';
      `),
    ).toEqual([]);
  });
});

describe('a plugin that opens a terminal', () => {
  it('imports only the public SDK, React and its own modules', () => {
    const files = sources(join(terminalSample, 'src'));
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((path) =>
      pluginBoundaryViolations(
        readFileSync(path, 'utf8'),
        path,
        terminalSample,
      ).map((specifier) => `${relative(root, path)}: ${specifier}`),
    );
    expect(violations).toEqual([]);
  });

  it('catches Station internals, contracts and SDK internals', () => {
    const file = join(terminalSample, 'src/index.tsx');
    expect(
      pluginBoundaryViolations(
        `
        import { useTerminalSessionStore } from '../../../src-ui/src/components/coding-layout/terminalSessionStore';
        import { decodeRelatedTerminalOpenRequest } from '@kontourai/station-contracts/workspace-pane-host-contract';
        import { TerminalEngine } from '@kontourai/station-sdk/terminal-view/engine/terminal-engine';
        import x from '@kontourai/station-sdk/src/related-panes';
        const lazy = import('../../related-reports/src/index');
      `,
        file,
        terminalSample,
      ),
    ).toHaveLength(5);
  });

  it('allows the public SDK, its published subpaths, React and its own files', () => {
    expect(sdkEntries.has('@kontourai/station-sdk/terminal-view')).toBe(true);
    expect(
      pluginBoundaryViolations(
        `
        import { useRelatedPanes } from '@kontourai/station-sdk';
        import { TerminalView } from '@kontourai/station-sdk/terminal-view';
        import { useState } from 'react';
        import { jsx } from 'react/jsx-runtime';
        import './launcher.css';
      `,
        join(terminalSample, 'src/index.tsx'),
        terminalSample,
      ),
    ).toEqual([]);
  });
});
