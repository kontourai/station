/** Task review is append-only and isolated by Task incarnation (#4007, #4055). */
export const TASK_REVIEW_MIGRATION = `
-- 023-task-review.ts  (orchestration DB; incarnation = task_id + task_created_at)
CREATE TABLE IF NOT EXISTS task_review_threads (
  thread_id TEXT PRIMARY KEY,                        -- uuid v4
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, task_created_at TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),     -- per-incarnation order
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('plan','summary','output','answer','capture')),
  artifact_id TEXT NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 512),
       -- plan: documentId; summary: 'summary'; output: outputId; answer: sessionId+'/'+turnId; capture: captureId
  artifact_revision TEXT NOT NULL CHECK (length(artifact_revision) BETWEEN 1 AND 256),
       -- plan: working-state revision string (NOT a revision-evidence receipt); summary: revision int;
       -- output/capture: sha256 digest; answer: turnId
  artifact_digest TEXT NOT NULL CHECK (artifact_digest GLOB 'sha256:*'),  -- digest of text/bytes at that revision
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('text-quote','block','region','whole')),
  anchor_json TEXT NOT NULL CHECK (length(anchor_json) <= 4096),
       -- text-quote {start,end,exact,prefix,suffix}; block {startLine,endLine}; region {x,y,w,h} in [0,1]
  quote TEXT CHECK (quote IS NULL OR length(quote) BETWEEN 1 AND 2000),   -- retained for Outdated display
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person','session')),
  author_id TEXT NOT NULL CHECK (length(author_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL,                        -- client idempotency
  created_at TEXT NOT NULL,
  UNIQUE (task_id, task_created_at, ordinal),
  UNIQUE (task_id, task_created_at, operation_id),
  CHECK ((anchor_kind = 'region') = (artifact_kind = 'capture') OR anchor_kind = 'whole')
);
CREATE TABLE IF NOT EXISTS task_review_events (
  thread_id TEXT NOT NULL REFERENCES task_review_threads(thread_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),     -- 1 = the opening comment
  kind TEXT NOT NULL CHECK (kind IN ('comment','reply','sent','send-failed','agent-reply','resolved','reopened')),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person','session')),
  author_id TEXT NOT NULL,
  body TEXT CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4000),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  evidence_json TEXT CHECK (evidence_json IS NULL OR length(evidence_json) <= 4096),
       -- {commit?, commitVerified, gateRefs?[{runId,gateId,evaluationId}], receiptRefs?[], captureId?}
  delivery_key TEXT,                                 -- inbox clientTurnId for 'sent'
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, ordinal),
  UNIQUE (thread_id, operation_id),
  CHECK ((kind = 'comment') = (ordinal = 1)),
  CHECK ((delivery_key IS NOT NULL) = (kind = 'sent')),
  CHECK (kind NOT IN ('agent-reply') OR author_kind = 'session'),
  CHECK (kind NOT IN ('reopened','sent') OR author_kind = 'person'),
  CHECK ((reason IS NOT NULL) = (kind IN ('resolved','send-failed')) OR kind = 'reopened'),
  CHECK (body IS NOT NULL OR kind IN ('sent','send-failed','resolved','reopened'))
);
CREATE TABLE IF NOT EXISTS task_review_captures (
  capture_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, task_created_at TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('browser','device')),
  source_session_id TEXT NOT NULL,                   -- browserSessionId / deviceSessionId
  page_url TEXT CHECK (page_url IS NULL OR length(page_url) <= 2048),   -- capUrl()'d
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png','image/jpeg')),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
  digest TEXT NOT NULL CHECK (digest GLOB 'sha256:*'),
  width INTEGER, height INTEGER, label TEXT CHECK (label IS NULL OR length(label) <= 120),
  author_kind TEXT NOT NULL, author_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, task_created_at, operation_id)
);
CREATE TRIGGER IF NOT EXISTS task_review_threads_no_update BEFORE UPDATE ON task_review_threads
BEGIN SELECT RAISE(ABORT, 'task review is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_review_threads_no_delete BEFORE DELETE ON task_review_threads
BEGIN SELECT RAISE(ABORT, 'task review is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_review_events_no_update BEFORE UPDATE ON task_review_events
BEGIN SELECT RAISE(ABORT, 'task review is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_review_events_no_delete BEFORE DELETE ON task_review_events
BEGIN SELECT RAISE(ABORT, 'task review is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_review_captures_no_update BEFORE UPDATE ON task_review_captures
BEGIN SELECT RAISE(ABORT, 'task review is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_review_captures_no_delete BEFORE DELETE ON task_review_captures
BEGIN SELECT RAISE(ABORT, 'task review is append-only'); END;
CREATE INDEX IF NOT EXISTS idx_task_review_threads_incarnation ON task_review_threads(task_id, task_created_at, ordinal);
CREATE INDEX IF NOT EXISTS idx_task_review_captures_incarnation ON task_review_captures(task_id, task_created_at, created_at);
`;
