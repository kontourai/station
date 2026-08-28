/**
 * Classification of the station-control tool surface (S3 item 4).
 *
 * Every tool the station-control MCP server registers is classified as
 * either READ-ONLY (list/get/navigate/status — safe for auto-approve, never
 * policy-gated) or MUTATING (platform create/update/delete, installs,
 * scheduler actions, config writes, agent dispatch — subject to the
 * platform-mutation gate in policy-opted workspaces). The classification
 * completeness test in `src-server/tools/__tests__` asserts the union covers
 * the full registered tool surface, so a new tool cannot ship unclassified.
 */

// Read-only station-control tools safe for auto-approve.
const SC_READ_ONLY_TOOL_NAMES = [
  'list_agents',
  'get_agent',
  'list_skills',
  'list_registry_skills',
  'list_integrations',
  'get_integration',
  'list_registry_integrations',
  'list_providers',
  'list_jobs',
  'list_scheduler_providers',
  'get_scheduler_stats',
  'get_scheduler_status',
  'preview_schedule',
  'get_job_logs',
  'system_status',
  // Reads Station's own server logs (redacted for remote/paired callers;
  // unredacted for the local operator) — a pure read over local diagnostics.
  'read_logs',
  // Reads monitoring events (a different store from read_logs); the route it
  // calls applies the per-user and tenant filters, so this is a read.
  'read_monitoring_events',
  'list_models',
  'list_delegation_environments',
  'navigate_to',
  'list_projects',
  'get_project',
  'list_project_layouts',
  'list_layouts',
  'get_layout',
  'list_conversations',
  'get_conversation_messages',
  'get_config',
  'list_plugins',
  'check_plugin_updates',
  'get_usage',
  'get_achievements',
  // archive#1880: semantic search over the K3 knowledge index — embeds the
  // query and reads the index + re-resolves records through the store
  // adapters; writes nothing (unlike reindex_knowledge/migrate_knowledge
  // below, which rebuild the index).
  'search_knowledge',
  // archive#1136: a pure profile+state read (SshEnvironmentService#get),
  // no connect/reconnect side effect — unlike list_delegation_targets/
  // get_task below, which may reconnect a verified SSH environment.
  'get_ssh_environment',
  // archive#2901 review evidence: pure reads over review requests and their
  // durable receipts. The `run_independent_review` verb that CREATES them is
  // classified mutating below.
  'get_review_request',
  'list_review_receipts',
  'get_review_receipt',
  // archive#4079: a pure board-face read (BoardStore#read); the
  // pin/unpin/move verbs that write to it are classified mutating below.
  'board_read',
];

/**
 * Mutating station-control tools: agent/skill/project/config/
 * scheduler create-update-delete, integration/plugin install, and agent
 * dispatch (`send_message`, `run_job` — they trigger autonomous work, the
 * same set the delegation child deny-list already treats as privileged).
 */
const SC_MUTATING_TOOL_NAMES = [
  // agents + conversations
  'create_agent',
  'update_agent',
  'delete_agent',
  'delete_conversation',
  // skills
  'install_skill',
  'uninstall_skill',
  'update_skill',
  'track_skill_run',
  'record_skill_outcome',
  // integrations / providers / plugins
  'create_integration',
  'delete_integration',
  'install_registry_integration',
  'create_provider',
  'install_plugin',
  'update_plugin',
  'remove_plugin',
  // scheduler
  'add_job',
  'update_job',
  'run_job',
  'enable_job',
  'disable_job',
  'delete_job',
  // app config
  'update_config',
  // agent dispatch
  'send_message',
  // Read-oriented, but selected SSH discovery may reconnect the verified
  // environment before returning its secret-free capability catalog.
  'list_delegation_targets',
  'list_delegated_tasks',
  'delegate_task',
  // May reconnect a verified SSH environment before reading task state.
  'get_task',
  'get_task_events',
  'continue_task',
  'respond_to_task_request',
  'interrupt_task',
  // knowledge index management (s201-knowledge-retrieval) — rebuild/migrate
  // both write to the sqlite-vec index and/or a new store root, never
  // read-only
  'reindex_knowledge',
  'migrate_knowledge',
  // archive#1136: environment MANAGEMENT verbs — create/connect/disconnect/
  // remove a saved SSH environment via SshEnvironmentService. Same tier as
  // `create_agent`/`delete_agent`: create/destroy/state-changing actions on
  // persistent, credentialed configuration, subject to the platform-mutation
  // gate like every other write verb in this list (`get_ssh_environment`
  // above is the read-only sibling).
  'create_ssh_environment',
  'connect_ssh_environment',
  'disconnect_ssh_environment',
  'remove_ssh_environment',
  // archive#2901 review evidence: `run_independent_review` starts a review and
  // writes a durable receipt, so it belongs with the other create/dispatch
  // verbs. Its `get_*`/`list_*` siblings are read-only and listed above.
  'run_independent_review',
  // archive#4079: board-face writes (BoardStore#pin/unpin/move) —
  // persistent state that survives a restart, same tier as scheduler/agent
  // CRUD above.
  'board_pin',
  'board_unpin',
  'board_move',
];

const SC_TOOL_NAME_PREFIXES = ['station-control_', 'stationControl_'];

export const SC_READ_ONLY_TOOLS = SC_READ_ONLY_TOOL_NAMES.map(
  (toolName) => `station-control_${toolName}`,
);

const READ_ONLY_SET: ReadonlySet<string> = new Set(SC_READ_ONLY_TOOL_NAMES);
const MUTATING_SET: ReadonlySet<string> = new Set(SC_MUTATING_TOOL_NAMES);

/** Strip the integration prefix a tool loader may have applied. */
export function bareControlToolName(toolName: string): string {
  for (const prefix of SC_TOOL_NAME_PREFIXES) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return toolName;
}

export type ControlToolClass = 'read-only' | 'mutating';

/**
 * Classify a station-control tool name (prefixed or bare). Unknown names
 * classify as MUTATING — fail-safe: a new unclassified tool gets gated until
 * it is explicitly classified, never silently waved through.
 */
export function classifyControlTool(toolName: string): ControlToolClass {
  const bare = bareControlToolName(toolName);
  if (READ_ONLY_SET.has(bare)) return 'read-only';
  if (MUTATING_SET.has(bare)) return 'mutating';
  return 'mutating';
}

/** True when the bare name is explicitly classified (read-only OR mutating). */
export function isClassifiedControlTool(toolName: string): boolean {
  const bare = bareControlToolName(toolName);
  return READ_ONLY_SET.has(bare) || MUTATING_SET.has(bare);
}
