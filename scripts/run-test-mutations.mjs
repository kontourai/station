#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import {
  inspectFocusedVitestOutput,
  plainFocusedVitestOutput,
} from './run-focused-tests.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const exactReplace = (source, before, after) => {
  if (source.split(before).length !== 2)
    throw new Error('Mutation landmark missing or ambiguous');
  return source.replace(before, after);
};
export function removeEmptyRender(source) {
  const ast = ts.createSourceFile(
    'component.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const edits = [];
  const visit = (node) => {
    if (
      ts.isConditionalExpression(node) &&
      /\.length\s*===\s*0/.test(node.condition.getText(ast))
    )
      edits.push([node.whenTrue.getStart(ast), node.whenTrue.end]);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (edits.length !== 1) throw new Error('Expected one empty-render branch');
  const [start, end] = edits[0];
  return source.slice(0, start) + 'null' + source.slice(end);
}
export const MUTATIONS = [
  {
    id: 'empty-dock-new-chat-action',
    test: 'src-ui/src/__tests__/ChatDockContentArea.test.tsx',
    failure: 'starts a chat through the empty dock action',
    files: [
      {
        path: 'src-ui/src/components/chat-dock/ChatDockContentArea.tsx',
        change: (source) =>
          exactReplace(
            source,
            'onClick={() => onNewChat()}',
            'onClick={() => {}}',
          ),
      },
    ],
  },
  {
    id: 'latest-event-seek-order',
    test: 'src-server/services/orchestration/__tests__/event-store.test.ts',
    failure:
      'the latest-any slot seeks once per requested thread instead of ranking history',
    files: [
      {
        path: 'src-server/services/orchestration/event-store.ts',
        change: (source) => {
          const start = source.indexOf('  private fetchLatestAnyEvent(');
          const end = source.indexOf('\n  /**', start);
          if (start < 0 || end < start)
            throw new Error('Latest-event method not found');
          return (
            source.slice(0, start) +
            exactReplace(
              source.slice(start, end),
              'ORDER BY sequence DESC LIMIT 1',
              'ORDER BY sequence ASC LIMIT 1',
            ) +
            source.slice(end)
          );
        },
      },
    ],
  },
  {
    id: 'api-base-publication-race',
    test: 'packages/sdk/src/__tests__/api-initialization.test.ts',
    failure:
      'pending readers observe the latest base at continuation rather than a superseded publication',
    files: [
      {
        path: 'packages/sdk/src/api-core.ts',
        change: (source) => {
          let changed = exactReplace(
            source,
            'const deadline = performance.now() + 500;',
            'const deadline = performance.now() + 500;\n  let observedBase = _apiBase;',
          );
          changed = exactReplace(
            changed,
            'const receive = () => {',
            'const receive = () => {\n        observedBase = _apiBase;',
          );
          return exactReplace(
            changed,
            'return _apiBase;',
            'return observedBase || _apiBase;',
          );
        },
      },
    ],
  },

  {
    id: 'monitoring-file-reads',
    test: 'src-server/runtime/conversation/__tests__/runtime-event-log.test.ts',
    failure:
      'skips unchanged disjoint files, but re-reads appended backfill and replaced files for each principal',
    files: [
      {
        path: 'src-server/runtime/conversation/runtime-event-log.ts',
        change: (source) =>
          exactReplace(
            source,
            'known?.signature === before &&',
            'false && known?.signature === before &&',
          ),
      },
    ],
  },
  {
    id: 'agent-catalog-reads',
    test: 'src-server/routes/agents/__tests__/agents.routes.test.ts',
    failure:
      'GET / reads each persisted definition once and refreshes the catalog on the next request',
    files: [
      {
        path: 'src-server/services/agents/agent-service.ts',
        change: (source) =>
          exactReplace(
            source,
            'const specs = new Map(',
            'await this.configLoader.readAgentCatalog();\n    const specs = new Map(',
          ),
      },
    ],
  },
  {
    id: 'collapsed-monitoring-payload',
    test: 'src-ui/src/components/monitoring/event-entry/__tests__/EventEntrySections.doubleEncode.test.tsx',
    failure: 'an object result renders as pretty-printed JSON',
    files: [
      {
        path: 'src-ui/src/components/monitoring/event-entry/EventEntrySections.tsx',
        change: (source) =>
          exactReplace(source, '{open ? children() : null}', '{children()}'),
      },
    ],
  },
  {
    id: 'retired-feature-settings',
    test: 'src-ui/src/lib/__tests__/device-settings-store.test.ts',
    failure: 'migrates featureSettings while retiring removed switches',
    files: [
      {
        path: 'src-ui/src/lib/device-settings-store.ts',
        change: (source) =>
          exactReplace(source, 'delete value[key];', 'void key;'),
      },
    ],
  },

  {
    id: 'eager-highlighter',
    test: 'src-ui/src/__tests__/SyntaxHighlighterContext.test.tsx',
    failure:
      'keeps Home idle and initializes only for a real consumer, then publishes readiness',
    files: [
      {
        path: 'src-ui/src/contexts/SyntaxHighlighterContext.tsx',
        change: (source) =>
          exactReplace(
            source,
            '  const value = useMemo(',
            '  useEffect(() => { setRequested(true); }, []);\n  const value = useMemo(',
          ),
      },
    ],
  },

  {
    id: 'empty-render',
    test: 'src-ui/src/__tests__/notification-empty-states.test.tsx',
    failure: 'renders both empty lanes with filtered=false',
    files: [
      {
        path: 'src-ui/src/components/attention/AttentionSection.tsx',
        change: removeEmptyRender,
      },
      {
        path: 'src-ui/src/components/notifications/NotificationSection.tsx',
        change: removeEmptyRender,
      },
    ],
  },
  {
    id: 'ack-read-amplification',
    test: 'src-server/services/orchestration/__tests__/conversation-acknowledgement-store.test.ts',
    failure:
      'batches one snapshot, scopes it to the user, and sees external writes on the next read',
    files: [
      {
        path: 'src-server/services/orchestration/conversation-acknowledgement-store.ts',
        change: (source) =>
          exactReplace(
            source,
            'if (conversationIds.length === 0) return result;',
            'if (conversationIds.length === 0) return result;\n    for (const id of conversationIds) { void id; this.store.read(); }',
          ),
      },
    ],
  },
  {
    id: 'scope-key-order',
    test: 'src-ui/src/workspace-panes/__tests__/sessionInventorySelection.test.ts',
    failure:
      'deduplicates equivalent scopes regardless of key order while retaining distinct turns and Tasks',
    files: [
      {
        path: 'src-ui/src/workspace-panes/sessionInventorySelection.ts',
        change: (source) => {
          const ast = ts.createSourceFile(
            'selection.ts',
            source,
            ts.ScriptTarget.Latest,
            true,
          );
          const node = ast.statements.find(
            (node) =>
              ts.isFunctionDeclaration(node) &&
              node.name?.text === 'sessionInventoryScopeKey',
          );
          if (!node?.body) throw new Error('Scope identity owner missing');
          return (
            source.slice(0, node.body.getStart(ast)) +
            '{ return JSON.stringify(scope); }' +
            source.slice(node.body.end)
          );
        },
      },
    ],
  },
  // The two #1642 entries below are a different CATEGORY from the rest of this
  // list, deliberately, and the distinction is why they are here at all. Every
  // other entry injects a defect into SOURCE and proves a test notices. These
  // two inject a defect into a FIXTURE and prove its premise assertion notices.
  //
  // `RouteViewReadiness.adapterScreens.test.tsx` pins its adapters with
  // arrangements built on decoy elements — a hidden match before a visible one —
  // and every one of those arrangements is only as good as the decoys still
  // being matched by the locator under test. Break a decoy and the arrangement
  // does not fail; it passes while testing nothing, and it still looks like
  // coverage. That happened: renaming the route decoys left the suite green at
  // exit 0 until a premise assertion was added.
  //
  // WHAT BEING IN THIS LIST DOES AND DOES NOT MEAN, stated because "registered
  // in the mutation lane" reads as enforcement and is not. Nothing invokes this
  // list: `test:mutation:smoke` is referenced by documentation and by hand, and
  // `scripts/__tests__/test-mutations.test.ts` — the one thing a gate does run —
  // exercises this driver's own logic and never touches `MUTATIONS`. So an entry
  // here is a hand-runnable check and an executable record of the exact defect
  // and the exact assertion that catches it. It is not a guard, and nothing
  // notices if the property it describes stops holding.
  //
  // Which is also why the seven per-read mutations this file's #1642 arrangements
  // were verified against are absent rather than "covered by these two": all nine
  // are report-verified, and only these two are additionally re-runnable by
  // anyone. Registering the rest would add executable records, not protection.
  //
  // COST, for whoever registers the next Chromium-backed case: each entry runs
  // its target file three times — baseline, injected, restored, all three
  // load-bearing, since a catch cannot be claimed without a green baseline and a
  // green restore. A ~9 s suite therefore costs ~27 s per case.
  {
    id: 'readiness-route-decoys-unmatched',
    test: 'src-ui/src/__tests__/RouteViewReadiness.adapterScreens.test.tsx',
    failure:
      'a visible target between HIDDEN matches is still observed as ready',
    files: [
      {
        path: 'src-ui/src/__tests__/RouteViewReadiness.adapterScreens.test.tsx',
        change: (source) =>
          exactReplace(
            source,
            'class="target-surface" id="masking-first"',
            'class="decoy-renamed" id="masking-first"',
          ),
      },
    ],
  },
  {
    id: 'readiness-lazy-decoy-absent',
    test: 'src-ui/src/__tests__/RouteViewReadiness.adapterScreens.test.tsx',
    failure: 'the quoted failure text is a VISIBLE failure, not index zero',
    files: [
      {
        path: 'src-ui/src/__tests__/RouteViewReadiness.adapterScreens.test.tsx',
        change: (source) =>
          exactReplace(source, 'decoy + failure,', 'failure,'),
      },
    ],
  },
  {
    id: 'engine-fixture-identity',
    test: 'scripts/__tests__/connection-fixtures.test.ts',
    failure: 'a claude fixture cannot become a Station-model binding',
    files: [
      {
        path: 'tests/helpers/connection-fixtures.ts',
        change: (source) =>
          exactReplace(
            source,
            'engineId: matrix.engineId',
            'engineId: undefined',
          ),
      },
    ],
  },
];

export function mutationCaught(result, root, expectedFailure) {
  const plain = plainFocusedVitestOutput(result.output);
  return (
    result.status === 1 &&
    !result.signal &&
    !result.truncated &&
    inspectFocusedVitestOutput(plain, root).runRoot === resolve(root) &&
    /^\s*Tests\s+\d+ failed/m.test(plain) &&
    plain
      .split('\n')
      .some((line) => /^\s*FAIL\s/.test(line) && line.includes(expectedFailure))
  );
}

/** Restore only our exact injected bytes. An unexpected edit is never overwritten. */
export function restoreMutation(root, files) {
  const errors = [];
  for (const file of files) {
    try {
      const path = resolve(root, file.path);
      const within = relative(root, path);
      if (
        !within ||
        within.startsWith('..') ||
        isAbsolute(within) ||
        lstatSync(path).isSymbolicLink() ||
        digest(file.original) !== file.originalHash
      )
        throw new Error('Invalid mutation recovery record');
      const current = readFileSync(path, 'utf8');
      if (current === file.original) continue;
      if (digest(current) !== file.injectedHash)
        throw new Error(
          `Refusing to overwrite an intervening edit: ${file.path}`,
        );
      writeFileSync(path, file.original);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      errors.map((error) => error.message).join('; '),
    );
}

export async function withMutation(
  root,
  mutation,
  directory,
  execute,
  sourceRevision = null,
) {
  const files = mutation.files.map((file) => {
    const original = readFileSync(join(root, file.path), 'utf8');
    const injected = file.change(original);
    if (injected === original)
      throw new Error('Mutation did not change source');
    return {
      path: file.path,
      original,
      originalHash: digest(original),
      injected,
      injectedHash: digest(injected),
    };
  });
  writeFileSync(
    join(directory, 'recovery.json'),
    JSON.stringify({ root, sourceRevision, files }, null, 2),
  );
  try {
    for (const file of files) {
      if (
        digest(readFileSync(join(root, file.path), 'utf8')) !==
        file.originalHash
      )
        throw new Error(`Source changed before mutation: ${file.path}`);
      writeFileSync(join(root, file.path), file.injected);
    }
    return await execute();
  } finally {
    restoreMutation(root, files);
  }
}

async function focused(root, file, log) {
  const execution = executeOwnedCommand(
    process.execPath,
    ['scripts/run-focused-tests.mjs', file],
    undefined,
    'mutation focused test',
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const stop = () =>
    terminateSuiteExecution(execution, {
      processLabel: 'mutation focused test',
      terminationGraceMs: 2000,
      terminationForceMs: 2000,
      waitForSuiteSettlement,
    });
  const output = captureOwnedProcessOutput(execution, {
    maxBytes: 512 * 1024,
    onOverflow: stop,
  });
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    void stop();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const timer = setTimeout(onSignal, 120_000);
  try {
    const result = await execution.completion;
    if (execution.isAlive()) await stop();
    const capture = output.finish();
    const text = capture.stdout.text + '\n' + capture.stderr.text;
    writeFileSync(log, text);
    if (interrupted || execution.isAlive() || result.error)
      throw new Error('Mutation test process did not settle normally');
    return { ...result, output: text, truncated: capture.truncated };
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  const recoveryArg = argv.find((arg) => arg.startsWith('--recover='));
  if (recoveryArg) {
    if (argv.length !== 1)
      throw new Error('Recovery takes only --recover=<recovery.json>');
    const recoveryPath = resolve(root, recoveryArg.slice(10));
    const allowedDirectory = join(root, '.kontourai', 'test-mutations');
    const relativeRecovery = relative(allowedDirectory, recoveryPath);
    if (relativeRecovery.startsWith('..') || isAbsolute(relativeRecovery))
      throw new Error('Recovery record must belong to this worktree');
    const record = JSON.parse(readFileSync(recoveryPath, 'utf8'));
    if (
      record.root !== root ||
      record.sourceRevision !== git(['rev-parse', 'HEAD'])
    )
      throw new Error('Recovery revision/worktree mismatch');
    const lockPath = join(root, '.kontourai', 'test-mutations.lock');
    try {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
      try {
        process.kill(owner.pid, 0);
        throw new Error('Mutation owner is still running');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const allowed = new Set(
      MUTATIONS.flatMap((mutation) => mutation.files.map((file) => file.path)),
    );
    for (const file of record.files) {
      if (
        !allowed.has(file.path) ||
        digest(
          execFileSync(
            'git',
            ['show', `${record.sourceRevision}:${file.path}`],
            { cwd: root, encoding: 'utf8', windowsHide: true },
          ),
        ) !== file.originalHash
      )
        throw new Error('Recovery original does not match git');
    }
    restoreMutation(root, record.files);
    rmSync(lockPath, { force: true });
    console.log(
      'Restored owned mutation bytes; any unrelated edits were preserved.',
    );
    return;
  }
  if (argv.some((arg) => !arg.startsWith('--case=')))
    throw new Error(
      'Usage: test:mutation:smoke [--case=<id>] or --recover=<recovery.json>',
    );
  const id = argv.find((arg) => arg.startsWith('--case='))?.slice(7);
  const selected = id ? MUTATIONS.filter((m) => m.id === id) : MUTATIONS;
  if (!selected.length) throw new Error('Unknown mutation case');
  if (!statSync(join(root, '.git')).isFile())
    throw new Error('Mutation checks require an isolated linked worktree');
  if (git(['status', '--porcelain']))
    throw new Error('Commit first: mutation checks require a clean worktree');
  const directory = join(
    root,
    '.kontourai',
    'test-mutations',
    `${Date.now()}-${git(['rev-parse', '--short', 'HEAD'])}`,
  );
  mkdirSync(directory, { recursive: true });
  const lock = join(root, '.kontourai', 'test-mutations.lock');
  const fd = openSync(lock, 'wx');
  writeFileSync(fd, JSON.stringify({ pid: process.pid, directory }));
  const results = [];
  try {
    for (const mutation of selected) {
      const caseDir = join(directory, mutation.id);
      mkdirSync(caseDir);
      console.log(`[mutation] ${mutation.id}: baseline`);
      const baseline = await focused(
        root,
        mutation.test,
        join(caseDir, 'baseline.log'),
      );
      if (baseline.status !== 0 || baseline.truncated)
        throw new Error(`${mutation.id}: baseline is not green`);
      const result = await withMutation(
        root,
        mutation,
        caseDir,
        () => focused(root, mutation.test, join(caseDir, 'injected.log')),
        git(['rev-parse', 'HEAD']),
      );
      const caught = mutationCaught(result, root, mutation.failure);
      console.log(
        `[mutation] ${mutation.id}: ${caught ? 'caught' : 'NOT caught'}; checking restoration`,
      );
      const restored = await focused(
        root,
        mutation.test,
        join(caseDir, 'restored.log'),
      );
      results.push({
        id: mutation.id,
        caught,
        restored: restored.status === 0,
      });
      if (!caught || restored.status !== 0)
        throw new Error(
          `${mutation.id}: test lacks power or restoration is not green`,
        );
    }
    if (git(['status', '--porcelain']))
      throw new Error('Mutation suite left changed source');
  } finally {
    writeFileSync(
      join(directory, 'summary.json'),
      JSON.stringify(
        { version: 1, sourceRevision: git(['rev-parse', 'HEAD']), results },
        null,
        2,
      ),
    );
    closeSync(fd);
    rmSync(lock);
  }
  console.log(JSON.stringify({ directory, results }, null, 2));
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  await main();
