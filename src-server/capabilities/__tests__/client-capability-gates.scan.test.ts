/**
 * A repo scan (REPO_SCAN_SUITES): every handshake flag a client in
 * packages/sdk or src-ui gates on must have a row in
 * consumed-capability-flags.test.ts, which pins the flag to what its route
 * serves in personal and hosted mode (#4177).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-api';
import { describe, expect, test } from 'vitest';
import { STATION_CAPABILITY_FLAGS } from '../station-capability-flags.js';
import { TABLED_CAPABILITY_FLAGS } from './consumed-capability-flag-names.js';

// Anchored to this file so the path-read pin scanner can resolve them.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLIENT_ROOTS = [
  fileURLToPath(new URL('../../../packages/sdk/src/', import.meta.url)),
  fileURLToPath(new URL('../../../src-ui/src/', import.meta.url)),
];

function clientSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...clientSourceFiles(path));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

const FLAG_NAMES = new Set(Object.keys(STATION_CAPABILITY_FLAGS));

type Gate = {
  file: string;
  /** The gated flag, or `null` when this scan cannot tell which flag. */
  flag: string | null;
  form: 'call' | 'alias' | 'direct-read';
};

/** `x.capabilities` / `x?.capabilities`, or a bare `capabilities` binding. */
function isCapabilitiesObject(node: ts.Expression): boolean {
  const inner = ts.isNonNullExpression(node) ? node.expression : node;
  if (ts.isIdentifier(inner)) return inner.text === 'capabilities';
  return (
    ts.isPropertyAccessExpression(inner) && inner.name.text === 'capabilities'
  );
}

/**
 * Every client gate on a handshake flag in the given files, found
 * syntactically:
 * - a `hasCapability(...)` call, including through a renamed import
 *   (`import { hasCapability as gate }`) or a member call
 *   (`sdk.hasCapability(...)`);
 * - any other use of `hasCapability` as a value (`const has = hasCapability`,
 *   passing it as an argument, re-exporting it renamed), reported with
 *   `flag: null` because the scan cannot follow the alias;
 * - a direct read of a registry flag on a `capabilities` object
 *   (`h?.capabilities?.webPushNotifications`, `capabilities['x']`, or
 *   destructuring a flag from `.capabilities`).
 * A hasCapability flag argument that is not a string literal is `flag: null`.
 * Not caught: a capabilities read through a dynamic key, or through a
 * variable that is not itself named `capabilities`.
 */
function gatedFlagsIn(
  sources: ReadonlyArray<{ file: string; text: string }>,
): Gate[] {
  const found: Gate[] = [];
  for (const { file, text } of sources) {
    if (!text.includes('hasCapability') && !text.includes('capabilities'))
      continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const at = relative(REPO_ROOT, file);
    const gateNames = new Set(['hasCapability']);
    for (const statement of source.statements) {
      const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : undefined;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          if ((element.propertyName ?? element.name).text === 'hasCapability')
            gateNames.add(element.name.text);
    }
    const literalFlag = (node: ts.Node | undefined) =>
      node && ts.isStringLiteralLike(node) ? node.text : null;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          (ts.isIdentifier(callee) && gateNames.has(callee.text)) ||
          (ts.isPropertyAccessExpression(callee) &&
            callee.name.text === 'hasCapability')
        ) {
          found.push({
            file: at,
            flag: literalFlag(node.arguments[1]),
            form: 'call',
          });
          // Arguments may hold further gates; the callee itself is accounted.
          for (const argument of node.arguments) visit(argument);
          if (ts.isPropertyAccessExpression(callee)) visit(callee.expression);
          return;
        }
      }
      if (ts.isIdentifier(node) && gateNames.has(node.text)) {
        const parent = node.parent;
        // A name in a declaration position (an unrelated interface or class
        // member, object key, parameter or local) is not a use of the gate.
        const namesADeclaration =
          (ts.isFunctionDeclaration(parent) ||
            ts.isMethodSignature(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isVariableDeclaration(parent) ||
            ts.isBindingElement(parent)) &&
          parent.name === node;
        const declaresOrImports =
          ts.isImportSpecifier(parent) ||
          namesADeclaration ||
          // `x.hasCapability` is judged by the member-access branch below.
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isExportSpecifier(parent) &&
            !parent.propertyName &&
            parent.name.text === 'hasCapability') ||
          // A type position (`typeof hasCapability`) gates nothing.
          ts.isTypeQueryNode(parent);
        if (!declaresOrImports)
          found.push({ file: at, flag: null, form: 'alias' });
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'hasCapability' &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      )
        found.push({ file: at, flag: null, form: 'alias' });
      if (
        ts.isPropertyAccessExpression(node) &&
        FLAG_NAMES.has(node.name.text) &&
        isCapabilitiesObject(node.expression)
      )
        found.push({ file: at, flag: node.name.text, form: 'direct-read' });
      if (
        ts.isElementAccessExpression(node) &&
        isCapabilitiesObject(node.expression)
      ) {
        // Only a literal key is attributable. A dynamic key is not reported:
        // engine, voice and native-shell objects also expose `capabilities`
        // maps read by variable, and hasCapability itself reads `[name]`.
        const key = literalFlag(node.argumentExpression);
        if (key !== null && FLAG_NAMES.has(key))
          found.push({ file: at, flag: key, form: 'direct-read' });
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isCapabilitiesObject(node.initializer)
      )
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          const name =
            ts.isIdentifier(key) || ts.isStringLiteralLike(key)
              ? key.text
              : null;
          if (name !== null && FLAG_NAMES.has(name))
            found.push({ file: at, flag: name, form: 'direct-read' });
        }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('every flag a client gates on has a flag-table row', () => {
  test('gates in packages/sdk and src-ui name only tabled flags', () => {
    const gates = gatedFlagsIn(
      CLIENT_ROOTS.flatMap(clientSourceFiles).map((file) => ({
        file,
        text: readFileSync(file, 'utf8'),
      })),
    );
    // Proves the scan reaches the real gates rather than passing on nothing.
    expect(gates.map((gate) => gate.flag)).toContain(
      'sessionInventoryInputRead',
    );
    const untabled = gates.filter(
      (gate) =>
        gate.flag === null || !TABLED_CAPABILITY_FLAGS.includes(gate.flag),
    );
    expect(
      untabled,
      'A client gates on a handshake flag that has no row in CONSUMED_FLAGS ' +
        '(src-server/capabilities/__tests__/consumed-capability-flags.test.ts). ' +
        "Add a row (and an EXPECTED entry) that probes the flag's route in " +
        'personal and hosted mode, then add the flag to TABLED_CAPABILITY_FLAGS ' +
        '(consumed-capability-flag-names.ts). A flag of null means the gate is aliased, ' +
        'or names its flag dynamically: call hasCapability(handshake, ' +
        "'<flag>') directly with a literal. A member call such as " +
        "engine.hasCapability('mic') is reported too, since this syntactic " +
        'scan cannot tell an unrelated method of the same name from the SDK ' +
        'gate: rename that method.',
    ).toEqual([]);
  });

  test('the scan follows every gate form and ignores comments, strings and unrelated capabilities', () => {
    const text = [
      "import * as sdk from './capability.js';",
      "import { hasCapability, hasCapability as gate } from './capability.js';",
      "export { hasCapability } from './capability.js';",
      "// hasCapability(handshake, 'commentFlag')",
      'const text = "hasCapability(handshake, \'stringFlag\')";',
      "hasCapability(handshake, 'sshEnvironments');",
      'hasCapability(handshake, dynamicName);',
      "sdk.hasCapability(handshake, 'scopedPairing');",
      "gate(handshake, 'fleetInference');",
      'const has = hasCapability;',
      'type Gate = typeof hasCapability;',
      'const ok = handshake?.capabilities?.webPushNotifications === true;',
      "const viaKey = handshake.capabilities['executionPreparation'];",
      'const { delegatedInputAnswers } = handshake.capabilities;',
      'const unrelated = compatibility.capabilities.clientProtocolHeader;',
      'interface VoiceEngine { hasCapability(name: string): boolean }',
      'class Engine { hasCapability(name: string) { return !!name; } }',
      'const literal = { hasCapability: () => true };',
      "engine.hasCapability('mic');",
      'const ref = engine.hasCapability;',
    ].join('\n');
    expect(
      gatedFlagsIn([{ file: '/in-memory/client.ts', text }]).map(
        ({ flag, form }) => `${form}:${flag}`,
      ),
    ).toEqual([
      'call:sshEnvironments',
      'call:null',
      'call:scopedPairing',
      'call:fleetInference',
      'alias:null',
      'direct-read:webPushNotifications',
      'direct-read:executionPreparation',
      'direct-read:delegatedInputAnswers',
      // Declarations named hasCapability above report nothing; an unrelated
      // member call and member reference still fail loudly (see message).
      'call:null',
      'alias:null',
    ]);
  });
});
