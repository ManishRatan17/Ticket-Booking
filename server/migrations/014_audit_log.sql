-- 014: the ADMIN AUDIT LOG. Every change an admin makes: who, what, to what, when, with which details.
-- Until now, role changes were only printed in the console (a known limitation).
CREATE TABLE admin_audit_log (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id    BIGINT,                 -- no foreign key on purpose: the entry outlives the account
  admin_email TEXT        NOT NULL,   -- readable even if that admin is deleted later ("command line" for scripts)
  action      TEXT        NOT NULL,   -- e.g. role.change, event.update, refund.retry
  target_type TEXT,                   -- user | event | support_request | refund | restriction | job
  target_id   TEXT,
  details     JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_created_idx ON admin_audit_log (created_at DESC);
CREATE INDEX admin_audit_log_action_idx ON admin_audit_log (action, created_at DESC);

-- APPEND-ONLY: the database itself refuses to change or delete an entry. Even code (or a person) with
-- the app's database access can't quietly rewrite history.
CREATE FUNCTION admin_audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only: entries cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_audit_log_no_update_or_delete
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_is_append_only();
