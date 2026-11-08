-- Full v1 schema. Money is INTEGER cents. Dates are 'YYYY-MM-DD' text.
-- Timestamps (created_at etc.) are ISO-8601 text.
-- Sign convention for posting.amount_cents: debit = positive, credit = negative.

CREATE TABLE household (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  created_at  TEXT NOT NULL
);

CREATE TABLE person (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  display_name  TEXT NOT NULL,
  archived_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE account (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN
                  ('checking','savings','credit_card','loan','brokerage','retirement')),
  subtype       TEXT CHECK (
                  (type = 'loan'       AND subtype IN ('auto','student','mortgage','personal','other')) OR
                  (type = 'retirement' AND subtype IN ('401k','roth_ira','traditional_ira','hsa','other')) OR
                  (type NOT IN ('loan','retirement') AND subtype IS NULL)),
  opening_date  TEXT NOT NULL,
  archived_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One row = individually owned; two or more rows = joint.
CREATE TABLE account_owner (
  account_id  INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES person(id),
  PRIMARY KEY (account_id, person_id)
);

-- Posting targets for income/expense/tax, plus system categories
-- (opening_equity, valuation, uncategorized) that the app manages itself.
CREATE TABLE category (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('income','expense','tax','opening_equity','valuation','uncategorized')),
  is_system     INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT,
  UNIQUE (household_id, name)
);

-- 'txn' because TRANSACTION is an SQL keyword.
-- kind: standard = anything the user enters (purchases, transfers, splits);
--       opening / valuation = system-managed, excluded from income & spending.
CREATE TABLE txn (
  id                    INTEGER PRIMARY KEY,
  household_id          INTEGER NOT NULL REFERENCES household(id),
  date                  TEXT NOT NULL,
  payee                 TEXT,
  memo                  TEXT,
  kind                  TEXT NOT NULL CHECK (kind IN ('standard','opening','valuation')),
  created_by_person_id  INTEGER NOT NULL REFERENCES person(id),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE reconciliation (
  id                       INTEGER PRIMARY KEY,
  account_id               INTEGER NOT NULL REFERENCES account(id),
  statement_date           TEXT NOT NULL,
  statement_balance_cents  INTEGER NOT NULL,
  completed_by_person_id   INTEGER REFERENCES person(id),
  completed_at             TEXT NOT NULL
);

-- Each posting hits exactly one target: an account OR a category.
-- Postings of one txn must sum to zero (enforced in the service layer).
CREATE TABLE posting (
  id                 INTEGER PRIMARY KEY,
  txn_id             INTEGER NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
  account_id         INTEGER REFERENCES account(id),
  category_id        INTEGER REFERENCES category(id),
  amount_cents       INTEGER NOT NULL CHECK (amount_cents <> 0),
  memo               TEXT,
  status             TEXT CHECK (status IN ('uncleared','cleared','reconciled')),
  reconciliation_id  INTEGER REFERENCES reconciliation(id),
  CHECK ((account_id IS NULL) <> (category_id IS NULL)),
  CHECK ((account_id IS NULL) = (status IS NULL))
);

-- Dated end-of-day balances for brokerage/retirement accounts.
-- valuation_txn_id points at the system txn that books the unexplained difference.
CREATE TABLE balance_snapshot (
  id                    INTEGER PRIMARY KEY,
  account_id            INTEGER NOT NULL REFERENCES account(id),
  date                  TEXT NOT NULL,
  balance_cents         INTEGER NOT NULL,
  note                  TEXT,
  valuation_txn_id      INTEGER REFERENCES txn(id) ON DELETE SET NULL,
  created_by_person_id  INTEGER NOT NULL REFERENCES person(id),
  created_at            TEXT NOT NULL,
  UNIQUE (account_id, date)
);

CREATE INDEX idx_posting_account  ON posting(account_id);
CREATE INDEX idx_posting_category ON posting(category_id);
CREATE INDEX idx_posting_txn      ON posting(txn_id);
CREATE INDEX idx_txn_date         ON txn(date);
CREATE INDEX idx_snapshot_account ON balance_snapshot(account_id, date);
