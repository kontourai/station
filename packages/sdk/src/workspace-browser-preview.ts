/**
 * Opt-in, browser-safe local Browser Workspace Pane contract. It deliberately
 * provides no host discovery, proxy, auth bridge, or renderer implementation.
 */

export type {
  WorkspaceBrowserPreviewHistoryCapability,
  WorkspaceBrowserPreviewIdentity,
  WorkspaceBrowserPreviewPaneState,
  WorkspaceBrowserPreviewState,
  WorkspaceBrowserPreviewStatus,
  WorkspaceBrowserPreviewViewportPreference,
} from '@kontourai/station-contracts/workspace-browser-preview';
export {
  normalizeLocalBrowserPreviewUrl,
  parseWorkspaceBrowserPreviewPaneState,
  parseWorkspaceBrowserPreviewState,
  WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
  WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR_ID,
  WORKSPACE_BROWSER_PREVIEW_PANE_RENDERER_ID,
  WORKSPACE_BROWSER_PREVIEW_PANE_RENDERER_NAME,
  WORKSPACE_BROWSER_PREVIEW_PANE_SOURCE_ID,
  WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
} from '@kontourai/station-contracts/workspace-browser-preview';
