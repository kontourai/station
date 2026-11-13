/**
 * #3418: Station's own tool calls in plain words ("Declared PR #3271"), for
 * transcript rows, the live progress line and the Session digest. Every
 * registered Station tool has an entry (`station-tool-phrases.test.ts` in
 * src-server pins this). Phrases use only the call's own arguments; a Session
 * is named by a title the reader supplies, otherwise "a Session".
 */

/** The MCP servers whose tools are Station's own. */
export const STATION_TOOL_SERVERS = [
  'station-control',
  'station-knowledge',
  'station-browser',
  'station-docs',
] as const;

export type StationToolServer = (typeof STATION_TOOL_SERVERS)[number];

/** How far the call has got, which decides the verb's form. */
export type StationToolPhase = 'done' | 'running' | 'pending';

/** What a phrase may read about one call. */
export interface StationToolPhraseInput {
  /** The call's arguments, as the engine carried them. */
  args?: unknown;
  /** A Session's title by its id, when the reader knows it. */
  sessionTitle?: (sessionId: string) => string | undefined;
}

type Args = Readonly<Record<string, unknown>>;
interface Context {
  readonly args: Args;
  readonly sessionTitle?: (sessionId: string) => string | undefined;
}

interface PhraseEntry {
  /** Past tense, present progressive, bare infinitive. */
  readonly verbs: readonly [done: string, running: string, pending: string];
  /** What the verb acts on; omitted for a verb that stands alone. */
  readonly object?: (context: Context) => string | undefined;
}

const MAX_SLOT_CHARS = 48;

/** One argument's first line, whitespace collapsed, cut by code point. */
function text(args: Args, key: string): string | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}`;
  if (typeof value !== 'string') return undefined;
  const line = value.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, ' ') ?? '';
  if (!line) return undefined;
  const points = [...line];
  return points.length > MAX_SLOT_CHARS
    ? `${points.slice(0, MAX_SLOT_CHARS - 1).join('')}…`
    : line;
}

const quoted = (value: string | undefined) =>
  value === undefined ? undefined : `“${value}”`;

/** "Agent “reviewer”", or the fallback when the call names none. */
const named =
  (noun: string, key: string, fallback: string) =>
  ({ args }: Context) => {
    const value = text(args, key);
    return value ? `${noun} ${quoted(value)}` : fallback;
  };

const fixed = (object: string) => () => object;

/** A Session by its title when known; never a guessed name. */
function session(
  context: Context,
  keys: readonly string[] = ['sessionId', 'conversationId'],
  fallback = 'a Session',
): string {
  for (const key of keys) {
    const id = context.args[key];
    if (typeof id !== 'string' || !id) continue;
    const title = quoted(text({ title: context.sessionTitle?.(id) }, 'title'));
    if (title) return title;
  }
  return fallback;
}

/** A Conversation (a Session's person-visible thread) by its title. */
const conversation = (
  context: Context,
  keys: readonly string[] = ['conversationId'],
) => session(context, keys, 'a Conversation');

const entry = (
  done: string,
  running: string,
  pending: string,
  object?: PhraseEntry['object'],
): PhraseEntry => ({
  verbs: [done, running, pending],
  ...(object ? { object } : {}),
});

const READ = ['Read', 'Reading', 'Read'] as const;
const LISTED = ['Listed', 'Listing', 'List'] as const;
const read = (object: PhraseEntry['object']) => entry(...READ, object);
const listed = (object: string) => entry(...LISTED, fixed(object));

const STATION_TOOL_PHRASES: Readonly<Record<string, PhraseEntry>> = {
  // Devices
  device_list: listed('devices'),
  device_open: entry('Opened', 'Opening', 'Open', fixed('a device')),
  device_screenshot: entry(
    'Took',
    'Taking',
    'Take',
    fixed('a device screenshot'),
  ),
  device_capture_to_task: entry(
    'Captured',
    'Capturing',
    'Capture',
    fixed('the device screen to the Task'),
  ),
  device_record_to_task: entry(
    'Recorded',
    'Recording',
    'Record',
    fixed('the device screen to the Task'),
  ),
  device_logs: read(({ args }) => {
    const app = text(args, 'appId');
    return app ? `device logs for ${app}` : 'device logs';
  }),
  device_install_app: entry(
    'Installed',
    'Installing',
    'Install',
    fixed('an app on the device'),
  ),
  device_launch_app: entry(
    'Launched',
    'Launching',
    'Launch',
    ({ args }) => text(args, 'appId') ?? 'an app',
  ),
  device_terminate_app: entry(
    'Stopped',
    'Stopping',
    'Stop',
    ({ args }) => text(args, 'appId') ?? 'an app',
  ),
  device_open_url: entry(
    'Opened',
    'Opening',
    'Open',
    ({ args }) => `${text(args, 'url') ?? 'a link'} on the device`,
  ),
  device_snapshot: read(fixed('the device screen')),
  device_input: entry('Sent', 'Sending', 'Send', fixed('input to the device')),
  device_close: entry('Closed', 'Closing', 'Close', fixed('the device')),

  // Browser
  browser_status: entry(
    'Checked',
    'Checking',
    'Check',
    fixed('the Browser pane'),
  ),
  browser_open: entry(
    'Opened',
    'Opening',
    'Open',
    ({ args }) => text(args, 'url') ?? 'the Browser pane',
  ),
  browser_close: entry('Closed', 'Closing', 'Close', fixed('the Browser pane')),
  browser_navigate: entry(
    'Went to',
    'Going to',
    'Go to',
    ({ args }) => text(args, 'url') ?? 'a page',
  ),
  browser_resize: entry('Resized', 'Resizing', 'Resize', fixed('the browser')),
  browser_capture_to_task: entry(
    'Captured',
    'Capturing',
    'Capture',
    fixed('the page to the Task'),
  ),
  browser_record_to_task: entry(
    'Recorded',
    'Recording',
    'Record',
    fixed('the page to the Task'),
  ),
  browser_network: read(fixed('the page’s network requests')),
  browser_snapshot: read(fixed('the page')),
  browser_click: entry('Clicked', 'Clicking', 'Click', fixed('on the page')),
  browser_hover: entry('Hovered', 'Hovering', 'Hover', fixed('on the page')),
  browser_drag: entry('Dragged', 'Dragging', 'Drag', fixed('on the page')),
  browser_select: entry(
    'Chose',
    'Choosing',
    'Choose',
    ({ args }) =>
      quoted(text(args, 'value') ?? text(args, 'label')) ?? 'an option',
  ),
  browser_color_scheme: entry('Set', 'Setting', 'Set', ({ args }) => {
    const scheme = text(args, 'scheme');
    return scheme ? `the page to ${scheme} mode` : 'the page’s color scheme';
  }),
  browser_type: entry('Typed', 'Typing', 'Type', fixed('on the page')),
  browser_press: entry(
    'Pressed',
    'Pressing',
    'Press',
    ({ args }) => text(args, 'key') ?? 'a key',
  ),
  browser_wait_for: entry(
    'Waited for',
    'Waiting for',
    'Wait for',
    ({ args }) => quoted(text(args, 'text')) ?? 'the page',
  ),
  browser_scroll: entry('Scrolled', 'Scrolling', 'Scroll', fixed('the page')),
  browser_evaluate: entry(
    'Ran',
    'Running',
    'Run',
    fixed('a script on the page'),
  ),

  // Docs
  list_station_docs_topics: listed('documentation topics'),
  get_station_docs_topic: read(({ args }) => {
    const topic = text(args, 'id') ?? text(args, 'topicId');
    return topic ? `the ${quoted(topic)} documentation` : 'documentation';
  }),
  search_station_docs: entry('Searched', 'Searching', 'Search', ({ args }) => {
    const query = quoted(text(args, 'query'));
    return query ? `documentation for ${query}` : 'documentation';
  }),

  // Agents and conversations
  list_agents: listed('Agents'),
  get_agent: read(named('Agent', 'slug', 'an Agent')),
  create_agent: entry(
    'Created',
    'Creating',
    'Create',
    named('Agent', 'name', 'an Agent'),
  ),
  update_agent: entry(
    'Updated',
    'Updating',
    'Update',
    named('Agent', 'slug', 'an Agent'),
  ),
  delete_agent: entry(
    'Deleted',
    'Deleting',
    'Delete',
    named('Agent', 'slug', 'an Agent'),
  ),
  list_conversations: listed('Conversations'),
  get_conversation_messages: read(
    (context) => `messages from ${conversation(context)}`,
  ),
  read_conversation: read((context) =>
    conversation(context, ['conversationId', 'sessionId']),
  ),
  fork_conversation: entry('Forked', 'Forking', 'Fork', conversation),
  delete_conversation: entry('Deleted', 'Deleting', 'Delete', conversation),
  search_conversations: entry('Searched', 'Searching', 'Search', ({ args }) => {
    const query = quoted(text(args, 'query'));
    return query ? `Conversations for ${query}` : 'Conversations';
  }),
  list_active_work: listed('active work'),
  send_message: entry('Messaged', 'Messaging', 'Message', ({ args }) => {
    const agent = text(args, 'agent');
    return agent ? `Agent ${quoted(agent)}` : 'an Agent';
  }),

  // Sessions in this Project
  get_session_inventory: read((context) => `what ${session(context)} reviewed`),
  search_sessions: entry('Searched', 'Searching', 'Search', ({ args }) => {
    const query = quoted(text(args, 'query'));
    return query ? `Sessions for ${query}` : 'Sessions';
  }),
  rename_session: entry('Renamed', 'Renaming', 'Rename', ({ args }) => {
    const title = quoted(text(args, 'title'));
    return title ? `a Session to ${title}` : 'a Session';
  }),
  send_to_session: entry('Sent to', 'Sending to', 'Send to', (context) =>
    session(context, ['sessionId']),
  ),
  interrupt_session: entry('Stopped', 'Stopping', 'Stop', (context) =>
    session(context, ['sessionId']),
  ),
  wait_session: entry('Waited for', 'Waiting for', 'Wait for', (context) =>
    session(context, ['sessionId']),
  ),
  list_project_activity: entry(
    'Checked',
    'Checking',
    'Check',
    fixed('Project activity'),
  ),
  get_session_digest: read((context) => `a digest of ${session(context)}`),
  claim_work: entry(
    'Claimed',
    'Claiming',
    'Claim',
    ({ args }) => text(args, 'workItemRef') ?? 'work',
  ),
  renew_claim: entry('Renewed', 'Renewing', 'Renew', fixed('a claim')),
  release_claim: entry('Released', 'Releasing', 'Release', fixed('a claim')),

  // Boards
  board_pin: entry('Pinned', 'Pinning', 'Pin', ({ args }) => {
    const name = quoted(text(args, 'name'));
    return name ? `${name} to a Board` : 'to a Board';
  }),
  board_unpin: entry('Unpinned', 'Unpinning', 'Unpin', ({ args }) => {
    const name = quoted(text(args, 'name'));
    return name ? `${name} from a Board` : 'from a Board';
  }),
  board_move: entry(
    'Moved',
    'Moving',
    'Move',
    ({ args }) => quoted(text(args, 'name')) ?? 'a Board item',
  ),
  board_read: read(fixed('a Board')),
  list_personal_boards: listed('personal Boards'),
  get_personal_board: read(named('Board', 'slug', 'a personal Board')),
  propose_personal_board: entry(
    'Proposed',
    'Proposing',
    'Propose',
    fixed('a personal Board'),
  ),

  // Skills
  list_skills: listed('Skills'),
  list_registry_skills: listed('Skills in the registry'),
  install_skill: entry(
    'Installed',
    'Installing',
    'Install',
    named('Skill', 'id', 'a Skill'),
  ),
  uninstall_skill: entry(
    'Uninstalled',
    'Uninstalling',
    'Uninstall',
    named('Skill', 'id', 'a Skill'),
  ),
  update_skill: entry(
    'Updated',
    'Updating',
    'Update',
    named('Skill', 'name', 'a Skill'),
  ),
  track_skill_run: entry(
    'Recorded',
    'Recording',
    'Record',
    ({ args }) => `a run of ${named('Skill', 'name', 'a Skill')({ args })}`,
  ),
  record_skill_outcome: entry(
    'Recorded',
    'Recording',
    'Record',
    ({ args }) => `how ${named('Skill', 'name', 'a Skill')({ args })} went`,
  ),

  // Evidence
  run_independent_review: entry(
    'Requested',
    'Requesting',
    'Request',
    fixed('an independent review'),
  ),
  get_review_request: read(fixed('a review request')),
  list_review_receipts: listed('review receipts'),
  get_review_receipt: read(fixed('a review receipt')),
  get_answer_assessment_target: read(fixed('an answer to assess')),
  publish_answer_assessment: entry(
    'Published',
    'Publishing',
    'Publish',
    fixed('an answer assessment'),
  ),
  remove_answer_assessment: entry(
    'Removed',
    'Removing',
    'Remove',
    fixed('an answer assessment'),
  ),
  get_basis: read(fixed('an answer’s Basis')),
  get_task_basis: read(fixed('the Task’s Basis')),
  html_render: entry(
    'Published',
    'Publishing',
    'Publish',
    fixed('a visual reply'),
  ),
  html_preview: entry(
    'Previewed',
    'Previewing',
    'Preview',
    fixed('a visual reply'),
  ),

  // Automations and check-backs
  list_jobs: listed('Automations'),
  add_job: entry(
    'Added',
    'Adding',
    'Add',
    named('Automation', 'name', 'an Automation'),
  ),
  propose_job: entry(
    'Proposed',
    'Proposing',
    'Propose',
    named('Automation', 'name', 'an Automation'),
  ),
  propose_automation_source: entry(
    'Proposed',
    'Proposing',
    'Propose',
    named('Automation source', 'name', 'an Automation source'),
  ),
  propose_automation_rule: entry(
    'Proposed',
    'Proposing',
    'Propose',
    named('Automation rule', 'name', 'an Automation rule'),
  ),
  list_automation_proposals: listed('Automation proposals'),
  update_job: entry(
    'Updated',
    'Updating',
    'Update',
    named('Automation', 'name', 'an Automation'),
  ),
  run_job: entry(
    'Ran',
    'Running',
    'Run',
    named('Automation', 'name', 'an Automation'),
  ),
  enable_job: entry(
    'Turned on',
    'Turning on',
    'Turn on',
    named('Automation', 'name', 'an Automation'),
  ),
  disable_job: entry(
    'Turned off',
    'Turning off',
    'Turn off',
    named('Automation', 'name', 'an Automation'),
  ),
  delete_job: entry(
    'Deleted',
    'Deleting',
    'Delete',
    named('Automation', 'name', 'an Automation'),
  ),
  get_job_logs: read(({ args }) => {
    const name = quoted(text(args, 'name'));
    return name ? `runs of ${name}` : 'Automation runs';
  }),
  list_scheduler_providers: listed('schedulers'),
  get_scheduler_stats: read(fixed('scheduler stats')),
  get_scheduler_status: entry(
    'Checked',
    'Checking',
    'Check',
    fixed('the scheduler'),
  ),
  preview_schedule: entry(
    'Previewed',
    'Previewing',
    'Preview',
    fixed('a schedule'),
  ),
  schedule_wake_up: entry('Scheduled', 'Scheduling', 'Schedule', ({ args }) => {
    const minutes = args.minutes;
    return typeof minutes === 'number' && Number.isFinite(minutes)
      ? `a check-back in ${minutes} min`
      : 'a check-back';
  }),
  list_wake_ups: listed('check-backs'),
  cancel_wake_up: entry(
    'Cancelled',
    'Cancelling',
    'Cancel',
    fixed('a check-back'),
  ),

  // Station
  system_status: entry('Checked', 'Checking', 'Check', fixed('Station')),
  list_models: listed('models'),
  read_logs: read(fixed('Station logs')),
  read_monitoring_events: read(fixed('monitoring events')),
  navigate_to: entry(
    'Opened',
    'Opening',
    'Open',
    ({ args }) => text(args, 'path') ?? 'a page',
  ),
  get_config: read(fixed('Station settings')),
  update_config: entry(
    'Updated',
    'Updating',
    'Update',
    fixed('Station settings'),
  ),
  get_usage: read(fixed('usage')),
  get_achievements: read(fixed('achievements')),
  coordinator_picture_read: read(fixed('the coordinator’s picture')),
  coordinator_picture_update: entry(
    'Updated',
    'Updating',
    'Update',
    fixed('the coordinator’s picture'),
  ),
  terminal_run: entry('Asked', 'Asking', 'Ask', ({ args }) => {
    const command = text(args, 'command');
    return command ? `to run ${command}` : 'to run a command';
  }),
  terminal_read: read(fixed('terminal output')),
  list_walkthroughs: listed('walkthroughs'),
  get_walkthrough: read(fixed('a walkthrough')),
  notify_user: entry('Notified', 'Notifying', 'Notify', ({ args }) => {
    const title = quoted(text(args, 'title'));
    return title ? `you: ${title}` : 'you';
  }),
  workload_status: entry(
    'Checked',
    'Checking',
    'Check',
    fixed('the workload budget'),
  ),
  get_troubleshoot_playbook: read(fixed('the troubleshooting guide')),
  draft_troubleshoot_report: entry(
    'Drafted',
    'Drafting',
    'Draft',
    fixed('a troubleshooting report'),
  ),

  // Projects
  list_projects: listed('Projects'),
  get_project: read(named('Project', 'slug', 'a Project')),
  list_project_layouts: listed('Project layouts'),

  // Delegation and environments
  list_delegation_environments: listed('delegation environments'),
  list_delegation_targets: listed('delegation targets'),
  create_ssh_environment: entry(
    'Saved',
    'Saving',
    'Save',
    fixed('an SSH environment'),
  ),
  get_ssh_environment: read(fixed('an SSH environment')),
  connect_ssh_environment: entry(
    'Connected',
    'Connecting',
    'Connect',
    fixed('an SSH environment'),
  ),
  disconnect_ssh_environment: entry(
    'Disconnected',
    'Disconnecting',
    'Disconnect',
    fixed('an SSH environment'),
  ),
  remove_ssh_environment: entry(
    'Removed',
    'Removing',
    'Remove',
    fixed('an SSH environment'),
  ),
  list_delegated_tasks: listed('delegations'),
  delegate_task: entry('Delegated', 'Delegating', 'Delegate', ({ args }) => {
    const agent = text(args, 'agent');
    return agent ? `to ${quoted(agent)}` : 'work';
  }),
  get_task: entry('Checked', 'Checking', 'Check', fixed('a delegation')),
  get_task_events: read(fixed('a delegation’s events')),
  continue_task: entry(
    'Followed up on',
    'Following up on',
    'Follow up on',
    fixed('a delegation'),
  ),
  respond_to_task_request: entry(
    'Answered',
    'Answering',
    'Answer',
    fixed('a delegation’s request'),
  ),
  interrupt_task: entry('Stopped', 'Stopping', 'Stop', fixed('a delegation')),

  // Tasks
  declare_pull_request: entry(
    'Declared',
    'Declaring',
    'Declare',
    ({ args }) => {
      // GitLab calls them merge requests, numbered with `!`.
      const gitlab = text(args, 'provider')?.toLowerCase() === 'gitlab';
      const ref = text(args, 'ref');
      if (ref && /^[1-9]\d*$/u.test(ref))
        return gitlab ? `MR !${ref}` : `PR #${ref}`;
      return gitlab ? 'a merge request' : 'a pull request';
    },
  ),
  get_task_brief: read(fixed('the Task brief')),
  task_summary_update: entry(
    'Updated',
    'Updating',
    'Update',
    fixed('the Task summary'),
  ),
  task_record: entry('Recorded', 'Recording', 'Record', ({ args }) => {
    const kind = text(args, 'kind');
    return kind ? `a ${kind.replaceAll('_', ' ')} on the Task` : 'a Task note';
  }),
  task_thread_list: listed('review threads'),
  task_thread_reply: entry(
    'Replied to',
    'Replying to',
    'Reply to',
    fixed('a review thread'),
  ),
  task_thread_resolve: entry(
    'Resolved',
    'Resolving',
    'Resolve',
    fixed('a review thread'),
  ),
  read_pull_request_guide: read(fixed('the pull request guide')),
  write_pull_request_guides: entry(
    'Wrote',
    'Writing',
    'Write',
    fixed('pull request guides'),
  ),

  // Integrations and plugins
  list_integrations: listed('Integrations'),
  get_integration: read(named('Integration', 'id', 'an Integration')),
  create_integration: entry(
    'Added',
    'Adding',
    'Add',
    named('Integration', 'id', 'an Integration'),
  ),
  delete_integration: entry(
    'Removed',
    'Removing',
    'Remove',
    named('Integration', 'id', 'an Integration'),
  ),
  list_registry_integrations: listed('Integrations in the registry'),
  install_registry_integration: entry(
    'Installed',
    'Installing',
    'Install',
    named('Integration', 'id', 'an Integration'),
  ),
  list_providers: listed('model providers'),
  create_provider: entry(
    'Added',
    'Adding',
    'Add',
    named('model provider', 'name', 'a model provider'),
  ),
  list_plugins: listed('Plugins'),
  install_plugin: entry(
    'Installed',
    'Installing',
    'Install',
    fixed('a Plugin'),
  ),
  propose_plugin_install: entry(
    'Proposed',
    'Proposing',
    'Propose',
    fixed('a Plugin install'),
  ),
  validate_plugin: entry(
    'Validated',
    'Validating',
    'Validate',
    fixed('a Plugin'),
  ),
  check_plugin_updates: entry(
    'Checked',
    'Checking',
    'Check',
    fixed('for Plugin updates'),
  ),
  update_plugin: entry(
    'Updated',
    'Updating',
    'Update',
    named('Plugin', 'name', 'a Plugin'),
  ),
  remove_plugin: entry(
    'Removed',
    'Removing',
    'Remove',
    named('Plugin', 'name', 'a Plugin'),
  ),

  // Knowledge
  reindex_knowledge: entry(
    'Reindexed',
    'Reindexing',
    'Reindex',
    fixed('knowledge'),
  ),
  search_knowledge: entry('Searched', 'Searching', 'Search', ({ args }) => {
    const query = quoted(text(args, 'query'));
    return query ? `knowledge for ${query}` : 'knowledge';
  }),
  migrate_knowledge: entry(
    'Migrated',
    'Migrating',
    'Migrate',
    fixed('knowledge'),
  ),
  list_knowledge_roots: listed('knowledge sources'),
  list_knowledge_records: listed('knowledge records'),
  get_knowledge_record: read(fixed('a knowledge record')),
  // Default-off (STATION_EXPERIMENTAL_S3_SOURCES): a Project's S3 sources.
  list_project_s3_sources: listed('the Project’s S3 sources'),
  list_project_s3_objects: listed('S3 objects'),
  read_project_s3_object: read(fixed('an S3 object')),
  add_knowledge_record: entry('Added', 'Adding', 'Add', ({ args }) => {
    const title = quoted(text(args, 'title'));
    return title ? `knowledge: ${title}` : 'a knowledge record';
  }),
};

/** Every tool the table words, for the server's coverage test. */
export function stationToolPhraseNames(): string[] {
  return Object.keys(STATION_TOOL_PHRASES);
}

const QUALIFIED_NAME = new RegExp(
  `^(?:mcp__(${STATION_TOOL_SERVERS.join('|')})__|(${STATION_TOOL_SERVERS.join('|')})[_/.]|Tool: (${STATION_TOOL_SERVERS.join('|')})/)([A-Za-z0-9_-]+)$`,
);

/**
 * The Station tool a call is, by its name as any engine spells it
 * (`mcp__station-control__x`, `station-control/x`, …) or by a bare name plus
 * the engine's `server` field. A bare name alone is never claimed.
 */
export function stationToolOf(
  toolName: string | undefined,
  server?: string,
): { server: StationToolServer; tool: string } | undefined {
  if (typeof toolName !== 'string') return undefined;
  const name = toolName.trim();
  const qualified = QUALIFIED_NAME.exec(name);
  if (qualified) {
    const found = (qualified[1] ?? qualified[2] ?? qualified[3]) as
      | StationToolServer
      | undefined;
    const tool = qualified[4];
    return found && tool ? { server: found, tool } : undefined;
  }
  if (
    typeof server === 'string' &&
    (STATION_TOOL_SERVERS as readonly string[]).includes(server) &&
    /^[A-Za-z0-9_-]+$/u.test(name)
  )
    return { server: server as StationToolServer, tool: name };
  return undefined;
}

function argumentsOf(args: unknown): Args {
  if (typeof args === 'string') {
    try {
      return argumentsOf(JSON.parse(args));
    } catch {
      return {};
    }
  }
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Args)
    : {};
}

/** The call's phrase for its phase, or `undefined` for an unworded tool. */
export function stationToolPhrase(
  tool: string,
  phase: StationToolPhase,
  input: StationToolPhraseInput = {},
): string | undefined {
  const phrase = Object.hasOwn(STATION_TOOL_PHRASES, tool)
    ? STATION_TOOL_PHRASES[tool]
    : undefined;
  if (!phrase) return undefined;
  const verb = phrase.verbs[phase === 'done' ? 0 : phase === 'running' ? 1 : 2];
  const object = phrase.object?.({
    args: argumentsOf(input.args),
    ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
  });
  return object ? `${verb} ${object}` : verb;
}
