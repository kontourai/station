/** Canonical closed foreground-work report vocabulary, shared by UI and checker. */
export const FOREGROUND_WORK_JOURNAL_VERSION = 1;
export const FOREGROUND_WORK_STALL_THRESHOLD_MS = 50;
export const FOREGROUND_WORK_PHASES = Object.freeze([
  'input',
  'authoritative-apply',
  'layout',
  'render',
  'pane-restoration',
]);
export const FOREGROUND_WORK_INTERACTIONS = Object.freeze([
  'task-editor',
  'workspace-pane',
  'collaboration',
  'navigation',
]);
export const FOREGROUND_WORK_ACTIONS = Object.freeze([
  'local-input',
  'remote-apply',
  'layout-commit',
  'pane-restore',
  'presence-update',
]);
export const FOREGROUND_WORK_PANES = Object.freeze([
  'task-editor',
  'file-preview',
  'diff-panel',
  'workspace-host',
]);
export const FOREGROUND_WORK_INCIDENT_SOURCES = Object.freeze([
  'browser-longtask',
  'manual-stall',
]);
export const FOREGROUND_WORK_COLLECTORS = Object.freeze([
  'browser-longtask',
  'NOT_VERIFIED',
]);
export const FOREGROUND_WORK_COLLECTOR_UNSUPPORTED =
  'BROWSER_LONGTASK_UNSUPPORTED';
export const NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE =
  'NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE';
