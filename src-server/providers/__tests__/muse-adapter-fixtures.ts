/**
 * Verbatim JSONL records captured from live `muse exec --json` runs against
 * muse 0.1.0-R708.1 (echo provider and the meta provider). These are copied
 * byte-for-byte out of the probe capture rather than hand-written, so a test
 * that passes here is a test against a shape muse actually emits.
 */

/** `--provider echo`, prompt "say hello". */
export const MUSE_ECHO_COMMAND_ACCEPTED =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c350","stream":{"kind":"session","id":"de67bd1d-949a-4552-8362-30c06b1991d0"},"sequence":1,"recorded_at":1780531400000000,"record_type":"reconciliation","durability":"durable","causation_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","payload_type":"runtime.command.accepted","payload_schema_version":1,"payload":{"kind":"command_accepted","command_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","client_id":null,"command_kind":"turn.submit"}}';

export const MUSE_ECHO_SESSION_RUN_LINKED =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c351","stream":{"kind":"session","id":"de67bd1d-949a-4552-8362-30c06b1991d0"},"sequence":2,"recorded_at":1780531400000001,"record_type":"event","durability":"durable","causation_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","payload_type":"session.run.linked","payload_schema_version":1,"payload":{"kind":"session_run_linked","command_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","run_stream":{"kind":"run","id":"109b6f40-7261-430b-ad17-bed7b80c7ebe"}}}';

export const MUSE_ECHO_RUN_STARTED =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c354","stream":{"kind":"session","id":"de67bd1d-949a-4552-8362-30c06b1991d0"},"sequence":4,"recorded_at":1780531400000004,"record_type":"event","durability":"durable","causation_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","payload_type":"run.lifecycle.started","payload_schema_version":1,"payload":{"kind":"run_started","command_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","run_stream":{"kind":"run","id":"109b6f40-7261-430b-ad17-bed7b80c7ebe"},"prompt":"say hello"}}';

export const MUSE_ECHO_TASK_LIFECYCLE =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c366","stream":{"kind":"session","id":"de67bd1d-949a-4552-8362-30c06b1991d0"},"sequence":13,"recorded_at":1780531400000022,"record_type":"event","durability":"durable","causation_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","payload_type":"task.lifecycle.side_effect_intent","payload_schema_version":1,"payload":{"kind":"task_lifecycle","command_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","run_stream":{"kind":"run","id":"109b6f40-7261-430b-ad17-bed7b80c7ebe"},"task_stream":{"kind":"task","id":"fa2007a2-344f-449a-8194-a76a7a83707b"},"task_id":"fa2007a2-344f-449a-8194-a76a7a83707b","event":{"kind":"side_effect_intent","task_id":"fa2007a2-344f-449a-8194-a76a7a83707b","operation":"model.unknown.response","idempotency_key":"model:109b6f40-7261-430b-ad17-bed7b80c7ebe:fa2007a2-344f-449a-8194-a76a7a83707b","policy_decision":"not_applicable","cancellation_handle":null,"parent_task_id":null}}}';

export const MUSE_ECHO_OUTPUT_DELTA =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c36a","stream":{"kind":"session","id":"de67bd1d-949a-4552-8362-30c06b1991d0"},"sequence":15,"recorded_at":1780531400000026,"record_type":"status","durability":"ephemeral","causation_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","payload_type":"run.output.delta","payload_schema_version":1,"payload":{"kind":"run_output_delta","command_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","run_stream":{"kind":"run","id":"109b6f40-7261-430b-ad17-bed7b80c7ebe"},"text":"echo: say hello"}}';

export const MUSE_ECHO_RUN_TERMINAL =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c37a","stream":{"kind":"session","id":"de67bd1d-949a-4552-8362-30c06b1991d0"},"sequence":23,"recorded_at":1780531400000042,"record_type":"event","durability":"durable","causation_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","payload_type":"run.terminal.completed","payload_schema_version":1,"payload":{"kind":"run_terminal","command_id":"109b6f40-7261-430b-ad17-bed7b80c7ebe","run_stream":{"kind":"run","id":"109b6f40-7261-430b-ad17-bed7b80c7ebe"},"terminal":"completed","text":"echo: say hello","reason":null}}';

/** Live meta provider, prompt "hi" — the two-delta run. */
export const MUSE_META_MODEL_CONFIGURED =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c352","stream":{"kind":"session","id":"24728747-3581-4ad4-9a68-67388095cf2e"},"sequence":3,"recorded_at":1780531400000002,"record_type":"event","durability":"durable","causation_id":"07876569-c48b-4dba-93e0-3be7f613b26a","payload_type":"run.model.configured","payload_schema_version":1,"payload":{"kind":"run_model_configured","command_id":"07876569-c48b-4dba-93e0-3be7f613b26a","run_stream":{"kind":"run","id":"07876569-c48b-4dba-93e0-3be7f613b26a"},"provider_id":"meta","profile_id":"tbh","model_id":"muse-spark-1.2-contributor","display_label":"muse-spark-1.2-contributor","source":"startup"}}';

export const MUSE_META_OUTPUT_DELTA_1 =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c36e","stream":{"kind":"session","id":"24728747-3581-4ad4-9a68-67388095cf2e"},"sequence":17,"recorded_at":1780531400000030,"record_type":"status","durability":"ephemeral","causation_id":"07876569-c48b-4dba-93e0-3be7f613b26a","payload_type":"run.output.delta","payload_schema_version":1,"payload":{"kind":"run_output_delta","command_id":"07876569-c48b-4dba-93e0-3be7f613b26a","run_stream":{"kind":"run","id":"07876569-c48b-4dba-93e0-3be7f613b26a"},"text":"hi — what can I help with"}}';

export const MUSE_META_OUTPUT_DELTA_2 =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c370","stream":{"kind":"session","id":"24728747-3581-4ad4-9a68-67388095cf2e"},"sequence":18,"recorded_at":1780531400000032,"record_type":"status","durability":"ephemeral","causation_id":"07876569-c48b-4dba-93e0-3be7f613b26a","payload_type":"run.output.delta","payload_schema_version":1,"payload":{"kind":"run_output_delta","command_id":"07876569-c48b-4dba-93e0-3be7f613b26a","run_stream":{"kind":"run","id":"07876569-c48b-4dba-93e0-3be7f613b26a"},"text":"?"}}';

export const MUSE_META_RUN_TERMINAL =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c382","stream":{"kind":"session","id":"24728747-3581-4ad4-9a68-67388095cf2e"},"sequence":27,"recorded_at":1780531400000050,"record_type":"event","durability":"durable","causation_id":"07876569-c48b-4dba-93e0-3be7f613b26a","payload_type":"run.terminal.completed","payload_schema_version":1,"payload":{"kind":"run_terminal","command_id":"07876569-c48b-4dba-93e0-3be7f613b26a","run_stream":{"kind":"run","id":"07876569-c48b-4dba-93e0-3be7f613b26a"},"terminal":"completed","text":"hi — what can I help with?","reason":null}}';

/** The captured meta run's full assistant text (both deltas concatenated). */
export const MUSE_META_FULL_TEXT = 'hi — what can I help with?';

/**
 * Verbatim `tool_result` record from a live `muse exec --json` turn that ran
 * the `read_file` tool (session id scrubbed). This is the only payload in the
 * live stream that names a tool, carries its output, and reports an outcome.
 */
export const MUSE_TOOL_RESULT =
  '{"schema_version":1,"id":"018f0000-0000-7000-8000-00000000c382","stream":{"kind":"session","id":"00000000-0000-4000-8000-000000000001"},"sequence":27,"recorded_at":1780531400000050,"record_type":"event","durability":"durable","causation_id":"a41cc0bf-db1b-4e0c-b949-d914073121a1","payload_type":"tool.result","payload_schema_version":1,"payload":{"kind":"tool_result","command_id":"a41cc0bf-db1b-4e0c-b949-d914073121a1","run_stream":{"kind":"run","id":"a41cc0bf-db1b-4e0c-b949-d914073121a1"},"call_id":"call_019feab717fd75639b5a008d7b2c3e09","text":"Read text file `probe.txt`.\\n1|hello from probe","correlation_facts":{"tool_name":"read_file","outcome":"success"}}}';
