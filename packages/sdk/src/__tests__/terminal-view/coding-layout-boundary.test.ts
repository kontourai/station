import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Coding layout renders terminals only through the public SDK entry, the
 * same surface a plugin gets (docs/design/terminal.md, "Client runtime").
 */
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const codingLayout = join(root, 'src-ui/src/components/coding-layout');

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

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('Coding layout terminal boundary', () => {
  // UNWIRED(#3994): Coding still renders xterm until the TerminalPanel cutover;
  // `it.fails` turns red the moment the layout is clean, so flip it then.
  it.fails('imports terminal code only through the public SDK entry', () => {
    const violations = sources(codingLayout).flatMap((path) =>
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
