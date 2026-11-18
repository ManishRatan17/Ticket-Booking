-- 003: "Continue with Google" (OpenID Connect).

-- Users who sign up with Google have no password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- When we last got PROOF the user owns their email (Google says email_verified = true).
-- NULL = never proven: anyone could have typed that email at registration.
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

-- One row per external login linked to one of our users.
CREATE TABLE user_identities (
  id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL CHECK (provider IN ('google')), -- room for more later
  provider_user_id TEXT        NOT NULL,  -- Google's "sub": permanent, unlike the email
  email            TEXT,                  -- what the provider said at link time (for reference)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id),     -- one Google account → exactly one of our users
  UNIQUE (user_id, provider)               -- one of our users → at most one Google account
);

-- New reason for ending sessions: linking Google to an unverified password account
-- logs out everyone who was using that account before (it may have been a squatter).
ALTER TABLE sessions DROP CONSTRAINT sessions_revoke_reason_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_revoke_reason_check CHECK (revoke_reason IN
  ('logout', 'logout_all', 'token_reuse', 'password_reset', 'admin', 'account_linked'));
