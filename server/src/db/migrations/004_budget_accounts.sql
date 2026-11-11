-- Budget lines for loan and savings accounts (D36), alongside expense categories.
-- A budget row now targets exactly one category OR one account. SQLite can't
-- change constraints in place, so the table is rebuilt (ids unchanged), like 002.
CREATE TABLE budget_new (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  month         TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  category_id   INTEGER REFERENCES category(id),
  account_id    INTEGER REFERENCES account(id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  CHECK ((category_id IS NULL) <> (account_id IS NULL)),
  UNIQUE (household_id, month, category_id),
  UNIQUE (household_id, month, account_id)
);

INSERT INTO budget_new (id, household_id, month, category_id, account_id, amount_cents)
  SELECT id, household_id, month, category_id, NULL, amount_cents FROM budget;

DROP TABLE budget;
ALTER TABLE budget_new RENAME TO budget;
