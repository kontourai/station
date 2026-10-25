// Which source modules each gallery screen (`SCREENS` in
// tests/screenshots.spec.ts) loads, as ENTRY modules only: the route view or
// lazily loaded surface the screen exists to photograph. Coverage is the
// import closure of these entries, computed by scripts/lib/ui-module-graph.mjs
// (static and lazy imports), plus the shell every screen loads. Nothing here
// lists the files a change might touch, so the map cannot go stale as views
// grow; it goes stale only when a screen points at the wrong surface.
//
// Pinned two ways: screenshots.spec.ts refuses to start when SCREENS and this
// map disagree on names, and scripts/__tests__/gallery-screen-coverage.test.ts
// requires every entry to exist and to be reachable from the app's HTML entry.

/**
 * Modules every screen loads: the HTML entry (boot script, splash stylesheet),
 * `main.tsx` (boot's unconditional `import('./main')`), and the lazy chrome
 * App mounts on every route. Their STATIC closure is "every screen".
 */
export const GALLERY_SHELL_ENTRIES = Object.freeze([
  'src-ui/index.html',
  'src-ui/src/main.tsx',
  'src-ui/src/components/DeferredAppOverlays.tsx',
  'src-ui/src/components/CoreUpdateLaunchCheck.tsx',
  'src-ui/src/components/ServerOlderLaunchCheck.tsx',
]);

const HOME = 'src-ui/src/views/HomeView.tsx';
const CHAT = 'src-ui/src/components/chat-dock/ChatDock.tsx';
const ACTIVITY = 'src-ui/src/app-shell/ActivityRegionShell.tsx';
const AGENTS = 'src-ui/src/views/AgentsView.tsx';
const SETTINGS = 'src-ui/src/views/SettingsView.tsx';
const SCHEDULE = 'src-ui/src/views/ScheduleView.tsx';
const CONNECTIONS = 'src-ui/src/views/ConnectionsHub.tsx';
const SECTION = 'src-ui/src/views/ConnectionsSectionFrame.tsx';
const CONNECT_STATION =
  'src-ui/src/views/connections-hub/ConnectStationDialog.tsx';
const NEW_PROJECT = 'src-ui/src/components/modals/NewProjectModal.tsx';

const telemetry = [
  'telemetry-dialog-default',
  'telemetry-dialog-mixed',
  'telemetry-dialog-dnt',
  'telemetry-dialog-endpoint',
  'telemetry-dialog-detailed',
  'telemetry-dialog-light',
  'telemetry-settings',
  'telemetry-settings-dnt',
  'telemetry-outbox',
  'telemetry-feedback',
].flatMap((name) => [
  [`${name}-desktop`, [SETTINGS]],
  [`${name}-mobile`, [SETTINGS]],
]);

/** Screen name -> entry modules (repo-relative). */
export const GALLERY_SCREEN_ENTRIES = Object.freeze(
  Object.fromEntries([
    ...telemetry,
    ['telemetry-settings-dnt-after-fix-mobile', [SETTINGS]],
    ['telemetry-settings-detailed-expanded-mobile', [SETTINGS]],
    ['mobile-activity-compact', [HOME, ACTIVITY]],
    ['mobile-http-consent-320', [SETTINGS, CONNECT_STATION]],
    ['mobile-access-request-error-320', [SETTINGS, CONNECT_STATION]],
    ['mobile-http-consent-390', [SETTINGS, CONNECT_STATION]],
    ['mobile-access-request-error-390', [SETTINGS, CONNECT_STATION]],
    ['home', [HOME]],
    ['agents', [AGENTS]],
    ['skills', ['src-ui/src/views/GuidanceView.tsx']],
    ['registry', ['src-ui/src/views/RegistryView.tsx']],
    ['connections', [CONNECTIONS]],
    [
      'connections-models',
      [SECTION, 'src-ui/src/views/ProviderSettingsView.tsx'],
    ],
    [
      'connections-agent-apps',
      [SECTION, 'src-ui/src/views/AgentConnectionView.tsx'],
    ],
    ['connections-tools', [SECTION, 'src-ui/src/views/IntegrationsView.tsx']],
    [
      'connections-knowledge',
      [SECTION, 'src-ui/src/views/KnowledgeConnectionView.tsx'],
    ],
    ['sessions', [HOME, ACTIVITY]],
    ['plugins', ['src-ui/src/views/PluginManagementView.tsx']],
    ['schedule', [SCHEDULE]],
    ['developer-telemetry', ['src-ui/src/views/DeveloperView.tsx']],
    ['profile', ['src-ui/src/pages/ProfilePage.tsx']],
    ['settings', [SETTINGS]],
    ['settings-info-tip', [SETTINGS]],
    ['agent-editor', [AGENTS]],
    ['agent-editor-not-runnable', [AGENTS]],
    ['mobile-home', [HOME]],
    ['mobile-agents', [AGENTS]],
    ['mobile-agent-editor-save-footer', [AGENTS]],
    ['mobile-agent-editor-project-control', [AGENTS]],
    ['mobile-settings-overview', [SETTINGS]],
    ['sessions-filtered-empty', [HOME, ACTIVITY]],
    ['agents-empty', [AGENTS]],
    ['command-palette-empty', [HOME]],
    ['motion-reduced-navigation', [AGENTS]],
    ['motion-reduced-schedule-loading', [SCHEDULE]],
    ['motion-reduced-schedule-modal', [SCHEDULE]],
    ['motion-reduced-notification', [HOME]],
    ['motion-reduced-mobile-chat', [HOME, CHAT]],
    ['overlay-region-chooser-from-toggle', [HOME, CHAT]],
    ['overlay-command-palette-results', [HOME]],
    ['overlay-agent-actions-menu', [AGENTS]],
    ['overlay-connection-banner', [SETTINGS]],
    ['overlay-new-project-layout-control', [HOME, NEW_PROJECT]],
    ['overlay-new-project-modal', [HOME, NEW_PROJECT]],
    ['overlay-add-job-modal', [SCHEDULE]],
    ['overlay-confirm-dialog', [SCHEDULE]],
    ['overlay-mobile-sheet', [HOME, CHAT]],
    ['overlay-dock-project-bound', [HOME, CHAT]],
    ['overlay-dock-project-mismatch', [HOME, CHAT]],
    ['desktop-conversation-resync', [HOME, CHAT]],
    ['mobile-conversation-resync', [HOME, CHAT]],
    ['overlay-project-switcher-populated', [HOME, CHAT]],
    ['overlay-toast', [HOME]],
    ['overlay-toast-action', [HOME]],
    ['mobile-chat-dock-header-320', [HOME, CHAT]],
    ['mobile-connections', [CONNECTIONS]],
    ['mobile-agent-editor', [AGENTS]],
    ['mobile-onboarding-setup', [HOME]],
  ]),
);

/**
 * Refuses a SCREENS list that this map does not describe exactly: a missing
 * screen would be invisible to gate:for routing, an extra one would route
 * changes to a screen that no longer exists.
 * @param {readonly string[]} screenNames
 */
export function assertGalleryScreenSourcesCover(screenNames) {
  const declared = new Set(Object.keys(GALLERY_SCREEN_ENTRIES));
  const missing = screenNames.filter((name) => !declared.has(name));
  const names = new Set(screenNames);
  const extra = [...declared].filter((name) => !names.has(name));
  if (missing.length > 0 || extra.length > 0)
    throw new Error(
      'tests/gallery-screen-sources.mjs must name every gallery screen exactly. ' +
        `Missing: ${missing.join(', ') || 'none'}. Unknown: ${extra.join(', ') || 'none'}.`,
    );
}
