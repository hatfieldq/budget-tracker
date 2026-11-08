-- Add 'roth_401k' to the allowed retirement subtypes.
-- SQLite can't change a CHECK constraint in place, so the account table is
-- rebuilt: create the new shape, copy rows (ids unchanged), drop, rename.
-- migrate.ts turns foreign keys off around this so dropping the old table
-- doesn't cascade-delete account_owner rows, then verifies foreign_key_check.

CREATE TABLE account_new (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN
                  ('checking','savings','credit_card','loan','brokerage','retirement')),
  subtype       TEXT CHECK (
                  (type = 'loan'       AND subtype IN ('auto','student','mortgage','personal','other')) OR
                  (type = 'retirement' AND subtype IN ('401k','roth_401k','roth_ira','traditional_ira','hsa','other')) OR
                  (type NOT IN ('loan','retirement') AND subtype IS NULL)),
  opening_date  TEXT NOT NULL,
  archived_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

INSERT INTO account_new (id, household_id, name, type, subtype, opening_date, archived_at, created_at, updated_at)
  SELECT id, household_id, name, type, subtype, opening_date, archived_at, created_at, updated_at FROM account;

DROP TABLE account;
ALTER TABLE account_new RENAME TO account;
