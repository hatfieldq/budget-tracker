-- Monthly budgets (D31): one amount per expense category per month, household-wide.
-- Months start blank; "Copy last month" fills them. amount_cents is natural
-- terms (money you plan to spend), never negative. No row = no budget.
CREATE TABLE budget (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  month         TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  category_id   INTEGER NOT NULL REFERENCES category(id),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (household_id, month, category_id)
);
