/** Messaging authority and receipts share the registered orchestration database. */
export const CHAT_APPS_MIGRATION = `
CREATE TABLE IF NOT EXISTS chat_app_imports (
  app TEXT PRIMARY KEY CHECK (app IN ('discord','slack')),
  imported_at TEXT NOT NULL,
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;
CREATE TABLE IF NOT EXISTS chat_identity_links (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL CHECK (app IN ('discord','slack')),
  external_user_id TEXT NOT NULL,
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;
CREATE INDEX IF NOT EXISTS chat_identity_link_head
  ON chat_identity_links(app, external_user_id, sequence DESC);
CREATE TABLE IF NOT EXISTS chat_channel_bindings (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL CHECK (app IN ('discord','slack')),
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;
CREATE INDEX IF NOT EXISTS chat_channel_binding_head
  ON chat_channel_bindings(app, workspace_id, channel_id, thread_id, sequence DESC);
CREATE TABLE IF NOT EXISTS chat_app_kill_switches (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL CHECK (app IN ('discord','slack')),
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;
CREATE INDEX IF NOT EXISTS chat_app_kill_switch_head
  ON chat_app_kill_switches(app, sequence DESC);
CREATE TABLE IF NOT EXISTS chat_delivery_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;
CREATE INDEX IF NOT EXISTS chat_delivery_log_head ON chat_delivery_log(id, sequence DESC);
${[
  'chat_app_imports',
  'chat_identity_links',
  'chat_channel_bindings',
  'chat_app_kill_switches',
  'chat_delivery_log',
]
  .map(
    (table) => `
CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'chat app records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'chat app records are append-only'); END;`,
  )
  .join('\n')}
`;
