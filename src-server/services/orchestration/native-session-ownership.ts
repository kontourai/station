/** Private native identities never become credentials or public Session ids. */
export interface NativeSessionOwnership {
  assertMutable(sessionId: string): void;
  claim(
    identityKey: string,
    sessionId: string,
    allowProfileRebind?: boolean,
  ): void;
  retired(sessionId: string): void;
}

export const NATIVE_SESSION_OWNERSHIP_MIGRATION = `
CREATE TABLE IF NOT EXISTS orchestration_native_session_owners (
  identity_key TEXT NOT NULL PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  pending_session_id TEXT
);
CREATE TABLE IF NOT EXISTS orchestration_native_session_bindings (
  session_id TEXT NOT NULL PRIMARY KEY,
  identity_key TEXT NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_native_session_binding_identity
  ON orchestration_native_session_bindings(identity_key);
`;
