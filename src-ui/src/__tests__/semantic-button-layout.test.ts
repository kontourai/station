import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const uiRoot = join(import.meta.dirname, '..');

function rule(source: string, selector: string): string {
  const match = source.match(
    new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`,
    ),
  );
  expect(match, `missing ${selector} rule`).toBeTruthy();
  return match?.[1] ?? '';
}

describe('semantic button layout resets', () => {
  test('keeps the project knowledge dropzone block-level and full-width', () => {
    const css = readFileSync(join(uiRoot, 'views/ProjectPage.css'), 'utf8');
    const declarations = rule(css, '.project-page__dropzone');

    expect(declarations).toContain('display: block');
    expect(declarations).toContain('width: 100%');
    expect(declarations).toContain('box-sizing: border-box');
    expect(declarations).toContain('font: inherit');
  });

  test('neutralizes native button defaults for folder rows', () => {
    const css = readFileSync(
      join(uiRoot, 'views/PluginManagementView.css'),
      'utf8',
    );
    const declarations = rule(css, '.plugins__folder-entry');

    for (const declaration of [
      'width: 100%',
      'border: none',
      'background: transparent',
      'font: inherit',
      'text-align: left',
    ]) {
      expect(declarations).toContain(declaration);
    }
  });
});
