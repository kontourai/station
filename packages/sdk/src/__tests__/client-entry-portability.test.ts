import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Explicit syntax boundary for the portable client. Resolved bundle checks
 * remain separate; this scanner does not claim arbitrary data-flow analysis. */
const CLIENT_DIR = join(__dirname, '..', 'client');

function listTsFilesRecursively(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listTsFilesRecursively(fullPath));
      continue;
    }
    if (entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function scanSource(contents: string, file: string): string[] {
  const violations: string[] = [];
  const ast = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const report = (label: string) => violations.push(`${file}: ${label}`);
  const checkSpecifier = (specifier: string) => {
    for (const name of ['react', 'react-dom', '@tanstack/react-query']) {
      if (specifier === name || specifier.startsWith(`${name}/`))
        report(`import from '${name}'`);
    }
    if (/\.tsx(?:[?#].*)?$/.test(specifier)) report('import of a .tsx file');
    if (/\.css(?:[?#].*)?$/.test(specifier)) report('import of a .css file');
    const normalized = posix.normalize(specifier.replace(/\\/g, '/'));
    if (normalized.startsWith('../') || posix.isAbsolute(normalized))
      report(
        "relative import reaching outside client/ (only './' siblings are allowed)",
      );
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      checkSpecifier(node.moduleSpecifier.text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      checkSpecifier(node.argument.literal.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      report('dynamic import(...) call');
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    )
      report('require(...) call');
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      report('require(...) call');
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}
function scanForViolations(files: string[]): string[] {
  return files.flatMap((file) => scanSource(readFileSync(file, 'utf8'), file));
}

describe('client-entry portability (#167 AC6)', () => {
  const files = listTsFilesRecursively(CLIENT_DIR);

  it('finds at least one file under packages/sdk/src/client', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it(
    'contains no react/react-dom/@tanstack/react-query/.tsx/.css imports, no ' +
      "'../'-relative imports reaching outside client/, and no dynamic " +
      'import()/require() calls',
    () => {
      const violations = scanForViolations(files);
      expect(violations).toEqual([]);
    },
  );

  it('negative control: the scan actually flags a planted violation (then restores)', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'client-portability-'));
    const fixturePath = join(
      fixtureRoot,
      '__portability-negative-control__.ts',
    );
    writeFileSync(
      fixturePath,
      "import { useSomething } from '../hooks/useSomething';\n" +
        "const lazy = () => import('./http');\n",
    );
    try {
      const violations = scanForViolations([fixturePath]);
      expect(
        violations.some(
          (v) =>
            v.includes('__portability-negative-control__.ts') &&
            v.includes('relative import reaching outside client/'),
        ),
      ).toBe(true);
      expect(
        violations.some(
          (v) =>
            v.includes('__portability-negative-control__.ts') &&
            v.includes('dynamic import(...) call'),
        ),
      ).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

it('accepts harmless comments, prose, and local type queries', () => {
  expect(
    scanSource(
      `// import { x } from 'react';
    const prose = "require('react')";
    type Data = import('./http').Data;`,
      'control.ts',
    ),
  ).toEqual([]);
});
it('catches side-effect imports, re-exports, subpaths, and disguised parent traversal', () => {
  for (const source of [
    "import 'react';",
    "export {x} from 'react/jsx-runtime';",
    "import {x} from './nested/../../hooks/x';",
    "import {x} from 'react-dom/client';",
  ]) {
    expect(scanSource(source, 'bad.ts').length).toBeGreaterThan(0);
  }
});
