import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { REQUIRED_CODING_COMPOSITION_CATEGORIES } from './coding-composition-policy.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const expectedDependencies = new Map(
  Object.entries({
    'packages/contracts/src/diff-comment.ts': 'contract',
    // #2412: the pairing scope vocabulary names `/api/coding/exec` because
    // its `coding:exec` token is the per-device grant that route requires.
    // `route-authorization`, like the route-scope table beside it: it is a
    // grant vocabulary, and renders and runs nothing.
    'packages/contracts/src/environment-security.ts': 'route-authorization',
    'packages/contracts/src/distribution.ts': 'distribution',
    'packages/contracts/src/index.ts': 'contract-export',
    'packages/contracts/src/layout.ts': 'distribution',
    'packages/contracts/src/workspace-coding-panels.ts': 'pane-contract',
    // station#3798 added this inventory of built-in Pane renderer NAMES; it
    // includes the Coding panes, which is why the semantic scan sees it.
    // Declared as a pane contract alongside `workspace-coding-panels.ts`:
    // it authorises nothing and grants no capability — it is the list of
    // names for which this build ships a renderer, read by both halves of
    // the build so the server and the UI cannot disagree about which panes
    // exist. Declared here because it landed undeclared and the gate
    // refuses every push until a human classifies it (found while
    // delivering station#3815).
    'packages/contracts/src/workspace-pane-builtin-renderers.ts':
      'pane-contract',
    'packages/contracts/src/workspace-coding-file-composition.ts':
      'workspace-composition',
    'packages/contracts/src/workspace-coding-diff-composition.ts':
      'workspace-composition',
    'packages/contracts/src/workspace-coding-evidence-composition.ts':
      'workspace-composition',
    'packages/sdk/src/index.ts': 'sdk-export',
    'packages/sdk/src/queries.ts': 'sdk-export',
    'packages/sdk/src/query-domains/chatRuntimeCoding.ts': 'sdk-route-adapter',
    'packages/sdk/src/query-domains/chatRuntime.ts': 'sdk-export',
    'packages/sdk/src/query-domains/projectData.ts': 'sdk-route-adapter',
    'src-server/routes/projects/coding.ts': 'privileged-route',
    'src-server/routes/projects/layout-working-directory.ts': 'persistence',
    // #2062: the admission `POST /api/projects/:slug/layouts` applies before
    // writing, extracted so promote (`/api/me/layouts/:slug/promote`) derives
    // the same answer instead of carrying a second copy that drifts. The scan
    // sees it because one of the two refusals is the Coding working-directory
    // rule, which it enforces by calling this module's neighbour rather than
    // by reimplementing it. `persistence`, alongside that neighbour: it
    // decides what may be written and normalizes the record, and it grants
    // nothing and renders nothing.
    'src-server/routes/projects/project-layout-admission.ts': 'persistence',
    // #2363: the coding toolbar's Commit and Push, moved out of the route so
    // the route keeps validation and the operator check. `git-review`,
    // beside the toolbar that calls it: it runs git in the Project's own
    // repository and refuses what Station will not commit or push.
    'src-server/services/projects/coding-git-actions.ts': 'git-review',
    'src-server/routes/projects/projects.ts': 'project-route',
    'src-server/runtime/routes/runtime-routes.ts': 'route-registration',
    'src-server/security/pairing-route-scopes.ts': 'route-authorization',
    'src-server/services/projects/workspace-pane-known-declarations.ts':
      'pane-declaration',
    'src-server/telemetry/metrics.ts': 'operation-receipt',
    'src-ui/src/app-shell/ProjectLayoutRenderer.tsx': 'aggregate-host',
    // #1446: the aggregate host's dispatch decision (which renderer a
    // project layout reaches — the Coding host, a registry entry, or the
    // declared-tabs view) extracted into a pure module so `App.tsx` can read
    // the same derivation without importing the host or its renderers. It
    // renders nothing and grants nothing; it is the host's own branch table.
    'src-ui/src/app-shell/project-layout-kind.ts': 'aggregate-host',
    // #2157: a Board or a project Layout as a dock pane. The scan sees it
    // because it reads `project-layout-kind`'s dispatch to REFUSE the Coding
    // kind — a Coding layout is a whole `WorkspacePaneHost` keyed on the
    // same `(projectId, layoutId)` as the main region's, so a docked copy
    // would share its persisted document — and renders "Open this Layout
    // in Main" whose action is `setLayout`. `navigation`, ProjectPage's
    // category: it chooses the host (Main) rather than being one; it mounts
    // no Coding surface and grants nothing.
    'src-ui/src/workspace-panes/LayoutWorkspacePane.tsx': 'navigation',
    'src-ui/src/app-shell/codingFileCompositionTelemetry.ts':
      'operation-receipt',
    'src-ui/src/app-shell/codingDiffCompositionTelemetry.ts':
      'operation-receipt',
    'src-ui/src/app-shell/codingEvidenceCompositionTelemetry.ts':
      'operation-receipt',
    // Arrived with #3158/#3115 (f6aa6568d) without an inventory entry, which
    // left `origin/main` red on this gate for every branch that gated after
    // it. `presentation`, not `operation-receipt`: it is the user-facing
    // sentence per unavailable reason, not a receipt the composition emits.
    'src-ui/src/app-shell/codingEvidenceUnavailableCopy.ts': 'presentation',
    'src-ui/src/components/chat-dock/ChatDock.tsx': 'chat-handoff',
    // The composer’s bounded file mention picker reads the project-scoped
    // Coding file-search projection through the SDK. It renders no Coding
    // pane and grants no workspace authority; classify the dependency at the
    // chat handoff seam so the inventory remains explicit.
    'src-ui/src/components/chat/FileMentionAutocomplete.tsx': 'chat-handoff',
    // `ChatDockProjectContext.tsx` was declared here for its
    // `codingLayoutSlug` prop: the project row's directory segment doubled as
    // a link into the session's Coding layout. #1536 F retired that segment
    // (it was leaving the conversation title beside it about one character
    // wide) and the route moved to `ChatDock.tsx`'s own "Open code layout"
    // menu row, which is already declared above. The row itself now names a
    // project and a branch and knows nothing about Coding, so it is no longer
    // a Coding dependency to declare.
    'src-ui/src/components/chat-dock/dockSnap.ts': 'presentation',
    'src-ui/src/components/chat-dock/useChatDockViewModel.ts': 'navigation',
    'src-ui/src/components/coding-layout/CodingInspectorPanel.css':
      'presentation',
    'src-ui/src/components/coding-layout/CodingInspectorPanel.tsx':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/CodingLayout.css': 'presentation',
    // #2064: independent-review receipts moved from /review-queue into the
    // Coding inspector's Reviews tab. This is the tab's content: it lists a
    // project's receipts and opens the run modal. Privileged like the
    // inspector panel that mounts it, because running a review POSTs a
    // receipt-producing job.
    'src-ui/src/components/coding-layout/IndependentReviewInspectorContent.tsx':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/BranchToolbar.css': 'presentation',
    'src-ui/src/components/coding-layout/BranchToolbar.tsx': 'git-review',
    'src-ui/src/components/coding-layout/CodingTerminalPane.tsx':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/CodingTerminalPanel.tsx':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/FileTreePanel.tsx':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/fileTreeFilter.ts':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/NewTerminalModal.tsx':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/DiffCommentThread.tsx': 'git-review',
    'src-ui/src/components/coding-layout/DiffPanel.css': 'presentation',
    'src-ui/src/components/coding-layout/DiffPanel.tsx': 'git-review',
    'src-ui/src/components/coding-layout/FileContentViewer.tsx':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/FileTreeContextMenu.tsx':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/FileTreePanel.css': 'presentation',
    'src-ui/src/components/coding-layout/PullRequestsPanel.css': 'presentation',
    'src-ui/src/components/coding-layout/PullRequestsPanel.tsx': 'git-review',
    'src-ui/src/components/coding-layout/PullRequestReviewPanel.css':
      'presentation',
    'src-ui/src/components/coding-layout/PullRequestReviewPanel.tsx':
      'git-review',
    'src-ui/src/components/coding-layout/PullRequestDependencyStacks.css':
      'presentation',
    'src-ui/src/components/coding-layout/PullRequestDependencyStacks.tsx':
      'git-review',
    'src-ui/src/components/coding-layout/pull-request-dependency-stacks.ts':
      'git-review',
    'src-ui/src/components/coding-layout/TerminalPanel.tsx':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/activeRepo.ts': 'git-review',
    'src-ui/src/components/coding-layout/activeTerminal.ts':
      'privileged-renderer',
    'src-ui/src/components/coding-layout/chatContextDraft.ts': 'chat-handoff',
    'src-ui/src/components/coding-layout/planSession.ts': 'task-plan',
    'src-ui/src/components/coding-layout/terminalSelectionHandoff.ts':
      'chat-handoff',
    'src-ui/src/components/coding-layout/types.ts': 'private-contract',
    'src-ui/src/components/coding-layout/utils.ts': 'presentation',
    'src-ui/src/components/modals/NewChatModal.tsx': 'chat-handoff',
    'src-ui/src/hooks/useGitActions.ts': 'git-review',
    'src-ui/src/hooks/useNewProjectStarter.ts': 'distribution',
    'src-ui/src/index.css': 'presentation',
    // #890: ProjectPage is the navigation composition seam that chooses a
    // host before opening a layout-bound Workspace Pane. Every renderer in
    // the current closed requirement set reads Coding layout configuration,
    // so that coupling is intentional rather than a generic-host claim.
    // Generalizing it requires a versioned WorkspacePaneDescriptor field for
    // accepted layout types AND retained-LayoutTab/parser adaptation checks;
    // a UI-only field would make contributed routing metadata unverifiable.
    'src-ui/src/views/ProjectPage.tsx': 'navigation',
    // #2047: the surface → pane inventory joins the coding dock surfaces
    // (`coding:terminal`, `coding:diff`, `coding:file-browser`) to the
    // coding pane contracts' fixed per-project instances and canonical
    // predicates (`workspace-coding-panels.ts`), the same contract role
    // `builtinWorkspacePaneCanonical.ts` plays for the built-in host. Since
    // #90 D9 it also holds the renderer `sourceFile` paths the architecture
    // ratchet reads, moved out of `region-model.ts` (the entry chunk), which
    // no longer names a Coding renderer and so is no longer declared here.
    'src-ui/src/regions/region-surface-panes.ts': 'pane-contract',
    // #2047: a docked coding pane's renderer, behind the region host's lazy
    // boundary — it hands the region's project-bound instance to
    // `getBuiltinWorkspacePaneRenderer`, the registry declared below.
    'src-ui/src/workspace-panes/RegionBuiltinPane.tsx': 'private-import',
    'src-ui/src/views/TaskWorkspaceView.tsx': 'private-import',
    'src-ui/src/workspace-panes/FilePreviewPane.tsx': 'privileged-renderer',
    'src-ui/src/workspace-panes/WorkspacePaneHost.css': 'presentation',
    'src-ui/src/workspace-panes/builtinWorkspacePaneCanonical.ts':
      'pane-contract',
    'src-ui/src/workspace-panes/builtinWorkspacePaneRegistry.tsx':
      'private-import',
    'src-ui/src/workspace-panes/workspacePaneDirectRoute.ts': 'direct-route',
    // #765 F4: the tile-glyph map for the workspace-pane cards. The semantic
    // scan sees it because it names the Coding pane renderer names; it is
    // display-only — a renderer-name → SVG-glyph lookup that authorises
    // nothing and reaches no privileged surface.
    'src-ui/src/workspace-panes/workspacePaneGlyphs.tsx': 'presentation',
  }),
);
const semantic =
  /workspace-coding|coding-layout|codingLayout|isCoding|CodingLayout|CodingPane|\/api\/coding|codingOps|createCodingRoutes|builtin:coding|type[^\n]{0,20}coding/i;

function walk(root, dir, includeTests = false) {
  const paths = [];
  for (const name of readdirSync(resolve(root, dir))) {
    // Installed dependencies are not repository source or owned test proof.
    // Skip before stat: pnpm links may be dangling or lead back into packages.
    if (name === 'node_modules') continue;
    const relative = `${dir}/${name}`;
    const stat = statSync(resolve(root, relative));
    if (stat.isDirectory()) paths.push(...walk(root, relative, includeTests));
    else if (
      /\.(?:ts|tsx|css)$/.test(name) &&
      (includeTests || !relative.includes('/__tests__/'))
    )
      paths.push(relative);
  }
  return paths;
}

export function auditCodingCompositionInventory(
  root = process.cwd(),
  overrides = {},
) {
  const inventoryPath = 'scripts/coding-composition-capability-inventory.json';
  const inventory =
    overrides.inventory ??
    JSON.parse(readFileSync(resolve(root, inventoryPath), 'utf8'));
  const source = (file) =>
    overrides.sources?.[file] ?? readFileSync(resolve(root, file), 'utf8');
  const findings = [];
  const production = [
    ...walk(root, 'src-ui/src'),
    ...walk(root, 'src-server'),
    ...walk(root, 'packages/contracts/src'),
    ...walk(root, 'packages/sdk/src'),
    ...walk(root, 'packages/cli/src'),
    ...walk(root, 'packages/shared/src'),
    ...walk(root, 'src-shared'),
    ...Object.keys(overrides.sources ?? {}),
  ];
  const discovered = new Set(
    production.filter((file) =>
      file.startsWith('packages/sdk/src/')
        ? /Coding|coding/.test(source(file))
        : semantic.test(file) || semantic.test(source(file)),
    ),
  );
  for (const file of discovered)
    if (!expectedDependencies.has(file))
      findings.push(`undeclared Coding dependency: ${file}`);
  for (const [file, category] of expectedDependencies) {
    const anchored = file.startsWith('packages/sdk/src/')
      ? /Coding|coding/.test(source(file))
      : semantic.test(file) || semantic.test(source(file));
    if (!anchored)
      findings.push(
        `declared Coding dependency lost semantic anchor: ${file} (${category})`,
      );
  }
  if (
    inventory.mcpApps?.role !== 'sandboxed-renderer-leaf' ||
    inventory.mcpApps?.workspaceAuthority !== false ||
    inventory.mcpApps?.displayMode?.status !== 'IMPLEMENTED' ||
    inventory.mcpApps?.displayMode?.deliveryIssue !== 2952 ||
    inventory.mcpApps?.displayMode?.contract !==
      '@kontourai/station-contracts/mcp-app-display-mode' ||
    inventory.mcpApps?.displayMode?.hostPolicy !==
      'intersect app-declared and host-available modes; report actual mode' ||
    inventory.mcpApps?.displayMode?.receipt !== 'MCPAppDisplayModeDecision' ||
    inventory.mcpApps?.displayMode?.pip !== 'UNSUPPORTED' ||
    inventory.mcpApps?.displayMode?.fullscreenIsPopout !== false ||
    !Array.isArray(inventory.mcpApps?.displayMode?.testProofs)
  )
    findings.push('MCP Apps/display-mode boundary drifted');
  const rows = inventory.capabilities ?? [];
  const rowIds = new Set(rows.map((row) => row.id));
  const requiredCoverage = new Set(
    overrides.requiredCategories ?? REQUIRED_CODING_COMPOSITION_CATEGORIES,
  );
  for (const required of requiredCoverage)
    if (!rowIds.has(required))
      findings.push(`required capability category missing: ${required}`);
  if (rowIds.size !== rows.length)
    findings.push('capability ids must be unique');
  const tests = new Map();
  for (const file of [
    ...walk(root, 'src-ui/src', true),
    ...walk(root, 'src-server', true),
    ...walk(root, 'packages', true),
  ])
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
      tests.set(file, source(file));
  const validateTestProofs = (owner, proofs) => {
    if (!Array.isArray(proofs) || proofs.length === 0) {
      findings.push(`${owner} lacks testProofs`);
      return;
    }
    for (const proof of proofs) {
      const text = tests.get(proof.path);
      if (!text)
        findings.push(`${owner} names missing test path ${proof.path}`);
      else if (!text.includes(proof.anchor))
        findings.push(
          `${owner} test anchor missing: ${proof.path}: ${proof.anchor}`,
        );
    }
  };
  validateTestProofs(
    'MCP Apps display-mode mediation',
    inventory.mcpApps?.displayMode?.testProofs,
  );
  for (const row of rows) {
    for (const field of [
      'id',
      'contract',
      'adapter',
      'permission',
      'authorityOwner',
      'cancellation',
      'receipt',
    ])
      if (typeof row[field] !== 'string' || !row[field].trim())
        findings.push(
          `Coding capability '${row.id ?? 'unknown'}' lacks ${field}`,
        );
    if (!Array.isArray(row.journeys) || row.journeys.length === 0)
      findings.push(`Coding capability '${row.id}' lacks journeys`);
    validateTestProofs(`Coding capability '${row.id}'`, row.testProofs);
  }
  const fixture = inventory.nonDeveloperCompositionFixture;
  if (
    !fixture ||
    fixture.forbiddenVocabulary.some((term) =>
      JSON.stringify({
        descriptors: fixture.descriptors,
        instances: fixture.instances,
      })
        .toLowerCase()
        .includes(term),
    )
  )
    findings.push(
      'non-developer generic-host fixture contains Coding vocabulary',
    );
  const packageJson = JSON.parse(source('package.json'));
  if (
    !String(packageJson.scripts?.['gate:naming']).includes(
      'coding-composition:gate',
    )
  )
    findings.push('coding-composition:gate is not enforced by gate:naming');
  return findings;
}

if (invokedDirectly(import.meta.url)) {
  const findings = auditCodingCompositionInventory();
  if (findings.length) {
    for (const finding of findings) console.error(finding);
    process.exit(1);
  }
  console.log(
    `Coding workspace composition inventory: ${expectedDependencies.size} dependencies classified; source tripwire clean.`,
  );
}
