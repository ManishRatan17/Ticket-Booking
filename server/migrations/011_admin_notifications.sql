-- 011: admin notifications. An AUTOMATIC restriction (a bot strike) is "new" for the admins until
-- one of them has seen it. Restrictions made by an admin are already known, so they start as seen.
ALTER TABLE account_restrictions
  ADD COLUMN acknowledged_at TIMESTAMPTZ,
  ADD COLUMN acknowledged_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

UPDATE account_restrictions SET acknowledged_at = starts_at WHERE created_by IS NOT NULL;
CREATE INDEX account_restrictions_unseen_idx ON account_restrictions (starts_at) WHERE acknowledged_at IS NULL;
