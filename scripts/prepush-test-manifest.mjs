/**
 * Deterministic, bounded tests used by the generic pre-push `npm test` hook.
 *
 * Keep real-process, installer, wall-clock, browser, and dogfood-reconcile
 * coverage in `test:full` / `verify:static`. This lane is deliberately a
 * high-signal contract floor that can run repeatedly under ordinary load.
 */
export const PREPUSH_TEST_GROUPS = Object.freeze({
  guardrails: Object.freeze([
    'scripts/__tests__/node-runtime-contract.test.ts',
    'scripts/__tests__/local-verification.test.ts',
    'scripts/__tests__/e2e-manifest.test.ts',
    'scripts/__tests__/trust-reconcile-manifest.test.ts',
    'scripts/__tests__/verification-policy-gate.test.ts',
    'scripts/__tests__/agent-instructions-gate.test.ts',
    'scripts/__tests__/product-laws.test.ts',
    'scripts/__tests__/noun-consistency-gate.test.ts',
    'scripts/__tests__/station-vocabulary-gate.test.ts',
    'scripts/__tests__/unsaved-guard-gate.test.ts',
    'scripts/__tests__/state-primitives-ratchet.test.ts',
    'scripts/__tests__/responsive-surface-ratchet.test.ts',
    'scripts/__tests__/focus-visible-ratchet.test.ts',
    'scripts/__tests__/shell-conformance-ratchet.test.ts',
    'scripts/__tests__/knowledge-kit-import-gate.test.ts',
    'scripts/__tests__/dependency-advisory-policy.test.ts',
    'scripts/__tests__/prepare-verify-static.test.ts',
    'scripts/__tests__/container-release.test.ts',
    'scripts/__tests__/prepush-tier.test.ts',
    'scripts/__tests__/load-reliability.test.ts',
  ]),
  contracts: Object.freeze([
    'packages/contracts/src/__tests__/runtime-events.test.ts',
    'packages/contracts/src/__tests__/task-graph-contracts.test.ts',
    'packages/contracts/src/__tests__/orchestration-session-contracts.test.ts',
    'packages/contracts/src/__tests__/registry-lifecycle.test.ts',
    'packages/contracts/src/__tests__/environment-security.test.ts',
    'packages/contracts/src/__tests__/workspace-isolation-contracts.test.ts',
    'packages/sdk/src/__tests__/authenticated-client-transport.test.ts',
    'packages/sdk/src/__tests__/client-fetchers-failure-paths.test.ts',
    'packages/connect/src/__tests__/ConnectionStore.test.ts',
    'packages/connect/src/__tests__/ConnectionHealthCoordinator.test.ts',
    'packages/connect/src/__tests__/accessMethods.test.ts',
    'packages/connect/src/__tests__/devicePairing.test.ts',
  ]),
  server: Object.freeze([
    'src-server/runtime/__tests__/runtime-auth-boundary.test.ts',
    'src-server/runtime/__tests__/device-pairing-routes.test.ts',
    'src-server/services/connections/__tests__/connection-service.test.ts',
    'src-server/services/ssh/__tests__/device-pairing-service.test.ts',
    'src-server/services/plugins/__tests__/plugin-permissions.test.ts',
    'src-server/services/orchestration/__tests__/orchestration-session-state.test.ts',
    'src-server/routes/system/__tests__/auth.routes.test.ts',
  ]),
  ui: Object.freeze([
    'src-ui/src/__tests__/OnboardingGate.test.tsx',
    'src-ui/src/contexts/__tests__/AuthContext.test.tsx',
    'src-ui/src/__tests__/responsive-dialog-contract.test.ts',
    'src-ui/src/__tests__/mobile-chat-viewport.test.ts',
    'src-ui/src/__tests__/mobile-chat-scroll-anchor.test.ts',
    'src-ui/src/__tests__/new-chat-modal-utils.test.ts',
    'src-ui/src/__tests__/connectionInventory.test.ts',
    'src-ui/src/__tests__/resolve-home-surface.test.ts',
    'src-ui/src/__tests__/app-routing.test.ts',
    'src-ui/src/__tests__/websocket-secret-inventory.test.ts',
  ]),
});

export const PREPUSH_TEST_FILES = Object.freeze(
  Object.values(PREPUSH_TEST_GROUPS).flat(),
);
