-- AMIN CHAT — initial schema (Cloudflare D1 / SQLite)
-- All timestamps are INTEGER milliseconds since the Unix epoch (UTC).
-- All JSON columns are TEXT holding JSON.

------------------------------------------------------------------------------
-- Identity & sessions
------------------------------------------------------------------------------
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name      TEXT NOT NULL,
  password_hash     TEXT,                                   -- NULL for system/AI users
  kind              TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'ai')),
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  verified          INTEGER NOT NULL DEFAULT 0,             -- verified-AI badge for the official assistant
  bio               TEXT,
  locale            TEXT NOT NULL DEFAULT 'fa',
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  e2ee_public_key   TEXT,                                   -- JWK (ECDH P-256 public key) for secret chats
  created_at        INTEGER NOT NULL,
  disabled_at       INTEGER
);
CREATE INDEX idx_users_display_name ON users (display_name COLLATE NOCASE);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,                       -- SHA-256 of the bearer token; the token itself is never stored
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  user_agent    TEXT,
  revoked_at    INTEGER
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

------------------------------------------------------------------------------
-- Conversations (AI contact, direct chats, groups)
------------------------------------------------------------------------------
CREATE TABLE conversations (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL CHECK (type IN ('ai', 'direct', 'group')),
  title             TEXT,
  created_by        TEXT REFERENCES users (id),
  e2ee              INTEGER NOT NULL DEFAULT 0,             -- end-to-end encrypted (direct chats only)
  direct_key        TEXT UNIQUE,                            -- canonical key that prevents duplicate AI/direct conversations
  -- Group-level AI policy (set by owner/admins). Ignored for direct chats (per-member settings apply).
  ai_level          TEXT NOT NULL DEFAULT 'off' CHECK (ai_level IN ('off', 'mention', 'context', 'assist')),
  ai_invoke_roles   TEXT NOT NULL DEFAULT 'all' CHECK (ai_invoke_roles IN ('all', 'admins')),
  created_at        INTEGER NOT NULL,
  last_message_id   TEXT,
  last_message_at   INTEGER
);

CREATE TABLE conversation_members (
  conversation_id   TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at         INTEGER NOT NULL,
  pinned            INTEGER NOT NULL DEFAULT 0,
  muted             INTEGER NOT NULL DEFAULT 0,
  last_read_at      INTEGER NOT NULL DEFAULT 0,
  -- Per-member AI consent for this conversation (direct chats). 'off' is the default: AI cannot read the chat.
  ai_access         TEXT NOT NULL DEFAULT 'off' CHECK (ai_access IN ('off', 'mention', 'context')),
  -- Any participant may forbid AI processing of a direct chat for everybody.
  ai_blocked        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_members_user ON conversation_members (user_id);

------------------------------------------------------------------------------
-- AI threads (sessions inside the permanent AMIN AI conversation)
------------------------------------------------------------------------------
CREATE TABLE ai_threads (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  title             TEXT,
  kind              TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'reminders')),
  agent_id          TEXT NOT NULL DEFAULT 'auto',
  model_id          TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER
);
CREATE INDEX idx_threads_user ON ai_threads (user_id, updated_at DESC);

------------------------------------------------------------------------------
-- Messages & files
------------------------------------------------------------------------------
CREATE TABLE messages (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,      -- stable integer key; also the rowid of the FTS index row
  id                TEXT NOT NULL UNIQUE,
  conversation_id   TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  thread_id         TEXT REFERENCES ai_threads (id) ON DELETE CASCADE,
  sender_id         TEXT NOT NULL REFERENCES users (id),
  kind              TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system', 'poll')),
  body              TEXT,                                   -- plaintext; NULL for end-to-end encrypted messages
  cipher            TEXT,                                   -- JSON {v, iv, ct} for end-to-end encrypted messages
  reply_to_id       TEXT,
  via_ai            INTEGER NOT NULL DEFAULT 0,             -- posted by an agent on behalf of the user after explicit approval
  status            TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('streaming', 'sent', 'failed', 'cancelled')),
  meta              TEXT,                                   -- JSON: ai info, poll definition, shared excerpts, system event
  edited_at         INTEGER,
  deleted_at        INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv ON messages (conversation_id, created_at, id);
CREATE INDEX idx_messages_thread ON messages (thread_id, created_at, id);

CREATE TABLE files (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  r2_key            TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  mime              TEXT NOT NULL,
  size              INTEGER NOT NULL,
  sha256            TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'document', 'text', 'archive', 'other')),
  category          TEXT,                                   -- set only with the user's approval (file agent)
  conversation_id   TEXT REFERENCES conversations (id) ON DELETE SET NULL,
  message_id        TEXT REFERENCES messages (id) ON DELETE SET NULL,
  source            TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'ai')),
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX idx_files_owner ON files (owner_id, created_at DESC);
CREATE INDEX idx_files_message ON files (message_id);

-- Cached results of AI processing of a file (document text, audio transcript, image description)
CREATE TABLE file_derivatives (
  file_id           TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('text', 'transcript', 'caption')),
  content           TEXT NOT NULL,
  model_id          TEXT,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (file_id, kind)
);

CREATE TABLE poll_votes (
  message_id        TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  option_id         TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, option_id)
);

-- Full-text search over messages. rowid = messages.seq. Rows are written by application code
-- (text is normalised first, see lib/text.ts normalizeForSearch).
CREATE VIRTUAL TABLE message_fts USING fts5 (
  conversation_id UNINDEXED,
  thread_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

------------------------------------------------------------------------------
-- Runs: every AI interaction (chat completion, agent task, in-chat assistance)
------------------------------------------------------------------------------
CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('chat', 'task', 'assist')),
  agent_id            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'planning', 'awaiting_approval', 'running', 'completed', 'failed', 'cancelled')),
  goal                TEXT NOT NULL,
  conversation_id     TEXT REFERENCES conversations (id) ON DELETE SET NULL,
  thread_id           TEXT REFERENCES ai_threads (id) ON DELETE SET NULL,
  trigger_message_id  TEXT,
  result_message_id   TEXT,
  model_id            TEXT,
  options             TEXT,                                 -- JSON: model override, locale, shared excerpts reference...
  plan                TEXT,                                 -- JSON: planner output
  result              TEXT,
  error               TEXT,
  error_code          TEXT,
  cancel_requested    INTEGER NOT NULL DEFAULT 0,
  resumes             INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  started_at          INTEGER,
  finished_at         INTEGER,
  heartbeat_at        INTEGER
);
CREATE INDEX idx_runs_user ON runs (user_id, created_at DESC);
CREATE INDEX idx_runs_status ON runs (status, heartbeat_at);

CREATE TABLE run_steps (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  idx               INTEGER NOT NULL,
  title             TEXT NOT NULL,
  tool              TEXT NOT NULL,
  args              TEXT,                                   -- JSON (as planned; templates resolved at execution time)
  resolved_args     TEXT,                                   -- JSON actually executed
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'skipped', 'cancelled')),
  risk              TEXT NOT NULL DEFAULT 'read' CHECK (risk IN ('read', 'write', 'sensitive')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  output            TEXT,                                   -- JSON (bounded)
  error             TEXT,
  error_code        TEXT,
  verified          INTEGER NOT NULL DEFAULT 0,             -- 1 only if the tool confirmed the effect by re-reading state
  started_at        INTEGER,
  finished_at       INTEGER,
  UNIQUE (run_id, idx)
);

CREATE TABLE run_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  step_id           TEXT,
  ts                INTEGER NOT NULL,
  level             TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  type              TEXT NOT NULL,
  data              TEXT
);
CREATE INDEX idx_run_events_run ON run_events (run_id, id);

CREATE TABLE approvals (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  step_id           TEXT NOT NULL REFERENCES run_steps (id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  action            TEXT NOT NULL,                          -- tool id
  summary           TEXT NOT NULL,
  payload           TEXT NOT NULL,                          -- JSON: the exact arguments that will be executed
  payload_hash      TEXT NOT NULL,
  editable          TEXT,                                   -- JSON array of argument names the user may edit before approving
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  decided_at        INTEGER
);
CREATE INDEX idx_approvals_user ON approvals (user_id, status);
CREATE UNIQUE INDEX idx_approvals_step ON approvals (step_id);

------------------------------------------------------------------------------
-- Memory (long-term, per user, user-approved). Short-term memory = thread history.
------------------------------------------------------------------------------
CREATE TABLE memory_settings (
  user_id               TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  enabled               INTEGER NOT NULL DEFAULT 1,
  auto_suggest          INTEGER NOT NULL DEFAULT 1,
  allow_history_recall  INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE memories (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('preference', 'project', 'fact', 'other')),
  content           TEXT NOT NULL,
  project           TEXT,
  source            TEXT NOT NULL CHECK (source IN ('user', 'ai_approved')),
  source_run_id     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_memories_user ON memories (user_id, updated_at DESC);

CREATE TABLE memory_suggestions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('preference', 'project', 'fact', 'other')),
  content           TEXT NOT NULL,
  project           TEXT,
  reason            TEXT,
  run_id            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at        INTEGER NOT NULL,
  decided_at        INTEGER
);
CREATE INDEX idx_memsug_user ON memory_suggestions (user_id, status);

------------------------------------------------------------------------------
-- Personal agent data
------------------------------------------------------------------------------
CREATE TABLE todos (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  notes             TEXT,
  due_at            INTEGER,
  priority          TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  project           TEXT,
  source_run_id     TEXT,
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER
);
CREATE INDEX idx_todos_user ON todos (user_id, status, due_at);

CREATE TABLE reminders (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  text                TEXT NOT NULL,
  remind_at           INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'delivering', 'delivered', 'cancelled', 'failed')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  delivered_at        INTEGER,
  delivery_message_id TEXT,
  source_run_id       TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders (status, remind_at);
CREATE INDEX idx_reminders_user ON reminders (user_id, status);

CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  goal              TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  plan              TEXT,                                   -- JSON: milestones
  source_run_id     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

------------------------------------------------------------------------------
-- Models, usage & quotas
------------------------------------------------------------------------------
CREATE TABLE ai_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  run_id            TEXT,
  model_id          TEXT NOT NULL,
  role              TEXT NOT NULL,                          -- chat | fast | code | vision | asr | embedding | image | convert
  purpose           TEXT,                                   -- chat | plan | route | title | memory | tool | health ...
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  estimated         INTEGER NOT NULL DEFAULT 0,             -- token counts estimated locally (model did not report usage)
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL CHECK (status IN ('ok', 'error', 'fallback')),
  error_code        TEXT,
  day               TEXT NOT NULL,                          -- YYYY-MM-DD (UTC)
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_usage_user_day ON ai_usage (user_id, day);

CREATE TABLE user_quotas (
  user_id           TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  daily_tokens      INTEGER,
  daily_requests    INTEGER,
  monthly_tokens    INTEGER,
  updated_by        TEXT,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE model_health (
  model_id          TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN ('available', 'unavailable', 'unknown')),
  reason            TEXT,
  catalog_listed    INTEGER,                                -- 1/0 when env.AI.models() could be consulted, NULL otherwise
  latency_ms        INTEGER,
  checked_at        INTEGER NOT NULL
);

------------------------------------------------------------------------------
-- Audit log (never stores message content)
------------------------------------------------------------------------------
CREATE TABLE audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT,
  action            TEXT NOT NULL,
  target_type       TEXT,
  target_id         TEXT,
  meta              TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_audit_user ON audit_log (user_id, created_at DESC);

------------------------------------------------------------------------------
-- Seed: the permanent, verified AMIN AI contact (system user, cannot log in)
------------------------------------------------------------------------------
INSERT INTO users (id, username, display_name, password_hash, kind, role, verified, bio, locale, timezone, created_at)
VALUES ('usr_amin_ai', 'aminai', 'AMIN AI', NULL, 'ai', 'user', 1,
        'Official AI assistant of AMIN CHAT. Responses are generated by AI models running on Cloudflare Workers AI.',
        'fa', 'UTC', 0);
