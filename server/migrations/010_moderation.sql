-- 010: MODERATION. Accounts caught behaving like bots are restricted: a first strike suspends ticket
-- booking for some days, a second strike within a year bans the account. See docs/18-bot-strikes.md.

CREATE TABLE account_restrictions (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL CHECK (kind IN ('suspended', 'banned')),
  reason      TEXT        NOT NULL,
  evidence    JSONB       NOT NULL DEFAULT '{}',     -- what was detected (signal counts, score, window)
  starts_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at     TIMESTAMPTZ,                           -- NULL = permanent (a ban)
  created_by  BIGINT      REFERENCES users(id) ON DELETE SET NULL,   -- NULL = automatic
  lifted_at   TIMESTAMPTZ,                           -- ended early by an admin
  lifted_by   BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  lift_reason TEXT,
  -- Lifted because it was a MISTAKE (e.g. an upheld appeal): then it doesn't count as a strike.
  overturned  BOOLEAN     NOT NULL DEFAULT false,
  CHECK ((kind = 'banned') = (ends_at IS NULL))
);
CREATE INDEX account_restrictions_user_idx ON account_restrictions (user_id, starts_at DESC);

-- Appeals go through the support inbox (migration 009) as a new kind of request.
ALTER TABLE support_requests DROP CONSTRAINT support_requests_kind_check;
ALTER TABLE support_requests ADD CONSTRAINT support_requests_kind_check CHECK (kind IN ('more_tickets', 'question', 'appeal'));
