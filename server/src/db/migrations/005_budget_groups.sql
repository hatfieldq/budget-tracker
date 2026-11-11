-- Budget lines for groups of accounts (D37): 'investing' = every brokerage and
-- retirement account together. A budget row now targets exactly one category,
-- account or group. Rebuilt like 004 (ids unchanged).
CREATE TABLE budget_new (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  month         TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  category_id   INTEGER REFERENCES category(id),
  account_id    INTEGER REFERENCES account(id),
  group_key     TEXT CHECK (group_key IN ('investing')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  CHECK ((category_id IS NOT NULL) + (account_id IS NOT NULL) + (group_key IS NOT NULL) = 1),
  UNIQUE (household_id, month, category_id),
  UNIQUE (household_id, month, account_id),
  UNIQUE (household_id, month, group_key)
);

INSERT INTO budget_new (id, household_id, month, category_id, account_id, group_key, amount_cents)
  SELECT id, household_id, month, category_id, account_id, NULL, amount_cents FROM budget;

DROP TABLE budget;
ALTER TABLE budget_new RENAME TO budget;
