-- 002: tables for authentication and authorization.
-- Migration 001 is never edited once applied; changes to existing tables go in NEW files like this one.

-- Roles for authorization, and the moment the password last changed
-- (used to reject tokens issued before a password reset).
ALTER TABLE users
  ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  ADD COLUMN password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The app lowercases emails; the database refuses anything that slipped through,
  -- so "Ann@x.com" and "ann@x.com" can never become two accounts.
  ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));

-- One row per logged-in device/browser.
CREATE TABLE sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(), -- unguessable, safe to put in a JWT
  user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent    TEXT,                                             -- e.g. "Chrome on Windows", for the device list
  ip            TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,                             -- absolute limit: re-login required after this
  revoked_at    TIMESTAMPTZ,                                      -- NULL = still active
  revoke_reason TEXT CHECK (revoke_reason IN
                  ('logout', 'logout_all', 'token_reuse', 'password_reset', 'admin'))
);

-- Partial index: only ACTIVE sessions are indexed, because those are the ones we look up.
CREATE INDEX sessions_active_user_id_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Refresh tokens form a chain per session: each refresh marks the old one used
-- and points it at its replacement. Presenting a USED token = theft signal.
CREATE TABLE refresh_tokens (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,                        -- SHA-256 of the token; raw token never stored
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,                                        -- NULL = not yet rotated
  replaced_by BIGINT      REFERENCES refresh_tokens(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_session_id_idx ON refresh_tokens (session_id);

-- Single-use, short-lived tokens for "forgot password" links.
CREATE TABLE password_reset_tokens (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);
