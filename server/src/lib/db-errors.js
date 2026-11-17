// Postgres reports constraint failures with standard error codes.
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const UNIQUE_VIOLATION = '23505';

// True if `err` is a duplicate-value error from the named UNIQUE constraint.
// Checking the constraint name means we never mistake one duplicate for another.
export function isUniqueViolation(err, constraintName) {
  return err?.code === UNIQUE_VIOLATION && err.constraint === constraintName;
}
