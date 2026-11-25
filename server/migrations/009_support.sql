-- 009: the SUPPORT INBOX. People write to the organisers ("may I buy more tickets?", questions);
-- admins answer, and approve or decline.

CREATE TABLE support_requests (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- more_tickets = "let me buy more than the per-person limit for this event"; question = anything else.
  -- (Ban appeals will be added as a kind when account restrictions exist.)
  kind          TEXT        NOT NULL CHECK (kind IN ('more_tickets', 'question')),
  event_id      BIGINT      REFERENCES events(id) ON DELETE SET NULL,
  extra_tickets INTEGER     CHECK (extra_tickets BETWEEN 1 AND 4),   -- more_tickets: how many MORE
  status        TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'declined', 'closed')),
  decided_by    BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- (The event is required when a "more tickets" request is CREATED — the API checks that. It is not a
  -- table rule: if the event is ever deleted, event_id becomes NULL and the conversation is kept.)
  CHECK (kind <> 'more_tickets' OR extra_tickets IS NOT NULL)
);
-- One OPEN request per person, kind and event: asking twice doesn't put you ahead, it just
-- waits for the first answer. (A partial unique index: closed requests don't count.)
CREATE UNIQUE INDEX support_one_open_request
  ON support_requests (user_id, kind, COALESCE(event_id, 0)) WHERE status = 'open';
CREATE INDEX support_requests_status_idx ON support_requests (status, created_at);

CREATE TABLE support_messages (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT      NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  author_id  BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  from_admin BOOLEAN     NOT NULL,
  body       TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_request_idx ON support_messages (request_id, id);

-- An APPROVED "more tickets" request raises THIS person's limit for THIS event:
-- limit = the normal 4 + extra (so at most 8).
CREATE TABLE purchase_limit_overrides (
  event_id   BIGINT      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extra      INTEGER     NOT NULL CHECK (extra BETWEEN 1 AND 4),
  request_id BIGINT      REFERENCES support_requests(id) ON DELETE SET NULL,
  granted_by BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
