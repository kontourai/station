/** Task review is append-only and isolated by Task incarnation (#4007, #4055). */
export const TASK_REVIEW_MIGRATION = `
-- 023-task-review.ts  (orchestration DB; incarnation = task_id + task_created_at)
CREATE TABLE IF NOT EXISTS task_review_threads (
  thread_id TEXT PRIMARY KEY,                        -- uuid v4
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, task_created_at TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),     -- per-incarnation order
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('plan','summary','output','answer','capture')),
  artifact_id TEXT NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 512),
       -- plan: documentId; summary: 'summary'; output: outputId; answer: turnId; capture: captureId
  artifact_session_id TEXT CHECK (artifact_session_id IS NULL OR length(artifact_session_id) BETWEEN 1 AND 512),
       -- structured answer sessionId; only answer rows set this column
  artifact_revision TEXT NOT NULL CHECK (length(artifact_revision) BETWEEN 1 AND 256),
       -- plan: working-state revision string (NOT a revision-evidence receipt); summary: decimal integer mapped back to number;
       -- output: sha256 digest; capture: clean commit SHA; answer: turnId
  artifact_digest TEXT NOT NULL CHECK (artifact_digest GLOB 'sha256:*'),  -- digest of text/bytes at that revision
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('text-quote','block','region','whole')),
  anchor_json TEXT NOT NULL CHECK (length(anchor_json) <= 4096),
       -- text-quote {start,end,exact,prefix,suffix}; block {startLine,endLine}; region {x,y,w,h} in [0,1]
  quote TEXT CHECK (quote IS NULL OR length(quote) BETWEEN 1 AND 2000),   -- retained for Outdated display
  author_kind TEXT NOT NULL CHECK (author_kind='person'),
  author_id TEXT NOT NULL CHECK (length(author_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),                        -- client idempotency
  created_at TEXT NOT NULL,
  UNIQUE (task_id, task_created_at, ordinal),
  UNIQUE (task_id, task_created_at, operation_id),
  CHECK ((artifact_kind='answer') = (artifact_session_id IS NOT NULL)),
  CHECK (artifact_kind != 'summary' OR
    (artifact_revision GLOB '[1-9]*' AND artifact_revision NOT GLOB '*[^0-9]*' AND CAST(artifact_revision AS INTEGER) BETWEEN 1 AND 9007199254740991)),
  CHECK (json_valid(anchor_json) AND json_extract(anchor_json, '$.kind') IS anchor_kind),
  CHECK (anchor_kind NOT IN ('whole','region') OR quote IS NULL),
  CHECK (anchor_kind != 'block' OR quote IS NOT NULL),
  CHECK ((anchor_kind = 'region') = (artifact_kind = 'capture') OR anchor_kind = 'whole')
);
CREATE TABLE IF NOT EXISTS task_review_events (
  thread_id TEXT NOT NULL REFERENCES task_review_threads(thread_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),     -- 1 = the opening comment
  kind TEXT NOT NULL CHECK (kind IN ('comment','reply','sent','send-failed','agent-reply','resolved','reopened')),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person','session')),
  author_id TEXT NOT NULL CHECK (length(author_id) BETWEEN 1 AND 256),
  body TEXT CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4000),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  evidence_json TEXT CHECK (evidence_json IS NULL OR length(evidence_json) <= 4096),
       -- {commit?, commitVerified, gateRefs?[{runId,gateId,evaluationId}], receiptRefs?[], captureId?}
  delivery_key TEXT,                                 -- correlated inbox clientTurnId for sent/agent-reply/send-failed
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, ordinal),
  UNIQUE (thread_id, operation_id),
  CHECK ((kind = 'comment') = (ordinal = 1)),
  CHECK ((delivery_key IS NOT NULL) = (kind IN ('sent','agent-reply','send-failed'))),
  CHECK (delivery_key IS NULL OR length(delivery_key) BETWEEN 1 AND 512),
  CHECK (kind NOT IN ('comment','reply') OR author_kind='person'),
  CHECK (kind NOT IN ('agent-reply') OR author_kind = 'session'),
  CHECK (kind NOT IN ('reopened','sent','send-failed') OR author_kind = 'person'),
  CHECK ((reason IS NOT NULL) = (kind IN ('resolved','send-failed')) OR kind = 'reopened'),
  CHECK ((body IS NOT NULL) = (kind IN ('comment','reply','agent-reply'))),
  CHECK (evidence_json IS NULL OR kind='agent-reply')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_review_sent_key
ON task_review_events(thread_id, delivery_key) WHERE kind='sent';
CREATE TRIGGER IF NOT EXISTS task_review_events_next_ordinal BEFORE INSERT ON task_review_events
WHEN NEW.ordinal != COALESCE((SELECT MAX(ordinal) FROM task_review_events WHERE thread_id=NEW.thread_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'task review event ordinal must be max+1'); END;
CREATE TRIGGER IF NOT EXISTS task_review_agent_reply_sent BEFORE INSERT ON task_review_events
WHEN NEW.kind='agent-reply' AND NOT EXISTS (
  SELECT 1 FROM task_review_events WHERE thread_id=NEW.thread_id
  AND kind='sent' AND delivery_key=NEW.delivery_key AND ordinal < NEW.ordinal
)
BEGIN SELECT RAISE(ABORT, 'agent reply must match an earlier sent event in the same thread'); END;
CREATE TABLE IF NOT EXISTS task_review_captures (
  capture_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, task_created_at TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('browser','device')),
  source_session_id TEXT NOT NULL CHECK (length(source_session_id) BETWEEN 1 AND 512),                   -- browserSessionId / deviceSessionId
  page_url TEXT CHECK (page_url IS NULL OR length(page_url) <= 2048),   -- capUrl()'d
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png','image/jpeg')),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
  digest TEXT NOT NULL CHECK (digest GLOB 'sha256:*'),
  width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 32768),
  height INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 32768),
  label TEXT CHECK (label IS NULL OR length(label) <= 120),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person','session')),
  author_id TEXT NOT NULL CHECK (length(author_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
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
