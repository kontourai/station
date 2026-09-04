import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export const E2E_AUDIT_PATTERN =
  /localhost:(3141|3000|5274)|waitForTimeout\(|test\.skip\(/;

export const E2E_TARGET_AUDIT_PATTERN =
  /process\.env\.(PW_API_BASE_URL|STATION_PORT)|(?:fetch\(\s*|=\s*)[`'"]http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(3141|3000|5274)/;

export const E2E_VACUOUS_ASSERTION_PATTERN = /expect\(\s*true\s*\)/;
export const E2E_INVALID_TEST_INFO_PATTERN = /async\s*\(\s*\{[^}]*\btestInfo\b/;

function propertyName(property) {
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : null;
}

function isTestInfoOutputPath(expression) {
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'testInfo' &&
    expression.expression.name.text === 'outputPath'
  );
}

function isGalleryOutputPath(filePath, expression) {
  return (
    filePath === 'tests/screenshots.spec.ts' &&
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'join' &&
    ts.isIdentifier(expression.arguments[0]) &&
    expression.arguments[0].text === 'GALLERY_DIR'
  );
}

/** Persisted screenshots must use Playwright's per-test output ownership. */
export function e2eArtifactPathErrors(filePath, text) {
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const errors = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'screenshot' &&
      node.arguments.length > 0
    ) {
      const options = node.arguments[0];
      if (!ts.isObjectLiteralExpression(options)) {
        errors.push(`${filePath} uses non-inspectable screenshot options.`);
      } else {
        for (const property of options.properties) {
          if (ts.isSpreadAssignment(property)) {
            errors.push(
              `${filePath} uses non-inspectable screenshot option spread.`,
            );
            continue;
          }
          const name = propertyName(property);
          if (name === null) {
            errors.push(
              `${filePath} uses a computed screenshot option name that cannot prove artifact ownership.`,
            );
            continue;
          }
          if (name !== 'path') continue;
          if (
            !ts.isPropertyAssignment(property) ||
            (!isTestInfoOutputPath(property.initializer) &&
              !isGalleryOutputPath(filePath, property.initializer))
          ) {
            errors.push(
              `${filePath} screenshot path must use testInfo.outputPath(...).`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}

/** The one fixture allowed to build a foreground chat receipt literal. */
export const FOREGROUND_RECEIPT_FIXTURE = 'tests/helpers/execution-receipt.ts';

const FOREGROUND_CHAT_ROUTE_FRAGMENT = '/api/orchestration/chat';

function isForegroundChatRouteLiteral(node) {
  return (
    ts.isStringLiteralLike(node) &&
    node.text.includes(FOREGROUND_CHAT_ROUTE_FRAGMENT)
  );
}

function containsForegroundChatRouteLiteral(node) {
  let found = false;
  const visit = (candidate) => {
    if (isForegroundChatRouteLiteral(candidate)) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

/** A path-router branch is a mock only when it actually fulfils a route. */
function containsRouteFulfill(node) {
  let found = false;
  const visit = (candidate) => {
    if (
      ts.isCallExpression(candidate) &&
      ts.isPropertyAccessExpression(candidate.expression) &&
      candidate.expression.name.text === 'fulfill'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

/**
 * archive#3800: a mocked `POST /api/orchestration/chat` is only ACCEPTED when
 * its body carries the exact provider turn identity — `readExecutionReceipt`
 * (`packages/sdk/src/client/execution.ts:126-137`) and the route itself
 * (`src-server/routes/orchestration/orchestration.ts:689-701`) both refuse a
 * receipt without `providerTurnId` as `foreground_message_indeterminate`. Six
 * product specs hand-wrote that body without it, so every "send succeeds"
 * assertion in them was proving the indeterminate FAILURE branch.
 *
 * The check is derived, not a name list: a receipt is recognised by its own
 * shape (`conversationId` + `sessionId` + `target` + `resolution`), and the
 * only file allowed to build one is the shared fixture — which is typed
 * against the SDK's `ForegroundMessageReceipt` and therefore cannot omit a
 * required field. A spec that reaches for the route without that fixture is
 * reported even if today's literal happens to be complete, because the
 * envelope (`{ success, data }`) is just as load-bearing as the field.
 */
export function foregroundReceiptFixtureErrors(filePath, text) {
  if (filePath === FOREGROUND_RECEIPT_FIXTURE) return [];
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const errors = [];
  let mocksChatRoute = false;
  let importsFixture = false;
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text
        .replace(/\.js$/, '')
        .endsWith('execution-receipt')
    ) {
      importsFixture = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'route' &&
      node.arguments.length > 0 &&
      isForegroundChatRouteLiteral(node.arguments[0])
    ) {
      mocksChatRoute = true;
    }
    if (
      ts.isIfStatement(node) &&
      containsForegroundChatRouteLiteral(node.expression) &&
      containsRouteFulfill(node.thenStatement)
    ) {
      mocksChatRoute = true;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(
        node.properties
          .map((property) =>
            property.name &&
            (ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name))
              ? property.name.text
              : null,
          )
          .filter(Boolean),
      );
      if (
        names.has('conversationId') &&
        names.has('sessionId') &&
        names.has('target') &&
        names.has('resolution')
      ) {
        const line =
          source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        errors.push(
          `${filePath}:${line} builds a foreground chat receipt inline; use foregroundMessageReceipt()/foregroundMessageReceiptEnvelope() from ${FOREGROUND_RECEIPT_FIXTURE}.`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (mocksChatRoute && !importsFixture) {
    errors.push(
      `${filePath} mocks ${FOREGROUND_CHAT_ROUTE_FRAGMENT} without the shared foreground-receipt fixture (${FOREGROUND_RECEIPT_FIXTURE}).`,
    );
  }
  return errors;
}

export const E2E_BUCKETS = [
  'product',
  'first-run',
  'starter-clean-install',
  'smoke-live',
  'extended',
  'screenshot',
  'quarantine',
  'android',
];

export const PR_BROWSER_SMOKE_CONTRACT = {
  budgetMinutes: 10,
  workers: 1,
  retries: 0,
  isolation: 'temp-home-and-dynamic-loopback-ports',
  flakePolicy: 'fail-and-fix-no-retry',
  journeys: [
    {
      path: 'tests/csp-shell.spec.ts',
      journey: 'built shell startup and connection recovery navigation',
    },
    {
      path: 'tests/ui-crud-smoke.spec.ts',
      journey: 'live project and connected-agent CRUD',
    },
    {
      path: 'tests/orchestration-chat-flow.spec.ts',
      journey: 'canonical chat, tool activity, and approval flow',
    },
    {
      path: 'tests/cross-runtime-chat-switching.spec.ts',
      journey:
        'deterministic provider continuity plus mobile daily-driver containment',
    },
    {
      path: 'tests/pr-smoke-live-chat-send.spec.ts',
      journey:
        'station#4537 item 2: one real turn dispatched through POST /api/orchestration/chat into a real local model server, inside the merge gate itself',
    },
  ],
};

/**
 * Product E2E shares one isolated Station instance. Specs that only use
 * browser-context-local mocks can safely fan out; specs that mutate the live
 * instance, build into a shared fixture, or own child processes must remain
 * exclusive. Keeping both lists explicit makes every new product spec choose a
 * resource class instead of silently inheriting parallel execution.
 */
export const PRODUCT_E2E_EXECUTION_PROFILE = {
  parallelWorkers: 2,
  parallelSafetyExceptions: {
    'tests/sidebar-geometry.spec.ts':
      'read-only layout measurements against the isolated temp-home instance',
    'tests/mobile-dock-clearance.spec.ts':
      'read-only geometry and hit-test measurements against the isolated temp-home instance; the only write is a browser-local --safe-bottom on this context document element',
    'tests/flow-gate-verdicts.spec.ts':
      'browser-local fetch fixture installed before navigation',
    'tests/cross-runtime-chat-switching.spec.ts':
      'writes only the runner-supplied per-test observation artifact path',
    'tests/daily-driver-scenarios.spec.ts':
      'writes only the runner-supplied per-scenario observation artifact directory',
    'tests/daily-driver-switching.spec.ts':
      'browser-local page.route mocks installed through tests/helpers/daily-driver-shell.ts; no live-instance or child-process resources',
    'tests/activity-pane.spec.ts':
      'read-only against the isolated temp-home instance; the only write is this browser context’s own ambient dock document in localStorage, and every journey ends with the slot returned to Chat',
    'tests/dock-occupant-picker.spec.ts':
      'read-only against the isolated temp-home instance; the only writes are this browser context’s own ambient dock document in localStorage and a browser-local config/app route mock pinning the first-run fact',
  },
  parallelSafe: [
    'tests/command-palette.spec.ts',
    'tests/dialog-return-focus.spec.ts',
    'tests/banner-stack-bound.spec.ts',
    'tests/agent-editor-geometry.spec.ts',
    'tests/diagnostics-bundle.spec.ts',
    'tests/keyboard-shortcuts.spec.ts',
    'tests/sidebar-geometry.spec.ts',
    'tests/project-lifecycle.spec.ts',
    'tests/project-forms.spec.ts',
    'tests/project-architecture.spec.ts',
    'tests/mcp-ui-layout.spec.ts',
    'tests/default-agent-workflow.spec.ts',
    'tests/mobile-chat-composer.spec.ts',
    'tests/mobile-dock-clearance.spec.ts',
    'tests/accessibility-core.spec.ts',
    'tests/status-token-contrast.spec.ts',
    'tests/text-ramp-contrast.spec.ts',
    'tests/builtin-runtime-workflow.spec.ts',
    'tests/pending-message-queue.spec.ts',
    'tests/skills.spec.ts',
    'tests/registry.spec.ts',
    'tests/registry-install.spec.ts',
    'tests/connections-crud.spec.ts',
    'tests/credential-recovery-groups.spec.ts',
    'tests/ssh-environments-ui.spec.ts',
    'tests/connect-modal.spec.ts',
    'tests/connect-retry.spec.ts',
    'tests/connect-remote-auth-recovery.spec.ts',
    'tests/connect-reconnect-banner.spec.ts',
    'tests/plugin-update.spec.ts',
    'tests/schedule-runs.spec.ts',
    'tests/schedule.spec.ts',
    'tests/monitoring.spec.ts',
    'tests/orchestration-provider-picker.spec.ts',
    'tests/project-layout-render-storm.spec.ts',
    'tests/orchestration-chat-flow.spec.ts',
    'tests/acp-orchestration-plan.spec.ts',
    'tests/flow-gate-verdicts.spec.ts',
    'tests/veritas-readiness-panel.spec.ts',
    'tests/trust-panel.spec.ts',
    'tests/flow-run-console.spec.ts',
    'tests/orchestration-recovery.spec.ts',
    'tests/new-chat-provider-managed.spec.ts',
    'tests/new-chat-mobile-context-sheet.spec.ts',
    'tests/cross-runtime-chat-switching.spec.ts',
    'tests/daily-driver-scenarios.spec.ts',
    'tests/daily-driver-switching.spec.ts',
    'tests/coding-git-toolbar.spec.ts',
    'tests/diff-review-annotations.spec.ts',
    'tests/review-queue-comments.spec.ts',
    'tests/first-run-zero-provider.spec.ts',
    'tests/knowledge-onboarding.spec.ts',
    'tests/root-route-restore.spec.ts',
    'tests/task-first-home.spec.ts',
    'tests/activity-pane.spec.ts',
    'tests/dock-occupant-picker.spec.ts',
    'tests/connections-sections.spec.ts',
    'tests/connections-computers-ssh.spec.ts',
  ],
  sharedInstanceExclusive: [
    // E2E regression lane: every one of these seeds and reads LIVE
    // Station state (agents, skills, model connections) through the
    // authenticated API, because the claim under test is that the surface
    // renders the SERVER's answer rather than a fixture's.
    'tests/agents-readiness-board.spec.ts',
    // Seeds and deletes a live agent bound to a missing engine connection, and
    // opens a SECOND browser context whose credential is the runner's own
    // browser session — the one every other spec's cookie is.
    'tests/paired-device-presentation.spec.ts',
    'tests/agents-copy-existing.spec.ts',
    'tests/agents-editor-roundtrip.spec.ts',
    'tests/skills-command-surface.spec.ts',
    'tests/mobile-surface-sweep.spec.ts',
    'tests/device-pairing-mobile.spec.ts',
    // Pairs a browser context for real, then REVOKES that device through the
    // authenticated API mid-session — live server state no other spec may see
    // change under it.
    'tests/connection-lost-access-request.spec.ts',
    'tests/plugin-preview.spec.ts',
    // Creates and repairs one invalid plugin directory in the runner-owned
    // temporary home, then removes it and reloads before yielding the server.
    'tests/plugin-rejection-visibility.spec.ts',
    'tests/plugin-system.spec.ts',
    'tests/survey-review-workbench.spec.ts',
    'tests/fieldwork-review.spec.ts',
    'tests/plugin-dev-hot-reload.spec.ts',
    'tests/external-session-follow.spec.ts',
    'tests/builder-delivery-viewer.spec.ts',
    'tests/meeting-notes.spec.ts',
    'tests/knowledge-library.spec.ts',
    // Both drive the REAL API and mutate shared instance state — the agents
    // lane disables every LLM connection to prove the empty case, the skills
    // lane installs a command-enabled skill on the home. Neither can share an
    // instance with a sibling spec.
    'tests/agents-editor-gates.spec.ts',
    'tests/skills-command-routes.spec.ts',
    // D9 resets the whole notification store and acknowledges every pending
    // attention item to get a deterministic bell count; D8 creates, deletes
    // and re-creates two projects by fixed slug. Both are instance-wide
    // mutations no sibling spec can be running alongside.
    'tests/notifications-attention.spec.ts',
    'tests/board-visibility.spec.ts',
    // Work Board writes the personal revisioned board through the live API.
    // It cannot share that state with another product browser journey.
    'tests/work-board.spec.ts',
  ],
};

export const e2eManifest = [
  {
    path: 'tests/agents-readiness-board.spec.ts',
    bucket: 'product',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale:
      "UX audit E1 (reports/agents-lane/DESIGN.md §2/§5): the Agents rail as a readiness board against a live Station — the engines band above the authored band, a non-ready row printing the server's own unavailableReason verbatim with exactly one fixing verb mapped from unavailableFix.kind, and a Ready row whose Chat action opens the shared New Chat picker onto a real composer. The non-ready row is seeded by binding an agent to an engine connection that does not exist, so the state is an observation rather than a mocked string. Desktop plus a 390x844 variant asserting the same one verb, a 44px repair target and no horizontal document scroll.",
    exceptions: [],
  },
  {
    path: 'tests/paired-device-presentation.spec.ts',
    bucket: 'product',
    surface: 'System',
    tierTarget: 'full',
    primary: true,
    rationale:
      "station#3843 §4: the same three host-executing affordances driven in BOTH device classes against one live Station, from fixtures that prove their own class first — paired is the suite's default operator-credential context (never home possession by design), host presents the runner's direct-loopback browser session cookie alone. T1 the SSH creator's trust command is host-hands, so paired renders the instruction naming the host, the exact command and an ENABLED Copy control (never disabled, never hidden) while host keeps the bare affordance and names no machine; T2 the Agents row's engine setup is remote-safe, so both keep exactly ONE verb and only the accessible name gains 'on <hostName>'; T3 the Developer log read is remote-safe, so paired states where the full logs are and host renders no such sentence. The non-ready agent row is seeded through the authenticated API and the projection is the live server's; only the unknown-host probe evidence is supplied, because an unconfirmed host key is not reproducible on a runner. Desktop plus a 390x844 variant in each class, each asserting no horizontal document scroll.",
    exceptions: [],
  },
  {
    path: 'tests/connection-lost-access-request.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale:
      "station#3850: the per-row `Request access to <name>` affordance, on the device it is for — one that IS paired, HAS the shell, and whose connection lost access when the owner revoked it from another machine mid-session. device-pairing-mobile.spec.ts covers the OTHER scenario (an unpaired device never reaches the shell and is served by the onboarding gate) and its docblock says so; nothing covered this row. The premise is measured rather than trusted, because `connectionNeedsAccessRequest` correctly withholds this button for a connection whose credential still works and `recordAuthenticatedSuccess` clears the required state on the next accepted response (station#3753, one scenario over): the context pairs for real over the public endpoints, proves it reaches a protected route 200 with NO affordance rendered, and the revoke is proven from the server's own device record. It never reloads — a device with no working credential cannot rebuild the shell, so a reload lands on the gate and proves the opposite (measured) — and it asserts `main#station-main` is still attached, which is the one marker that separates shell from gate at every viewport. Desktop then drives the outcomes end to end: the blocked banner's action opens the connections dialog, the row requests, the owner DENIES and the refusal reaches the device naming the Station that refused it, the row survives its own refusal and is offered again, the owner APPROVES and the connection holds a device session once more. The 390x844 variant proves the surface only — the row renders and clears the 44px touch floor — because the public access-request endpoint admits 5 attempts per 60s PER PEER and every context of a local run is the same peer, so running the journey twice spends 6 and the second retry is refused with no request id (measured). storageState is explicitly empty so the suite-wide operator bearer cannot authenticate around the revoke.",
    exceptions: [],
  },
  {
    path: 'tests/agents-new-model-turn.spec.ts',
    bucket: 'smoke-live',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale:
      'UX audit E2 (DESIGN §4 "Run it on Station"): with no ready model connection the Create button is disabled and the inline "Add model connection" repair is offered instead of shot 17\'s after-submit validation error; with a local model fixture provisioned as the only enabled LLM connection, the journey creates the agent and completes a genuine assistant turn through the composer. Live because the turn dispatches through POST /api/orchestration/chat into a real model server. Desktop plus a 390x844 variant running the same real turn.',
    exceptions: [],
  },
  {
    path: 'tests/paired-device-chat.spec.ts',
    bucket: 'smoke-live',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'station#4537 item 1 (the #4518 journey): a device paired through the real public handshake (access-request -> operator confirm -> exchange, tests/helpers/live-station-task.ts pairBrowserDevice — never a mocked route, same handshake device-pairing-mobile.spec.ts proves) opens a chat and sends a real message through POST /api/orchestration/chat into a real local model server (ollama-fixture), and observes the streamed reply render in the transcript. Live because the whole point is proving the paired-device principal actually resolves end to end — the load-bearing assertion is that "Unable to resolve a principal" never renders anywhere in the flow, the exact shape #4518 broke.',
    exceptions: [],
  },
  {
    path: 'tests/pr-smoke-live-chat-send.spec.ts',
    bucket: 'smoke-live',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      "station#4537 item 2: the pr-smoke merge gate's own real send, inside its 10-minute/1-worker/0-retry budget — a lean, single-test journey that seeds a real model connection and agent, dispatches one turn through POST /api/orchestration/chat into a real local model server, and observes the reply render, without touching orchestration-chat-flow.spec.ts / cross-runtime-chat-switching.spec.ts's existing mocked SSE-render-state coverage. Listed in PR_BROWSER_SMOKE_CONTRACT.journeys — the audit's rule is that unlisted coverage reproduces the original finding.",
    exceptions: [],
  },
  {
    path: 'tests/chat-multi-turn-context.spec.ts',
    bucket: 'quarantine',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      "station#4537 item 3: multi-turn context retention, UNCOVERED anywhere per the flow-coverage audit. RED BY DESIGN, not spec rot — the source of truth here is the spec itself, and the spec disproves coverage rather than proving it: it sends two real turns through POST /api/orchestration/chat into a real local model server and reads the ollama-fixture onChat capture hook, and turn 2's own captured request body is missing turn 1's prompt and reply entirely (a server-side context read, not a client-side replay — the fixture answers identically both times, so the discriminating evidence is the captured request, not the response text). Quarantined rather than left in a running bucket: a spec that is supposed to fail cannot sit in smoke-live/verify:e2e:full without permanently redding the gate. It re-enters a running bucket once #574 (the defect it proves) is fixed.",
    exceptions: [],
    replacement: '#574',
  },
  {
    path: 'tests/agents-new-cli-turn.spec.ts',
    bucket: 'smoke-live',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale:
      'UX audit E3 (DESIGN §4 "Wrap an installed agent CLI"): Create stays disabled until the second radio list names a CLI — handleStartWithCli deliberately binds nothing — and the created agent then answers a real turn produced by the claude or codex binary on this machine. The engine is chosen from what /api/connections/agents reports ready, never guessed, and a host with neither installed fails rather than passing quietly. Desktop plus a 390x844 variant.',
    exceptions: [],
  },
  {
    path: 'tests/agents-new-muse-echo-turn.spec.ts',
    bucket: 'smoke-live',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale:
      "#550: muse was the one engine family with no create-an-agent-and-run-a-turn coverage, because the adapter never passed `--provider` and muse's default (`meta`) needs a live key and a network round trip. STATION_E2E_MUSE_PROVIDER=echo — set for this bucket's server in scripts/run-e2e-suite.mjs — runs each muse turn as `muse exec --provider echo`, muse's own key-less provider, so this is a real turn through the real binary and the real HTTP path with only the model replaced by one whose answer can be asserted. The agent is created through the CLI starting point against the muse connection /api/connections/agents reports READY (never guessed; a host that cannot run muse fails here rather than passing quietly, exactly as agents-new-cli-turn.spec.ts does). READY includes muse's AUTH prerequisite, so the precondition is an installed AND authenticated muse even though the echo turn itself needs no key, and the reply must carry the typed token AFTER an `echo:` prefix — a prefix only the echo provider emits, and an ordering that rules out the user's own composer bubble, which carries the same token. A `--provider` that never reached argv answers from `meta` or refuses for want of a key, and either way never prints `echo:`.",
    exceptions: [],
  },
  {
    path: 'tests/agents-copy-existing.spec.ts',
    bucket: 'product',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale:
      'UX audit E4 (DESIGN §4 "Copy an existing agent"): the clone is named "<original> copy" and carries the authored fields, and — the load-bearing half — carries NO execution.credentialProfileRef, proven by reading the persisted record through GET /api/agents/:slug after the create rather than by reading the form. The source is re-read afterwards so a copy that MOVED the binding cannot pass. Desktop plus a 390x844 variant.',
    exceptions: [],
  },
  {
    path: 'tests/agents-editor-roundtrip.spec.ts',
    bucket: 'product',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale:
      'UX audit E5 (DESIGN §3): a CLI-engine agent\'s editor renders §3.4 Model options and none of §3.3 — no Model heading, no model-connection picker, no "Add model connection" repair (Y2: nothing contradicts the chosen engine); a description edit round-trips through the PUT, the cleared pending state, a reload and a fresh API read; and at 390 the shared DetailHeader sticky footer keeps Save reachable and clickable at the bottom of a long form.',
    exceptions: [],
  },
  {
    path: 'tests/agent-editor-geometry.spec.ts',
    bucket: 'product',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale:
      'station#4521 items 1/3/4, pixel claims a real browser is required for: the "Agent actions" popover (real ResponsiveDialogSurface + the real agent-actions-overlay/agent-actions-panel CSS) opens directly below its "More actions" trigger rather than centered mid-screen — the un-anchored fallback the popover regressed to before this fix, since it carried anchorRef with no overlay/panel classes to spend that measurement; and dropping the caution AgentReadinessCell chip from the header title row genuinely frees enough width for the agent name to render unclipped ("Stati…" was a real measured overflow, reproduced here against the pre-fix shape for contrast, not assumed from the CSS text). jsdom performs no layout, so neither claim is falsifiable there. Same real-source-bundled-with-esbuild technique as dialog-return-focus.spec.ts/banner-stack-bound.spec.ts, with the real editor-layout.css/DetailHeader.css/EngineChip.css/AgentReadinessCell.css and Console Kit StatusBadge styles attached as actual stylesheets; no live instance or server.',
    exceptions: [],
  },
  {
    path: 'tests/skills-command-surface.spec.ts',
    bucket: 'product',
    surface: 'Guidance',
    tierTarget: 'full',
    primary: true,
    rationale:
      'UX audit E6, against a REAL skills API rather than the page.route fixtures tests/skills.spec.ts uses: turning "Runnable as a slash command" on puts /<command> in the chat composer\'s own selector (the surface useSlashCommands builds from the live catalogue), and a command word nobody can type is refused with the naming rule said out loud instead of the editor going on advertising it. Desktop plus a 390x844 variant.',
    exceptions: [],
  },
  {
    path: 'tests/mobile-surface-sweep.spec.ts',
    bucket: 'product',
    surface: 'Shell',
    tierTarget: 'full',
    primary: true,
    rationale:
      'UX audit E8: one parametrised 390x844 sweep over EVERY route src-ui/src/app-shell/surface-registry.ts declares — no horizontal document scroll on each, and the shared SplitPaneLayout detail-sheet contract ("← Back to list", list hidden, Back restores it) on the split-pane surfaces, whose lists are seeded so an empty rail cannot pass as coverage. The route list is checked against the registry source, so a surface added without a decision about its phone behaviour reds this spec instead of shipping unswept.',
    exceptions: [],
  },
  {
    path: 'tests/csp-shell.spec.ts',
    bucket: 'smoke-live',
    surface: 'Shell security',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Boots the production-built UI through the lifecycle static server, proves nonce CSP enforcement without browser violations, and opens Connection recovery.',
    exceptions: [],
  },
  {
    path: 'tests/plugin-bundle-csp.spec.ts',
    bucket: 'smoke-live',
    surface: 'Shell security',
    tierTarget: 'full',
    primary: true,
    rationale:
      'station#4287: exercises the shell CSP rather than asserting its header string. Serves the production-built UI through the lifecycle static server with the real bootstrap derivation, proves no nonce carrier is reachable from page code (window global, script .nonce IDL, nonce attribute), and proves a remote script minted from what page code CAN scrape is refused by script-src — paired with a control that lifts the nonce out of the response header and shows the same remote script then executes, so the refusal is the leak being closed and not a URL the policy would have refused anyway. Also proves the API-base bootstrap both runs and removes its own nonce-bearing element. jsdom enforces no CSP and never loads an external script, so this is only falsifiable in a real browser.',
    exceptions: [],
  },
  {
    path: 'tests/command-palette.spec.ts',
    bucket: 'product',
    surface: 'Shell',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Global ⌘K command palette: open via keybind, fuzzy filter, Enter navigates, Esc closes.',
    exceptions: [],
  },
  {
    path: 'tests/dialog-return-focus.spec.ts',
    bucket: 'product',
    surface: 'Core accessibility',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Real-browser focus semantics for dialog return focus: a collapsed surviving ancestor refuses focus and the walk falls through, an open follow-up dialog keeps focus, and a surviving trigger is restored untouched. jsdom reports a hidden .focus() as successful, so station#1206 gap 2 is only falsifiable here. station#1245 adds the real ConnectionManagerModalContent from packages/connect falling back past an inert survivor — the only place the cross-package wiring is exercised in a real bundle.',
    exceptions: [],
  },
  {
    path: 'tests/diagnostics-bundle.spec.ts',
    bucket: 'product',
    surface: 'Settings',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Diagnostics bundle download, dated filename, canonical failure state, and retry behavior.',
    exceptions: [],
  },
  {
    path: 'tests/keyboard-shortcuts.spec.ts',
    bucket: 'product',
    surface: 'Shell',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Global ⌘/ shortcuts cheatsheet: opens, derives friendly categories + kbd hints from the registry, Esc closes.',
    exceptions: [],
  },
  {
    path: 'tests/sidebar-geometry.spec.ts',
    bucket: 'product',
    surface: 'Shell',
    tierTarget: 'full',
    primary: true,
    rationale:
      "#1629: real-browser getBoundingClientRect() proof that the project row chevron centers on its button (not the whole row) in both the default and expanded-with-layouts states, and that the desktop header keeps a single logo+brand-name lockup with the collapse button pushed to the header's right edge on both the plain and macOS-inset shells. jsdom cannot compute real layout, so this positioning claim is only falsifiable here.",
    exceptions: [],
  },
  {
    path: 'tests/project-lifecycle.spec.ts',
    bucket: 'product',
    surface: 'Projects',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted project lifecycle lane.',
    exceptions: [],
  },
  {
    path: 'tests/project-forms.spec.ts',
    bucket: 'product',
    surface: 'Projects',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Promoted project create/edit form lane, including 320px and 390px visual-viewport keyboard containment.',
    exceptions: [],
  },
  {
    path: 'tests/project-architecture.spec.ts',
    bucket: 'product',
    surface: 'Projects',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted project layout and architecture lane.',
    exceptions: [],
  },
  {
    path: 'tests/activity-pane.spec.ts',
    bucket: 'product',
    surface: 'Activity',
    tierTarget: 'full',
    primary: true,
    rationale:
      "Epic station#4142 M3 (station#3193): /activity is the STANDALONE PLACEMENT of the Activity Workspace Pane — the sessions surface reached through the pane path, which is what puts a real 'Dock this pane' in the page header's actions slot. The journey docks Activity into the ambient slot (the dock-slot section labeled 'Activity dock'), proves the choice survives a reload through the persisted ambient document (localStorage carries pane:builtin:activity), and returns the slot to Chat from the dock-slot header, with Chat back as a direct shell child. Every assertion names an affordance that must exist, so the route silently ceasing to produce the pane occurrence fails by name. Desktop plus a 390x844 isMobile variant asserting no horizontal document scroll before and after docking and a 44px return-to-Chat target.",
    exceptions: [],
  },
  {
    path: 'tests/dock-occupant-picker.spec.ts',
    bucket: 'product',
    surface: 'Activity',
    tierTarget: 'full',
    primary: true,
    rationale:
      "Epic station#4142 M5 (station#4090): the dock-slot header's fixed return-to-Chat action is replaced by an occupant picker whose menu is the ambient admission DERIVATION ({Chat, Home, Activity}, by descriptor name, current occupant checked), and route placements render an away state while their pane occupies the dock. The journeys pin the transition most likely to be wrong (choosing Activity clears the Home away state on `/`), the 'Bring it back here' return path (route pane back, dock back to Chat), the menu opening UPWARD within the viewport on a bottom dock (measured box — Playwright calls an off-screen menu visible), and a 390x844 isMobile variant asserting no horizontal scroll and 44px trigger/menu-item tap targets. Every assertion names an affordance that must exist, so a curated menu, a resurrected fixed Chat action, or a stuck away state fails by name.",
    exceptions: [],
  },
  {
    path: 'tests/mcp-ui-layout.spec.ts',
    bucket: 'product',
    surface: 'Projects',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Proof that mixed builtin/plugin-compatible and MCP UI layout tabs render and preserve navigation, including the dedicated frame-origin (allow-same-origin) render path.',
    exceptions: [],
  },
  {
    path: 'tests/mcp-ui-host-bridge.spec.ts',
    bucket: 'extended',
    surface: 'Projects',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Proves the MCP-UI host bridge handshake end to end: a real ext-apps App View client initializes and resizes the sandboxed iframe via size-changed.',
    exceptions: [],
  },
  {
    path: 'tests/mcp-ui-host-security.spec.ts',
    bucket: 'extended',
    surface: 'Projects',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Proves the MCP-UI host contains a hostile View: spoofed-source messages rejected, undeclared-domain fetch blocked by CSP, cross-origin escape contained, read-only tool call denied before the proxy.',
    exceptions: [],
  },
  {
    path: 'tests/plugin-host-security.spec.ts',
    bucket: 'extended',
    surface: 'Plugins',
    tierTarget: 'full',
    primary: true,
    rationale:
      "Proves remote plugin bundles execute only through the isolated plugin host: hostile storage, DOM, parent-global, network, bridge, and spoofed-message attacks remain contained; mismatched declared exports visibly fail; and a benign bundle raising the pane-host contract's confirm intent is answered by Station's own modal, with the decision reaching the frame back across the boundary on desktop and at 390x844.",
    exceptions: [],
  },
  {
    path: 'tests/default-agent-workflow.spec.ts',
    bucket: 'product',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted default agent workflow lane.',
    exceptions: [],
  },
  {
    path: 'tests/mobile-chat-composer.spec.ts',
    bucket: 'product',
    surface: 'Chat',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Deterministic 320px/390px mobile task-switcher, visual-viewport, composer, scroll-anchor, model/session preservation, restore, and desktop parity lane.',
    exceptions: [],
  },
  {
    path: 'tests/mobile-dock-clearance.spec.ts',
    bucket: 'product',
    surface: 'Shell',
    tierTarget: 'full',
    primary: true,
    rationale:
      "station#3902: the chat dock is shell chrome, so the shell's route outlet reserves what the dock actually occupies — its published height PLUS the device safe area and the visible-viewport inset it re-anchors to. At 390x844 with a 34px bottom inset the shell used to stop reserving 34px above the rendered bar, and --layer-dock took every tap in that band; the witness is /connections/models/new, where the last provider tile's centre hit-tested to the dock's resize handle. Sets --safe-bottom explicitly because headless Chromium's env(safe-area-inset-bottom) is always 0 and the spec would otherwise pass on the broken build.",
    exceptions: [],
  },
  {
    path: 'tests/accessibility-core.spec.ts',
    bucket: 'product',
    surface: 'Core accessibility',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Serious/critical Axe gate, seeded negative control, and real-browser keyboard focus, trap, Escape, restoration, and navigation semantics for core journeys.',
    exceptions: [],
  },
  {
    path: 'tests/status-token-contrast.spec.ts',
    bucket: 'product',
    surface: 'Core accessibility',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Composited two-theme contrast for the semantic status token families — error/danger and success — plus the painted-fill assertion that catches a status token going undefined (station#1125/#1167/#1168/#1246), and the fifteen surfaces station#1254 converted off custom properties no rule declares, each measured against a sentinel host colour so a rule that stops matching cannot pass by inheriting body copy.',
    exceptions: [],
  },
  {
    path: 'tests/text-ramp-contrast.spec.ts',
    bucket: 'product',
    surface: 'Core accessibility',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Composited two-theme contrast for the neutral text ramp (primary/secondary/tertiary) and the two shared chrome rules that carry it — .engine-chip__pill, which failed 1.4.3 at 10px in both themes (station#3140), and .button--link, pinned while passing because its 0.17 light-theme margin rests on a vendor brand token this repo does not own. Each probe mounts the real shipped class against a sentinel host colour, so a rule that stops matching fails instead of passing by inheriting body copy.',
    exceptions: [],
  },
  {
    path: 'tests/builtin-runtime-workflow.spec.ts',
    bucket: 'product',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted built-in runtime workflow lane.',
    exceptions: [],
  },
  {
    path: 'tests/pending-message-queue.spec.ts',
    bucket: 'product',
    surface: 'Chat',
    tierTarget: 'full',
    primary: true,
    rationale:
      '#613: proves mid-turn queue reorder, inline edit, and boundary drain (in the reordered order) for a runtime chat session via the mock orchestration SSE harness.',
    exceptions: [],
  },
  {
    path: 'tests/skills.spec.ts',
    bucket: 'product',
    surface: 'Skills',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Promoted Skills lane — the ONLY guidance-authoring lane now that playbooks are skills (the playbooks/prompts lanes were deleted with the surface). Covers skill CRUD and source labelling, plus command skills: the command switch pair writing through to the Commands catalogue and the filtered list (CAT-R09), the derived variable chips and read counters, the test run opening the dock and incrementing the run count, a read-only skill being offered the install action instead of a switch that would 409, and the retired /playbooks path landing on the Skills tab.',
    exceptions: [],
  },
  {
    path: 'tests/registry.spec.ts',
    bucket: 'product',
    surface: 'Registry',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted registry browse lane.',
    exceptions: [],
  },
  {
    path: 'tests/registry-install.spec.ts',
    bucket: 'product',
    surface: 'Registry',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted registry install lane.',
    exceptions: [],
  },
  {
    path: 'tests/bundled-plugin-registry-lifecycle.spec.ts',
    bucket: 'smoke-live',
    surface: 'Registry and Projects',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Live bundled Registry install, persisted installed state, project Add Layout/use, unavailable-component recovery after uninstall, reinstall, and 390x844 overflow proof.',
    exceptions: [],
  },
  {
    path: 'tests/connections-crud.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Connections CRUD plus Agent app discovery hit, miss, Add-catalog placement, and Model-only first-run honesty.',
    exceptions: [],
  },
  {
    path: 'tests/credential-recovery-groups.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Mocked desktop and narrow credential-profile management journey: manual-first enrollment, explicit import, confirmation-gated adoption, rollback, and unsupported fail-closed behavior.',
    exceptions: [],
  },
  {
    path: 'tests/ssh-environments-ui.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Desktop SSH environment setup plus mobile keyboard containment, observe, stop, resume, and credential-safe rendering.',
    exceptions: [],
  },
  {
    path: 'tests/connections-sections.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale:
      "Connections IA lane for the five-section frame (connection-sections.ts + ConnectionsSectionFrame.tsx): the /connections resolver and legacy-path (/connections/providers, /connections/acp) redirects into their owning section, every section's own H1 + Connections eyebrow + exactly one add action (desktop and 390x844, plus a no-horizontal-scroll proof per section at 390), the Models Add-provider-then-Test-Connection journey rendering the server's own failure sentence (never the mock object), the Tools built-in-vs-user-server distinction (Built in tag with no Delete vs a real Delete control), and the Engines list's vocabulary - an engine named by its own name rather than its type slug, and its catalogue read as a sentence rather than an enum (station#3739).",
    exceptions: [],
  },
  {
    path: 'tests/agents-editor-gates.spec.ts',
    bucket: 'product',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale:
      "The three gate facts no sibling Agents spec can see, against the real API rather than mocked routes: the Create gate and the model picker giving ONE answer with the connections query deliberately delayed past the starting-point click, which is the state-dependent disagreement station#3743 records; the required system prompt marked and gating Create instead of refusing after submit (station#3741); and an unavailable engine named rather than identified by its connection id (station#3742). agents-new-model-turn owns the ready-connection wait and its inline repair, agents-editor-roundtrip the mobile sticky footer, agents-readiness-board the rail's readiness sentence.",
    exceptions: [],
  },
  {
    path: 'tests/skills-command-routes.spec.ts',
    bucket: 'product',
    surface: 'Guidance',
    tierTarget: 'full',
    primary: true,
    rationale:
      'What a command-enabled skill does to the REST of the app, against the REAL skills API: /agents, /connections and /guidance each still rendering their own view rather than the error boundary (station#3736 - tests/skills.spec.ts performs the same toggle and stays green because it mocks the skills endpoints, so the registrar never sees one), desktop and 390x844. skills-command-surface owns the composer and the refused command word.',
    exceptions: [],
  },
  {
    path: 'tests/connections-computers-ssh.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale:
      "Add-a-computer SSH branch (AddMachineModal.tsx + SshComputerCreatorDialog.tsx, D7/CI-R1/CI-R14/CI-R19): the goal chooser offers all three options, a failing POST /api/environments/ssh/probe renders both the server's summary and action together in a role=alert, Save computer stays disabled until reachable:true, the pre-test disclosure copy is present beforehand, and a reachable probe both enables Save and, once saved, surfaces the new computer in the list. Desktop plus a 390x844 variant proving the dialog stays within the viewport.",
    exceptions: [],
  },
  {
    path: 'tests/connect-modal.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted connection modal lane.',
    exceptions: [],
  },
  {
    path: 'tests/connect-retry.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: false,
    rationale:
      'Unreachable-host recovery: the error screen must offer a real retry (not only navigation), and a slow connect must name the host it is waiting on rather than showing an indefinite bare spinner.',
    exceptions: [],
  },
  {
    path: 'tests/connect-remote-auth-recovery.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Remote Station recovery: public handshake, stable environment identity, masked credential entry, authenticated status/plugin/coding reads with a zero-unexpected-401 assertion, endpoint migration, and mobile safety.',
    exceptions: [],
  },
  {
    path: 'tests/device-pairing-mobile.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Two-context mobile pairing through accessible manual entry, explicit host confirmation, persistent HttpOnly browser sessions across restart, credential secrecy, device inventory, and revocation.',
    exceptions: [],
  },
  {
    path: 'tests/container-self-host.spec.ts',
    bucket: 'extended',
    surface: 'Self-hosted container',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Repository smoke script runs this against the production Compose image to prove same-origin authenticated workspace reads; it is skipped outside that explicit container lane.',
    exceptions: [],
  },
  {
    path: 'tests/connect-reconnect-banner.spec.ts',
    bucket: 'product',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted connection reconnect banner lane.',
    exceptions: [],
  },
  {
    path: 'tests/banner-stack-bound.spec.ts',
    bucket: 'product',
    surface: 'Shell',
    tierTarget: 'full',
    primary: true,
    rationale:
      'station#3432: proves in a real browser that the collapsed connectionBlocking band and the expanded banner stack actually overflow and scroll (scrollHeight > clientHeight, a real wheel event moves scrollTop, the last control stays hit-testable at its own center) rather than silently compressing content to fit — a gap jsdom cannot see, since mobile-chrome-safety.test.ts can only confirm the CSS text declares max-height/overflow-y/pointer-events, never that they engage. Same real-source-bundled-with-esbuild technique as dialog-return-focus.spec.ts, with the real BannerHost.css attached as an actual stylesheet.',
    exceptions: [],
  },
  {
    path: 'tests/plugin-update.spec.ts',
    bucket: 'product',
    surface: 'Plugins',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted plugin update lane.',
    exceptions: [],
  },
  {
    path: 'tests/plugin-rejection-visibility.spec.ts',
    bucket: 'product',
    surface: 'Plugins',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Proves the rejected-manifest row, exact recovery copy, and repair/reload transition in the real Plugins surface.',
    exceptions: [],
  },
  {
    path: 'tests/plugin-preview.spec.ts',
    bucket: 'product',
    surface: 'Plugins',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted plugin preview lane.',
    exceptions: [],
  },
  {
    path: 'tests/plugin-system.spec.ts',
    bucket: 'product',
    surface: 'Plugins',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted plugin system lane.',
    exceptions: [],
  },
  {
    path: 'tests/survey-review-workbench.spec.ts',
    bucket: 'product',
    surface: 'Plugins',
    tierTarget: 'full',
    primary: true,
    rationale:
      'S2 vertical-as-a-plugin proof: Survey Review Workbench layout renders, review actions persist per project, and projection writes a Surface trust bundle.',
    exceptions: [],
  },
  {
    path: 'tests/fieldwork-review.spec.ts',
    bucket: 'product',
    surface: 'Plugins',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Project-confined Fieldwork application-plugin launch, trusted server approval, responsive host controls, and sandboxed capability review frame.',
    exceptions: [],
  },
  {
    path: 'tests/plugin-dev-hot-reload.spec.ts',
    bucket: 'product',
    surface: 'Plugins',
    tierTarget: 'full',
    primary: true,
    rationale:
      'P2-G1 proof that a generated plugin runs in plugin dev and browser hot reloads after source edits.',
    exceptions: [],
  },
  {
    path: 'tests/schedule-runs.spec.ts',
    bucket: 'product',
    surface: 'Schedule',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted schedule run history lane.',
    exceptions: [],
  },
  {
    path: 'tests/schedule.spec.ts',
    bucket: 'product',
    surface: 'Schedule',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Hermetic schedule CRUD lane covering add, edit, duplicate, run, filter, toggle, and delete.',
    exceptions: [],
  },
  {
    path: 'tests/monitoring.spec.ts',
    bucket: 'product',
    surface: 'Monitoring',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted monitoring shell lane.',
    exceptions: [],
  },
  {
    path: 'tests/orchestration-provider-picker.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted orchestration provider picker lane.',
    exceptions: [],
  },
  {
    path: 'tests/project-layout-render-storm.spec.ts',
    bucket: 'product',
    surface: 'Projects / Layout',
    tierTarget: 'full',
    primary: true,
    rationale:
      'station#3781 render-storm ceiling: the settled project-layout route must stop committing.',
    exceptions: [],
  },
  {
    path: 'tests/orchestration-chat-flow.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted orchestration chat flow lane.',
    exceptions: [],
  },
  {
    path: 'tests/external-session-follow.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Isolated Claude JSONL follow: discover after startup, open the canonical read-only transcript, observe an append without reload, reject direct mutation, and prove 320px containment.',
    exceptions: [],
  },
  {
    path: 'tests/acp-orchestration-plan.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      '#149 ACP chats on the orchestration surface: mocked end-to-end turn render, typed plan.updated live-update, and _kiro.dev OAuth extension.notification clickable auth link.',
    exceptions: [],
  },
  {
    path: 'tests/flow-gate-verdicts.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale: 'Flow-gated session verdict cards and run-attached marker.',
    exceptions: [],
  },
  {
    path: 'tests/veritas-readiness-panel.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Veritas merge readiness panel in the coding layout with why-detail.',
    exceptions: [],
  },
  {
    path: 'tests/trust-panel.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'S2 Surface trust panel: project trust bundles render as a trust report with claim summary, evidence drill-down, and transparency gaps in the coding layout.',
    exceptions: [],
  },
  {
    path: 'tests/flow-run-console.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'S2 Flow run console: builtin layout component renders all project Flow runs with gate outcomes, expectations, evidence, and report paths.',
    exceptions: [],
  },
  {
    path: 'tests/builder-delivery-viewer.spec.ts',
    bucket: 'product',
    surface: 'Plugins',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Serial live plugin install proves Builder artifacts render read-only and workspace bytes remain unchanged.',
    exceptions: [],
  },
  {
    path: 'tests/orchestration-recovery.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted orchestration recovery lane.',
    exceptions: [],
  },
  {
    path: 'tests/new-chat-provider-managed.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale: 'Promoted provider-managed new chat lane.',
    exceptions: [],
  },
  {
    path: 'tests/new-chat-mobile-context-sheet.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'kontourai/station#689 — proves the New Chat workspace picker renders as a contained bottom sheet (not the clipped anchored dropdown) at 390x844, and covers open, scroll, filter, pick, outside-tap, and Escape dismissal.',
    exceptions: [],
  },
  {
    path: 'tests/cross-runtime-chat-switching.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      "P1-G5 packaged proof for managed, connected Claude/Codex, ACP, conversation, agent, and project switching. kontourai/station#793 adds desktop-anchored-popover and mobile-edge-sheet coverage for the chat-dock project switcher (ChatDockProjectSwitcherSheet), reusing this spec's Alpha/Beta project fixtures.",
    exceptions: [],
  },
  {
    path: 'tests/daily-driver-scenarios.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'kontourai/station#3307/#3912 daily-driver qualification producer: liveness-settlement (a settled turn stays settled across a same-tab resume with one answer rendering, and one stream failure renders on exactly one surface — both halves probe-proven against the pre-station#3330 bundle, so this nets station#3300 and station#3299; a single-symbol revert of isTurnStreamLive alone does not reproduce, the suppression being over-determined — probe it historically, see the spec header), conversation-agreement (three completed turns in one durable Conversation over three distinct terminal execution Sessions; semantic continuation through the Conversation resolver under either canonical HTTP spelling; context carry-over; persisted lineage rebuilt only from a browser-owned durable snapshot after clearing in-memory maps; exactly-once turn-3 reload; raw terminal-Session reuse negative control), transcript-stability (10k-turn restore inside the documented ≤200 mounted-row budget with measured restore samples), and performance-stress (stream-while-scrolled-up, task switch mid-stream, queue drain, delta-to-paint samples) against a deterministic engine-shaped dispatch backend. Writes the bounded scenario observation artifact scripts/daily-driver-scenario-qualification.mjs ingests; real Hono/OrchestrationService/SQLite lifecycle is independently pinned by conversation-agreement.qualification.test.ts.',
    exceptions: [],
  },
  {
    path: 'tests/daily-driver-switching.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      "kontourai/station#3307/#618 mid-conversation switching: the composer model picker's per-turn override carries through dispatch and is reported by the switched turn's TurnProvenanceCard via the real shared provenance fold; completed-turn fork proves explicit replay-only cursor/tool/approval disclosure, same-provider idempotent retry then independent divergence with the parent retained, and alternate-Agent replay fallback opening the returned durable child. Agent handoff remains the linear Continue-with path with its own durable boundary disclosure.",
    exceptions: [],
  },
  {
    path: 'tests/ui-crud-smoke.spec.ts',
    bucket: 'smoke-live',
    surface: 'Live Smoke',
    tierTarget: 'smoke',
    primary: true,
    rationale: 'Real temp-home CRUD smoke for launcher/server/UI wiring.',
    exceptions: [],
  },
  {
    path: 'tests/knowledge-onboarding-smoke.spec.ts',
    bucket: 'smoke-live',
    surface: 'Knowledge',
    tierTarget: 'full',
    primary: true,
    rationale:
      "K4 AC1-coldstart-root + AC2-adoption-walk Obsidian slice: real temp-home backend, no route mocking — single-click personal knowledge-store creation confirmed via the live Settings UI and a direct /api/knowledge/roots fetch, plus validate-then-connect against a real filesystem Obsidian-shaped vault fixture and the adapter's honest empty-directory failure reason.",
    exceptions: [],
  },
  {
    path: 'tests/task-workspace.spec.ts',
    bucket: 'smoke-live',
    surface: 'Durable Tasks',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Real isolated Station lifecycle proof for durable Task workspace binding, inline local references and diff inspection, Direct/Deliver/Learn/Operate authority and unavailable-state boundaries (including hostile owner-shaped metadata), task switching isolation, plus a real Ollama-generated project answer pinned through the keyboard-safe Task basis UI and reopened after same-home restart.',
    exceptions: [],
  },
  {
    path: 'tests/task-answer-support.spec.ts',
    bucket: 'extended',
    surface: 'Durable Tasks / Answer support',
    tierTarget: 'full',
    primary: false,
    rationale:
      'Routed Task answer and explicitly pinned-input data against the real built Task workspace DOM: exact Surface card projection, protected-input revocation/error withholding, dialog tuple/focus behavior, 390px overflow containment, and serious/critical accessibility scan.',
    exceptions: [],
  },
  {
    path: 'tests/basis-mcp-interop.spec.ts',
    bucket: 'extended',
    surface: 'Basis / MCP Apps interoperability',
    tierTarget: 'full',
    primary: false,
    rationale:
      'Real station-control tool/resource and bounded owner read session exercised through an independent official MCP Apps host, including Surface semantics, continuation, revocation and no protected App fetch.',
    exceptions: [],
  },
  {
    path: 'tests/session-inventory-mcp-interop.spec.ts',
    bucket: 'extended',
    surface: 'Session inventory / MCP Apps interoperability',
    tierTarget: 'full',
    primary: false,
    rationale:
      'Real Station session-inventory tool/resource and bounded owner projection through an independent official MCP Apps host: host theme, compact/full and group selection, exact opaque page capability rotation, terminal removal, fail-closed malformed metadata, Basis reuse, hostile metadata inertness, and no protected App fetch.',
    exceptions: [],
  },
  {
    path: 'tests/project-task-room-collaboration.spec.ts',
    bucket: 'smoke-live',
    surface: 'Project/Task room collaboration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Real isolated Station and paired-device two-browser proof for shared Task-room join/announce/presence, watch/follow and local-input stop, revision-bound cursor/selection projection and restart expiry, message/document SSE convergence, revocation to cached read-only UI, revision links, and same-home SQLite restart restoration. Agent-authored edit attribution remains explicitly NOT_VERIFIED because this lane has no real associated agent-session dispatch fixture.',
    exceptions: [],
  },
  {
    path: 'tests/interactive-workspace-performance-bridge.spec.ts',
    bucket: 'smoke-live',
    surface: 'Interactive workspace performance reference bridge',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Workflow-owned isolated diagnostic Station proof with independent paired browser contexts, exact 100k-line corpus/FilePreview/scroll/Diff marks, canonical 10k retained replay versus beyond-window fallback, and Work Board fixture dispatch. Until the pane registers the stable restore/resolution/pointer bridge, Work Board observations remain explicitly NOT_VERIFIED; its scheduled lane cannot turn a short smoke into one-hour evidence.',
    exceptions: [],
  },
  {
    path: 'tests/acp-project-context.spec.ts',
    bucket: 'extended',
    surface: 'Agents',
    tierTarget: 'full',
    primary: true,
    rationale:
      'ACP project context is primary but needs promotion review after agent ACP lane hardening.',
    exceptions: [],
  },
  {
    path: 'tests/coding-git-toolbar.spec.ts',
    bucket: 'product',
    surface: 'Coding',
    tierTarget: 'full',
    primary: true,
    rationale:
      'In-app git branch toolbar: lists branches, switches branch (checkout), and reflects the new branch in the coding layout. Also covers multi-repo awareness — discovering repos under a non-repo workspace and switching the active repo.',
    exceptions: [],
  },
  {
    path: 'tests/coding-layout-plan-panel.spec.ts',
    bucket: 'extended',
    surface: 'Projects',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Coding layout plan panel is a product workflow pending product-bucket promotion review.',
    exceptions: [],
  },
  {
    path: 'tests/diff-review-annotations.spec.ts',
    bucket: 'product',
    surface: 'Coding',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Diff review annotations: DiffPanel renders a parsed diff, fetches project diff-comments, and renders a seeded comment inline via the @pierre/diffs annotation slot.',
    exceptions: [],
  },
  {
    path: 'tests/review-queue-comments.spec.ts',
    bucket: 'product',
    surface: 'Review Queue',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Review queue surfaces diff comments: the queue fetches the cross-project /api/diff-comments feed, lists a seeded comment, and opens its detail with a Resolve action.',
    exceptions: [],
  },
  {
    path: 'tests/core-update.spec.ts',
    bucket: 'extended',
    surface: 'Settings',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Core update is routed product behavior pending promotion review.',
    exceptions: [],
  },
  {
    path: 'tests/project-context-path.spec.ts',
    bucket: 'extended',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      "#304 regression guard: the dock project-context path's rtl start-truncation must not bidi-reorder leading `~`/`/` glyphs; asserts per-character visual order via Range rects, which only a real browser can see.",
    exceptions: [],
  },
  {
    path: 'tests/dock-mode-preference.spec.ts',
    bucket: 'extended',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Dock mode preference is primary but still has timing waits to remove before product promotion.',
    exceptions: ['waitForTimeout'],
  },
  {
    path: 'tests/session-attention-compact-viewport.spec.ts',
    bucket: 'extended',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'station#1170 review HIGH #1 regression guard: the needs_input session-detail attention answer form must stay genuinely CSS-visible (getComputedStyle + bounding box, not just DOM-present) once the compact-viewport/keyboard-open media query engages — a real-browser check because jsdom cannot see a display:none regression here.',
    exceptions: [],
  },
  {
    path: 'tests/attention-inbox-gates.spec.ts',
    bucket: 'extended',
    surface: 'Notifications',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Gate items (route-back/blocked/exception-pending) in the attention inbox are primary routed behavior pending promotion review.',
    exceptions: [],
  },
  {
    path: 'tests/notifications-attention.spec.ts',
    bucket: 'product',
    surface: 'Notifications',
    tierTarget: 'full',
    primary: true,
    rationale:
      "UX audit D9 (reports/board-notifications-lane/DESIGN.md): one approval-request and one info notification, both POSTed through the live API, land in the two regions the SERVER's attention projection puts them in — the bell badge is the attention count and only that, and the bulk action empties the attention queue while the activity log stays at exactly the count the page's own receipt read before it (the 6-OPS-29 assertion the deleted \"Clear notifications\" inverted). The inbox is reset to a proven-empty baseline first, so a sibling spec's leftovers cannot supply the count. station#3779 adds the corrected row-action case: `DELETE /notifications/:id` is a DISMISSAL, not a deletion — it answers 200, the record stays in `GET /notifications` with `status: 'dismissed'`, the row stays on the page, and what goes is its action. That case exists to keep the next reader from re-deriving \"delete\" from the HTTP verb. Desktop plus a 390x844 variant asserting stacked regions, a 44px row action and no horizontal document scroll.",
    exceptions: [],
  },
  {
    path: 'tests/work-board.spec.ts',
    bucket: 'product',
    surface: 'Workspace Pane / Work Board',
    tierTarget: 'full',
    primary: true,
    rationale:
      'station#3806 real browser journey: Project add-pane admission, all-kind references, pointer and keyboard geometry, title/camera, exact missing-only cleanup, undo, and reload persistence through the real board routes.',
    exceptions: [],
  },
  {
    path: 'tests/board-visibility.spec.ts',
    bucket: 'product',
    surface: 'Board',
    tierTarget: 'full',
    primary: true,
    rationale:
      "UX audit D8 (reports/board-notifications-lane/DESIGN.md): the Board exists for a project only when the SERVER knows of a Builder run for it. Two projects identical but for one real .kontourai/flow-agents/<task>/state.json in their working directories, each given a layout so the sidebar's layout strip renders either way — the no-run project's /session-board route redirects to the project page carrying D8's own sentence and offers no Board entry beside its other layout, the with-run project keeps the route and adopts the PageFrame header (title Board, subtitle the project name). station#3776: the '1 item in flight' receipt is asserted to appear EXACTLY ONCE, from Console Kit's own .board-receipt, with the frame's action cell no longer printing a second copy of the same number. station#3777: the 390 variant asserts the shared 'Flow stages' tab strip names every column the horizontal scroller hides, each tab a 44px target, and that the board lands scrolled to the first POPULATED column rather than on an empty BACKLOG — the document-scroll check alone passes while the only column with a card is off-screen. Both halves read GET operating-state/availability first, so a broken fixture fails loudly instead of passing the negative half for the wrong reason. Desktop plus a 390x844 variant.",
    exceptions: [],
  },
  {
    path: 'tests/notifications-inbox.spec.ts',
    bucket: 'extended',
    surface: 'Notifications',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Notifications inbox is primary routed behavior pending promotion review.',
    exceptions: [],
  },
  {
    path: 'tests/notifications.spec.ts',
    bucket: 'extended',
    surface: 'Notifications',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Notifications flow is primary routed behavior pending promotion review.',
    exceptions: [],
  },
  {
    path: 'tests/web-push-subscribe.spec.ts',
    bucket: 'extended',
    surface: 'Notifications',
    tierTarget: 'full',
    primary: true,
    rationale:
      'station#614: Web Push subscribe/unsubscribe from the Notifications settings section — mocked Notification/PushManager in-page, proves the subscribe request carries the device credential and that unsubscribing stops further subscribe attempts (stubbed call counters). Extended pending product-bucket promotion review, matching the sibling Notifications lanes.',
    exceptions: [],
  },
  {
    path: 'tests/first-run-zero-provider.spec.ts',
    bucket: 'product',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      '#191 R1: zero-provider first run ends at a guided chat empty-state CTA to Connections -> Models, never a raw HTTP/Error bubble.',
    exceptions: [],
  },
  {
    path: 'tests/first-run-live.spec.ts',
    bucket: 'first-run',
    surface: 'First Run',
    tierTarget: 'full',
    primary: true,
    rationale:
      '#196 + UX audit RT-02: a dedicated temp-home Station suite. The desktop test is the un-intercepted first-run journey — a home this run created reports firstRun:pending, the guided chapter opens on Home, and deferring it writes firstRun:skipped that survives a reload. The mobile test proves the 390x844 journey from zero-provider guidance through a real persisted Ollama-compatible connection to a streamed first reply.',
    exceptions: [],
  },
  {
    path: 'tests/first-run-engines.spec.ts',
    bucket: 'first-run',
    surface: 'First Run',
    tierTarget: 'full',
    primary: true,
    rationale:
      "station#3027 + UX audit RT-02/SHELL-12: the 'Which agents do you use?' chapter in a browser. Proves WHERE it renders (inside Home's route content, on the shared dialog surface, never on another route) and WHEN (the durable AppConfig.firstRun record: pending opens it, skipped leaves only Home's card and stays closed for ten seconds, completed offers nothing, and the connect launcher still goes first), that each externalEngines row maps to its rendered state (available pre-ticked and tickable, already-enabled shown as ready with no control, blocked with the server's reason, undetected collapsed), that a confirm issues exactly one create per newly ticked engine and none for an already-bound one, that a failing create does not abort the rest of the batch, and that 'Not now' creates nothing and writes the deferral. Declared after first-run-live.spec.ts so that spec still observes the pristine temp-home boot state; this one is browser-local (route-patched status/agent catalog/app config) and mutates no server state.",
    exceptions: [],
  },
  {
    path: 'tests/starter-clean-install.spec.ts',
    bucket: 'starter-clean-install',
    surface: 'Starter clean install',
    tierTarget: 'full',
    primary: true,
    rationale:
      'station#3805: one unmocked browser journey from a newly created, runner-owned home through explicit model setup, first-run completion, real direct-chat Work, a real scheduled-check Starter, reload, and exact Scheduler receipt/output inspection. It proves no Project or Task is silently seeded, inherits no telemetry configuration, and uses an explicit healthy resource observation so unrelated host load cannot substitute an honest deferral for this product-path proof.',
    exceptions: [],
  },
  {
    path: 'tests/knowledge-onboarding.spec.ts',
    bucket: 'product',
    surface: 'Knowledge',
    tierTarget: 'full',
    primary: true,
    rationale:
      "Knowledge Settings owns optional setup: mocked default creation and Obsidian validation preserve honest adapter behavior, existing roots render, the retired global overlay stays absent, and #191's chat-rescue launcher remains intact.",
    exceptions: [],
  },
  {
    path: 'tests/meeting-notes.spec.ts',
    bucket: 'product',
    surface: 'Knowledge',
    tierTarget: 'full',
    primary: true,
    rationale:
      'K5 meeting-notes plugin (mocked /api/knowledge/* routes, mirroring knowledge-onboarding.spec.ts): capture writes a raw transcript record then a provenance-linked compiled record, the Library graph pane renders fixture nodes/edges with a selection detail panel, and the Ask pane returns provenance-linked answer cards plus the honest NO_EMBEDDER_ERROR state.',
    exceptions: [],
  },
  {
    path: 'tests/knowledge-library.spec.ts',
    bucket: 'product',
    surface: 'Knowledge',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Station #527 generic Knowledge Library plugin: personal/active-project root filtering, derived graph navigation, canonical record provenance/freshness detail, link traversal, and read-only Knowledge Store request proof.',
    exceptions: [],
  },
  {
    path: 'tests/root-route-restore.spec.ts',
    bucket: 'product',
    surface: 'Shell',
    tierTarget: 'full',
    primary: true,
    rationale:
      "#223: the root route (`/`) restore-flash fix (`resolveHomeSurface`) — a restorable `lastProject`/`lastProjectLayout` pair, the no-persisted-restore-target/projects-exist priority-2 fallthrough, and a stale/deleted `lastProject` all resolve without ever mounting `.new-project-modal__overlay` under a simulated slow `/api/projects`/`/api/projects/:slug/layouts` load, and without pushing an intermediate `/projects/new` history entry. The zero-project cold start (the modal's legitimate mount) is covered by `tests/onboarding-setup-banner.spec.ts`, not duplicated here.",
    exceptions: [],
  },
  {
    path: 'tests/task-first-home.spec.ts',
    bucket: 'product',
    surface: 'Shell',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Deterministic desktop and Pixel 7 task-first Home journey: real-shape continuation identity, guided actions, grouped customization and system navigation, off-canvas rail, overflow, and touch geometry.',
    exceptions: [],
  },
  {
    path: 'tests/onboarding-setup-banner.spec.ts',
    bucket: 'extended',
    surface: 'Onboarding',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Onboarding setup banner is primary and pending product-bucket promotion review.',
    exceptions: [],
  },
  {
    path: 'tests/orchestration-tool-activity-notifications.spec.ts',
    bucket: 'extended',
    surface: 'Chat / Orchestration',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Tool activity notifications are primary runtime behavior pending promotion review.',
    exceptions: [],
  },
  {
    path: 'tests/profile.spec.ts',
    bucket: 'extended',
    surface: 'Profile',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Profile is a routed surface pending product-bucket promotion review.',
    exceptions: [],
  },
  {
    path: 'tests/settings.spec.ts',
    bucket: 'extended',
    surface: 'Settings',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Settings is a routed surface pending product-bucket promotion review.',
    exceptions: [],
  },
  {
    path: 'tests/ui-blocks.spec.ts',
    bucket: 'extended',
    surface: 'UI Blocks',
    tierTarget: 'partial',
    primary: false,
    rationale:
      'UI block assertions are valuable regression coverage but not a primary surface lane.',
    exceptions: [],
  },
  {
    path: 'tests/voice-providers.spec.ts',
    bucket: 'extended',
    surface: 'Connections',
    tierTarget: 'full',
    primary: true,
    rationale:
      'Voice provider settings are connection-adjacent primary behavior pending product-bucket promotion review.',
    exceptions: [],
  },
  {
    path: 'tests/screenshots.spec.ts',
    bucket: 'screenshot',
    surface: 'Screenshots',
    tierTarget: 'screenshot',
    primary: false,
    rationale:
      'Screenshot capture is a visual artifact lane until product assertions are added.',
    exceptions: ['waitForTimeout'],
  },
  {
    path: 'tests/android/app-load.spec.ts',
    bucket: 'android',
    surface: 'Android',
    tierTarget: 'partial',
    primary: false,
    rationale: 'Android app-load coverage runs in the Android matrix.',
    exceptions: ['waitForTimeout'],
  },
  {
    path: 'tests/android/desktop-regression.spec.ts',
    bucket: 'android',
    surface: 'Android',
    tierTarget: 'partial',
    primary: false,
    rationale:
      'Android desktop-regression coverage runs in the Android matrix.',
    exceptions: ['waitForTimeout'],
  },
  {
    path: 'tests/android/landscape-chrome.spec.ts',
    bucket: 'android',
    surface: 'Android',
    tierTarget: 'partial',
    primary: false,
    rationale: 'Android mobile-layout coverage runs in the Android matrix.',
    exceptions: ['waitForTimeout'],
  },
  {
    path: 'tests/android/mobile-layout.spec.ts',
    bucket: 'android',
    surface: 'Android',
    tierTarget: 'partial',
    primary: false,
    rationale: 'Android mobile-layout coverage runs in the Android matrix.',
    exceptions: ['waitForTimeout'],
  },
  {
    path: 'tests/android/navigation.spec.ts',
    bucket: 'android',
    surface: 'Android',
    tierTarget: 'partial',
    primary: false,
    rationale: 'Android navigation coverage runs in the Android matrix.',
    exceptions: ['waitForTimeout'],
  },
  {
    path: 'tests/android/split-pane-mobile.spec.ts',
    bucket: 'android',
    surface: 'Android',
    tierTarget: 'partial',
    primary: false,
    rationale: 'Android split-pane coverage runs in the Android matrix.',
    exceptions: ['waitForTimeout'],
  },
  {
    path: 'tests/android/toolbar-reachability.spec.ts',
    bucket: 'android',
    surface: 'Android',
    tierTarget: 'partial',
    primary: false,
    rationale:
      'Toolbar occlusion (#1400) reproduces only at mobile widths in a ' +
      'news-carrying connection state, so it runs in the Android matrix.',
    // The 390/360 cases are skipped with #1401 named as the reason, not
    // deleted: un-skipping them is the check that proves that fix.
    exceptions: ['test.skip'],
  },
  {
    path: 'tests/android/webview-compat.spec.ts',
    bucket: 'android',
    surface: 'Android',
    tierTarget: 'partial',
    primary: false,
    rationale:
      'Android webview compatibility coverage runs in the Android matrix.',
    exceptions: ['waitForTimeout'],
  },
];

export function getSpecsForSuite(suite) {
  if (suite === 'pr-smoke') {
    return PR_BROWSER_SMOKE_CONTRACT.journeys.map((journey) => journey.path);
  }
  return e2eManifest
    .filter((entry) => entry.bucket === suite)
    .map((entry) => entry.path);
}

export function getProductE2EExecutionPhases(selectedSpecs) {
  const selected = new Set(selectedSpecs);
  return [
    {
      name: 'parallel-safe',
      workers: PRODUCT_E2E_EXECUTION_PROFILE.parallelWorkers,
      specs: PRODUCT_E2E_EXECUTION_PROFILE.parallelSafe.filter((path) =>
        selected.has(path),
      ),
    },
    {
      name: 'shared-instance-exclusive',
      workers: 1,
      specs: PRODUCT_E2E_EXECUTION_PROFILE.sharedInstanceExclusive.filter(
        (path) => selected.has(path),
      ),
    },
  ].filter((phase) => phase.specs.length > 0);
}

export function listSpecFiles(rootDir = process.cwd()) {
  const topLevel = readdirSync(join(rootDir, 'tests'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => `tests/${entry.name}`);
  const android = readdirSync(join(rootDir, 'tests/android'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => `tests/android/${entry.name}`);
  return [...topLevel, ...android].sort();
}

export function listE2ESourceFiles(rootDir = process.cwd()) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(relative(rootDir, absolute).replaceAll('\\', '/'));
      }
    }
  };
  walk(join(rootDir, 'tests'));
  return files.sort();
}

export function validateE2EManifest({
  rootDir = process.cwd(),
  readFile,
} = {}) {
  const errors = [];
  const knownFiles = listSpecFiles(rootDir);
  const knownFileSet = new Set(knownFiles);
  const assigned = new Map();

  if (readFile) {
    for (const filePath of listE2ESourceFiles(rootDir)) {
      const text = readFile(join(rootDir, filePath));
      errors.push(...e2eArtifactPathErrors(filePath, text));
      errors.push(...foregroundReceiptFixtureErrors(filePath, text));
    }
  }

  for (const entry of e2eManifest) {
    if (!entry.path || typeof entry.path !== 'string') {
      errors.push('Manifest entry is missing a path.');
      continue;
    }
    if (!E2E_BUCKETS.includes(entry.bucket)) {
      errors.push(`${entry.path} uses unknown bucket '${entry.bucket}'.`);
    }
    if (!knownFileSet.has(entry.path)) {
      errors.push(
        `${entry.path} is listed in the manifest but does not exist.`,
      );
    }
    if (assigned.has(entry.path)) {
      errors.push(
        `${entry.path} is assigned multiple times (${assigned.get(entry.path)}, ${entry.bucket}).`,
      );
    }
    assigned.set(entry.path, entry.bucket);
    if (!entry.surface) {
      errors.push(`${entry.path} is missing a surface.`);
    }
    if (!entry.tierTarget) {
      errors.push(`${entry.path} is missing a tierTarget.`);
    }
    if (!entry.rationale) {
      errors.push(`${entry.path} is missing a rationale.`);
    }
    if (entry.bucket === 'quarantine' && !entry.replacement) {
      errors.push(`${entry.path} is quarantined without replacement coverage.`);
    }
    if (entry.primary && entry.bucket === 'extended' && !entry.rationale) {
      errors.push(
        `${entry.path} is primary extended coverage without rationale.`,
      );
    }
    if (readFile) {
      const text = readFile(join(rootDir, entry.path));
      if (E2E_TARGET_AUDIT_PATTERN.test(text)) {
        errors.push(`${entry.path} has unsafe E2E target resolution.`);
      }
      if (E2E_VACUOUS_ASSERTION_PATTERN.test(text)) {
        errors.push(`${entry.path} contains a vacuous always-pass assertion.`);
      }
      if (E2E_INVALID_TEST_INFO_PATTERN.test(text)) {
        errors.push(
          `${entry.path} destructures testInfo as a fixture instead of using the callback argument.`,
        );
      }
      if (
        entry.bucket === 'product' &&
        E2E_AUDIT_PATTERN.test(text) &&
        entry.exceptions.length === 0
      ) {
        errors.push(`${entry.path} has unresolved product audit violations.`);
      }
    }
  }

  for (const specFile of knownFiles) {
    if (!assigned.has(specFile)) {
      errors.push(`${specFile} is not assigned to an E2E manifest bucket.`);
    }
  }

  for (const journey of PR_BROWSER_SMOKE_CONTRACT.journeys) {
    if (!knownFileSet.has(journey.path)) {
      errors.push(
        `${journey.path} is listed in the PR browser-smoke contract but does not exist.`,
      );
    }
    if (!journey.journey) {
      errors.push(`${journey.path} is missing its PR smoke journey.`);
    }
  }

  const productSpecs = new Set(
    e2eManifest
      .filter((entry) => entry.bucket === 'product')
      .map((entry) => entry.path),
  );
  const executionAssignments = new Map();
  for (const [executionClass, specs] of [
    ['parallel-safe', PRODUCT_E2E_EXECUTION_PROFILE.parallelSafe],
    [
      'shared-instance-exclusive',
      PRODUCT_E2E_EXECUTION_PROFILE.sharedInstanceExclusive,
    ],
  ]) {
    for (const spec of specs) {
      if (!productSpecs.has(spec)) {
        errors.push(
          `${spec} is classified ${executionClass} but is not a product E2E spec.`,
        );
      }
      if (executionAssignments.has(spec)) {
        errors.push(
          `${spec} has multiple product execution classes (${executionAssignments.get(spec)}, ${executionClass}).`,
        );
      }
      executionAssignments.set(spec, executionClass);
    }
  }
  for (const spec of productSpecs) {
    if (!executionAssignments.has(spec)) {
      errors.push(`${spec} is missing a product E2E execution class.`);
    }
  }
  if (
    !Number.isInteger(PRODUCT_E2E_EXECUTION_PROFILE.parallelWorkers) ||
    PRODUCT_E2E_EXECUTION_PROFILE.parallelWorkers < 2 ||
    PRODUCT_E2E_EXECUTION_PROFILE.parallelWorkers > 4
  ) {
    errors.push(
      'Product parallel worker count must be an integer from 2 to 4.',
    );
  }
  if (readFile) {
    for (const spec of PRODUCT_E2E_EXECUTION_PROFILE.parallelSafe) {
      if (!productSpecs.has(spec)) continue;
      const text = readFile(join(rootDir, spec));
      const exception =
        PRODUCT_E2E_EXECUTION_PROFILE.parallelSafetyExceptions[spec];
      const ownsRiskyResource =
        /resolveE2EApiBase|from\s+['"]node:(?:child_process|fs)['"]|test\.describe(?:\.serial|\.configure\(\s*\{\s*mode:\s*['"]serial['"])/s.test(
          text,
        );
      const provesBrowserIsolation = /page\.route\(|page\.setContent\(/.test(
        text,
      );
      if (ownsRiskyResource && !exception) {
        errors.push(
          `${spec} uses live-instance or child-process E2E resources but is classified parallel-safe.`,
        );
      }
      if (!provesBrowserIsolation && !exception) {
        errors.push(
          `${spec} is parallel-safe without browser-local route/content isolation or an explicit safety exception.`,
        );
      }
      if (exception && exception.trim().length < 20) {
        errors.push(`${spec} has an incomplete parallel-safety exception.`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
