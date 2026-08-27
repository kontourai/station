import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : tsxFiles(absolute);
    }
    return entry.name.endsWith('.tsx') ? [absolute] : [];
  });
}

function isDialogSource(source: string) {
  return (
    source.includes('role="dialog"') ||
    source.includes('<ResponsiveDialogSurface') ||
    source.includes('responsive-surface-panel')
  );
}

function adHocIconCloseButtons(source: string) {
  return Array.from(source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g))
    .filter((match) => {
      const attributes = match[1];
      const content = match[2].trim();
      const closeIntent =
        /aria-label=(?:"[^"]*Close|{`[^`]*Close|{'[^']*Close|{"[^"]*Close)/i.test(
          attributes,
        ) || /className="[^"]*(?:modal|dialog)[^"]*close/i.test(attributes);
      const iconOnly =
        /^(?:×|✕|X|&times;)$/.test(content) ||
        /^<svg\b[\s\S]*<\/svg>$/.test(content);
      return closeIntent && iconOnly;
    })
    .map((match) => match[0]);
}

describe('responsive dialog close-control adoption', () => {
  test('dialog sources do not grow ad hoc icon close buttons', () => {
    const violations = tsxFiles(SOURCE_ROOT).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      if (!isDialogSource(source)) return [];
      return adHocIconCloseButtons(source).map(() =>
        path.relative(SOURCE_ROOT, file),
      );
    });

    expect(violations).toEqual([]);
  });
});
