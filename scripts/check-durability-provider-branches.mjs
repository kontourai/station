import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript-api';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const PROVIDERS = new Set([
  'station',
  'station-agent',
  'claude',
  'codex',
  'acp',
  'muse',
  'bedrock',
  'ollama',
  'opencode',
  'grok',
]);
const DURABILITY =
  /steer|fork|resum|cancel|interrupt|recover|compac|continu|replay|transcript|turn.?boundary|history|durability/i;
const CREDENTIAL = /credential|oauth|authentication/i;

/** Find provider-specific decisions near a durability action, ignoring comments. */
export function findDurabilityProviderBranches(text, file = 'module.ts') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length)
    throw new Error(`Cannot parse ${file}; durability branch check refused.`);
  const aliases = new Set(['provider']);
  const constants = new Set();
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer) &&
      PROVIDERS.has(node.initializer.text)
    )
      constants.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      node.initializer.name.text === 'provider'
    )
      aliases.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isElementAccessExpression(node.initializer) &&
      node.initializer.argumentExpression &&
      ts.isStringLiteralLike(node.initializer.argumentExpression) &&
      node.initializer.argumentExpression.text === 'provider'
    )
      aliases.add(node.name.text);
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      ((node.propertyName &&
        ts.isIdentifier(node.propertyName) &&
        node.propertyName.text === 'provider') ||
        (!node.propertyName && node.name.text === 'provider'))
    )
      aliases.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const provider = (node) =>
    (ts.isParenthesizedExpression(node) && provider(node.expression)) ||
    (ts.isIdentifier(node) &&
      (aliases.has(node.text) || /provider|engine/i.test(node.text))) ||
    (ts.isPropertyAccessExpression(node) &&
      /provider|engine/i.test(node.name.text));
  const literal = (node) =>
    (ts.isParenthesizedExpression(node) && literal(node.expression)) ||
    (ts.isStringLiteralLike(node) && PROVIDERS.has(node.text)) ||
    (ts.isIdentifier(node) &&
      (constants.has(node.text) ||
        /^PROVIDER_(CLAUDE|CODEX|ACP|MUSE|STATION_AGENT|STATION|BEDROCK|OLLAMA|OPENCODE|GROK)$/.test(
          node.text,
        )));
  const branchWords = (node) => {
    const words = [];
    const collectWords = (part) => {
      if (ts.isIdentifier(part) || ts.isStringLiteralLike(part))
        words.push(part.text);
      ts.forEachChild(part, collectWords);
    };
    collectWords(node);
    return words.join(' ');
  };
  const inScope = (node) => {
    const names = [file];
    let branch = ts.isCaseClause(node) ? node : undefined;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        !branch &&
        (ts.isIfStatement(parent) ||
          ts.isConditionalExpression(parent) ||
          ts.isCaseClause(parent))
      )
        branch = parent;
      if (
        ts.isVariableDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isFunctionDeclaration(parent)
      ) {
        if (parent.name) names.push(parent.name.getText(source));
        if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent))
          break;
      }
    }
    const context = names.join(' ');
    if (CREDENTIAL.test(context)) return false;
    return (
      DURABILITY.test(context) ||
      Boolean(branch && DURABILITY.test(branchWords(branch)))
    );
  };
  const found = [];
  const add = (node) => {
    if (!inScope(node)) return;
    found.push({
      startLine:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      expression: node.getText(source),
    });
  };
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind) &&
      ((provider(node.left) && literal(node.right)) ||
        (literal(node.left) && provider(node.right)))
    )
      add(node);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'includes' &&
      ts.isArrayLiteralExpression(node.expression.expression) &&
      node.expression.expression.elements.some(literal) &&
      node.arguments.some(provider)
    )
      add(node);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Object' &&
      node.expression.name.text === 'is' &&
      node.arguments.length === 2 &&
      ((provider(node.arguments[0]) && literal(node.arguments[1])) ||
        (literal(node.arguments[0]) && provider(node.arguments[1])))
    )
      add(node);
    if (
      ts.isCaseClause(node) &&
      literal(node.expression) &&
      ts.isCaseBlock(node.parent) &&
      ts.isSwitchStatement(node.parent.parent) &&
      provider(node.parent.parent.expression)
    )
      add(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function git(args) {
  return execFileSyncBounded('git', args, { encoding: 'utf8' });
}

// Each retained identity check decodes a named protocol. Counts prevent a copied
// expression from acquiring the same exception elsewhere in the file.
const REVIEWED_PROTOCOL_BRANCHES = [
  {
    file: 'packages/sdk/src/device-code-login.ts',
    expression: "value.engine !== 'codex'",
    count: 1,
    reason:
      'Validates the two sign-in response wire formats; no conversation durability decision.',
  },
  {
    file: 'packages/sdk/src/device-code-login.ts',
    expression: "value.engine !== 'claude'",
    count: 1,
    reason:
      'Validates the two sign-in response wire formats; no conversation durability decision.',
  },
  {
    file: 'src-server/providers/sessions/grok-session-source.ts',
    expression: "session.provider !== 'acp'",
    count: 1,
    reason:
      'Decodes only the ACP-owned session cursor for this attached-session source.',
  },
  {
    file: 'src-server/providers/sessions/opencode-session-source.ts',
    expression: "session.provider !== 'acp'",
    count: 1,
    reason:
      'Decodes only the ACP-owned session cursor for this attached-session source.',
  },
  {
    file: 'src-server/routes/connections/app-home.ts',
    expression: "target.engine.provider === 'claude'",
    count: 1,
    reason:
      'Cancels the matching browser-code or device-code sign-in protocol.',
  },
  {
    file: 'src-server/runtime/bootstrap/acp-resume-cursor-support.ts',
    expression: "provider !== 'acp'",
    count: 1,
    reason:
      'Reads the ACP initialize/loadSession handshake for that connection; not a fidelity default.',
  },
  {
    file: 'src-server/services/orchestration/event-store.ts',
    expression: "forkEvent.provider === 'station'",
    count: 1,
    reason:
      'Validates that the fork provenance marker was authored by Station.',
  },
  {
    file: 'src-server/services/orchestration/native-memory-continuity.ts',
    expression: "value.provider !== 'station-agent'",
    count: 1,
    reason: 'Validates the Station relay-specific signed memory scope schema.',
  },
  {
    file: 'src-server/services/orchestration/orchestration-service.ts',
    expression: "current?.provider !== 'station-agent'",
    count: 1,
    reason:
      'Constructs only the Station relay-specific memory binding schema; ownership selection uses the profile.',
  },
  {
    file: 'src-server/services/orchestration/session-transcript-reads.ts',
    expression: "event.provider === 'station-agent'",
    count: 2,
    reason:
      'Recognizes usage mirrored by the private Station HTTP relay to avoid double accounting.',
  },
  {
    file: 'src-server/services/orchestration/sqlite-session-turn-boundary.ts',
    expression: "event.provider === 'codex'",
    count: 1,
    reason:
      'Decodes Codex retriable runtime.error as advisory rather than a terminal; preserves the shared event protocol.',
  },
  {
    file: 'src-ui/src/hooks/useChatInput.ts',
    expression: "activeChatState?.provider === 'acp'",
    count: 1,
    reason:
      'Applies ACP wire model-selection restrictions; not a durability capability or fallback.',
  },
];

const signature = (file, expression) =>
  `${file}:${expression.replace(/\s+/g, ' ').trim()}`;

export function main() {
  const tracked = git([
    'ls-files',
    '-z',
    '--',
    'src-server',
    'src-ui/src',
    'packages/sdk/src',
  ])
    .split('\0')
    .filter(Boolean);
  const untracked = git([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'src-server',
    'src-ui/src',
    'packages/sdk/src',
  ])
    .split('\0')
    .filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].filter(
    (file) =>
      /\.(?:ts|tsx)$/.test(file) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/.test(file) &&
      !file.includes('/__tests__/') &&
      !file.includes('/__test-utils__/') &&
      !file.includes('/__fixtures__/'),
  );
  const violations = [];
  const reviewed = new Map(
    REVIEWED_PROTOCOL_BRANCHES.map((entry) => [
      signature(entry.file, entry.expression),
      entry,
    ]),
  );
  const counts = new Map();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(file), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const found of findDurabilityProviderBranches(text, file)) {
      const key = signature(file, found.expression);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count <= (reviewed.get(key)?.count ?? 0)) continue;
      violations.push(`${file}:${found.startLine}: ${found.expression}`);
    }
  }
  for (const entry of REVIEWED_PROTOCOL_BRANCHES) {
    if (
      files.includes(entry.file) &&
      (counts.get(signature(entry.file, entry.expression)) ?? 0) < entry.count
    )
      violations.push(
        `${entry.file}: obsolete protocol inventory: ${entry.expression}`,
      );
  }
  if (violations.length) {
    process.stderr.write(
      `Unreviewed provider-specific durability decisions:\n${violations.join('\n')}\n`,
    );
    process.exitCode = 1;
  } else
    process.stdout.write(
      `Durability provider branch backstop: ${files.length} source file(s), ${[...counts.values()].reduce((sum, count) => sum + count, 0)} reviewed protocol check(s), no unreviewed findings.\n`,
    );
}

if (invokedDirectly(import.meta.url)) main();
