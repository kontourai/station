import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript-api';
import { describe, expect, it } from 'vitest';
import { PROVIDER_FAILURE_KINDS } from '../../packages/contracts/src/provider-failure.js';

const root = resolve(import.meta.dirname, '../..');
const exclusions = {
  'src-server/security/coding-authority.ts:WORKING_DIRECTORY_NOT_GRANTED_CODE':
    [
      'working-directory-not-granted',
      'Caller directory authority, before engine admission.',
    ],
  'src-server/security/coding-authority.ts:COMMAND_NOT_GRANTED_CODE': [
    'command-not-granted',
    'Caller command authority, before engine admission.',
  ],
  'src-server/services/flow/unreachable-gate-diagnostic.ts:UNREACHABLE_GATE_CLAIMS_CODE':
    [
      'flow.unreachable-gate-claims',
      'Flow evidence-governance warning, not provider execution.',
    ],
  'src-server/services/orchestration/dispatch-cwd-admission.ts:MOVED_CODE': [
    'station_control_out_of_scope',
    'Caller workspace containment authority.',
  ],
  'src-server/routes/chat/agent-conversation-title.ts:AGENT_TITLE_PERSON_TITLE_CODE':
    ['person_title', 'Preserve a person-authored title; no engine failure.'],
  'src-server/routes/chat/agent-conversation-title.ts:AGENT_TITLE_RUNTIME_UNSUPPORTED_CODE':
    [
      'runtime_title_unsupported',
      'Optional title capability; no failed turn or start.',
    ],
} as const;

// These reconstruct legacy observations or pass a predicate input; neither publishes an event.
const readerObjects = new Set([
  'src-server/services/connections/runtime-auth-health-monitor.ts:monitoredRuntimeEventFrom',
  'src-server/tools/station-control-delegation.ts:isDelegationTerminalEvent',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === '__test-utils__')
      return [];
    const path = resolve(dir, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.tsx?$/.test(path) && !/\.(test|spec)\.tsx?$/.test(path)
        ? [path]
        : [];
  });
}

function enclosingFunction(node: ts.Node, source: ts.SourceFile): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent))
      return parent.name?.getText(source) ?? '<anonymous>';
  }
  return '<module>';
}

const sources = ['packages/contracts/src', 'src-server']
  .flatMap((dir) => sourceFiles(resolve(root, dir)))
  .map((path) =>
    ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    ),
  );

describe('provider failure source boundaries', () => {
  it('maps every string diagnostic constant in contracts and the server, including new files', () => {
    const seenExclusions = new Set<string>();
    let count = 0;
    const unmapped: string[] = [];
    for (const source of sources) {
      const path = relative(root, source.fileName).split(sep).join('/');
      const visit = (node: ts.Node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          /_CODE$/.test(node.name.text)
        ) {
          let value = node.initializer;
          while (
            value &&
            (ts.isAsExpression(value) ||
              ts.isSatisfiesExpression(value) ||
              ts.isParenthesizedExpression(value))
          )
            value = value.expression;
          if (value && ts.isStringLiteralLike(value)) {
            count++;
            const id = `${path}:${node.name.text}`;
            const excluded = (
              exclusions as Readonly<Record<string, readonly string[]>>
            )[id];
            if (excluded) {
              expect(value.text, id).toBe(excluded[0]);
              seenExclusions.add(id);
            } else {
              if (!Object.hasOwn(PROVIDER_FAILURE_KINDS, value.text))
                unmapped.push(
                  `${id} (${value.text}) has no failure-kind mapping`,
                );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(unmapped).toEqual([]);
    expect(count).toBeGreaterThan(0);
    expect([...seenExclusions].sort()).toEqual(Object.keys(exclusions).sort());
  });

  it('requires an explicit strict write type at every server runtime.error construction', () => {
    const seenReaders = new Map<string, number>();
    let writers = 0;
    for (const source of sources.filter((source) =>
      source.fileName.startsWith(resolve(root, 'src-server')),
    )) {
      const visit = (node: ts.Node) => {
        if (
          ts.isObjectLiteralExpression(node) &&
          node.properties.some(
            (prop) =>
              ts.isPropertyAssignment(prop) &&
              prop.name.getText(source) === 'method' &&
              ts.isStringLiteralLike(prop.initializer) &&
              prop.initializer.text === 'runtime.error',
          )
        ) {
          const id = `${relative(root, source.fileName).split(sep).join('/')}:${enclosingFunction(node, source)}`;
          if (readerObjects.has(id))
            seenReaders.set(id, (seenReaders.get(id) ?? 0) + 1);
          else {
            writers++;
            expect(
              ts.isSatisfiesExpression(node.parent)
                ? node.parent.type.getText(source)
                : '',
              `${id} must satisfy the strict runtime-error write type`,
            ).toMatch(/^ProviderRuntimeError(Event|Body)$/);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(writers).toBeGreaterThan(0);
    expect([...seenReaders].sort()).toEqual(
      [...readerObjects].sort().map((id) => [id, 1]),
    );
  });

  it('rejects omitted metadata in the real writer type while allowing legacy readers', () => {
    const file = resolve(root, '__provider_failure_type_probe__.ts')
      .split(sep)
      .join('/');
    const base =
      "{ eventId:'e', provider:'codex', threadId:'t', createdAt:'2026-10-18T00:00:00Z', method:'runtime.error', severity:'error', message:'failed' }";
    const text = `import type { CanonicalRuntimeEvent, ProviderRuntimeEvent } from './packages/contracts/src/runtime-events';
const reader: CanonicalRuntimeEvent = ${base};
const writer: ProviderRuntimeEvent = ${base};
const complete: ProviderRuntimeEvent = { ...${base}, method: 'runtime.error', severity:'error', kind:'auth', retryable:false, failurePhase:'failed' };`;
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    const getSource = host.getSourceFile.bind(host);
    host.getSourceFile = (name, language, onError, shouldCreate) =>
      name === file
        ? ts.createSourceFile(file, text, language, true)
        : getSource(name, language, onError, shouldCreate);
    const program = ts.createProgram([file], options, host);
    const source = program.getSourceFile(file);
    expect(source).toBeDefined();
    const diagnostics = program.getSemanticDiagnostics(source);
    expect(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ),
    ).toHaveLength(1);
    const message = ts.flattenDiagnosticMessageText(
      diagnostics[0].messageText,
      '\n',
    );
    expect(message).toContain('kind');
    expect(message).toContain('retryable');
    expect(message).toContain('failurePhase');
  });
});
