# Developing the Ledger

A hands-on guide for working on this app yourself, including fully offline.
Commands are run from the repo root unless noted.

---

## 1. Offline checklist (do this BEFORE you lose internet)

Everything the app needs at runtime and for development lives in `node_modules/`.
Nothing calls the network once dependencies are installed.

```bash
npm install          # all workspaces; must have finished at least once online
npm test             # proves the toolchain works
npm run dev          # open http://127.0.0.1:5173 and click around once
```

Offline you **can**: run, test, typecheck, build, seed, back up, restore, edit
code, commit to git locally.
Offline you **cannot**: `npm install` a *new* package, `git push`, or use Claude.

If you think you'll want a library you don't have yet, install it before you fly.

---

## 1b. Using it: the weekly routine

Start the app with `npm run dev` and open http://127.0.0.1:5173 (it opens on **Today**).

**First time only**
1. **Accounts → Add account** for each real account: name, type (Savings for a
   high-yield savings account, Retirement → Roth 401(k) etc.), owners (both of
   you = joint), opening date = the day you start tracking, opening balance =
   the balance at the end of the day before. Cards and loans: enter the amount owed.
2. **Categories**: rename/add/archive until the list matches how you think about money.
3. **Budget**: type this month's amount next to each category you want to watch,
   each loan (the full monthly payment), each savings account (a goal) and
   **All investing** (one goal for everything into brokerage/retirement accounts).

**Every week (about 15 minutes)**
1. **Today → enter the week's transactions** from receipts or your bank/card sites.
   Set the date once; it stays for the next entries. Known payees fill in their
   category. Use *Transfer* for card payments and moves to savings, *Split* for
   paychecks and loan payments. Or **Duplicate** last paycheck on Transactions.
2. **To review → click each account's name**, compare with the bank's website,
   and click **C** on every item the bank shows (cleared).
3. **Uncategorized card → Categorize** anything left there.
4. **Investment values card → Update value** for any account flagged (older than 7 days).
5. **Budget** tab: check the month. Red = over, green = under.
6. `npm run backup`.

**Every month (when statements arrive)**
1. **Reconcile** each bank, card and loan account: statement date + ending balance,
   tick items until the difference is $0.00, **Finish**.
2. Checking/savings: **Update balance** books any interest the bank paid.
3. **Budget → next month → Copy last month's budget**, then adjust.
4. **Overview → Last month**: income, taxes, spending, savings, net worth.
5. Optional: `npm run export` for a spreadsheet copy.

---

## 2. Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | API (127.0.0.1:4317) + web (127.0.0.1:5173) with hot reload. Open the web URL. |
| `npm test` | All tests in `shared`, `server`, `web`. |
| `npm test -w server` | Only server tests. Also `-w web` / `-w shared`. |
| `cd server && npx vitest` | **Watch mode**: re-runs tests as you save. Best while building. |
| `cd server && npx vitest accounts` | Only test files whose name matches "accounts". |
| `npm run typecheck` | TypeScript check of everything, no output = good. |
| `npm run seed` | Fill an empty DB with fabricated demo accounts. |
| `npm run seed -- --force` | Back up, wipe, re-seed. |
| `npm run backup` | Copy DB to `backups/finance-YYYYMMDD-HHMMSS.sqlite`. |
| `npm run export` | `exports/<timestamp>/`: a CSV per table, `transactions.csv` (readable, dollars), and a DB copy. Opens in any spreadsheet. |
| `npm run restore` | List backups. `npm run restore -- backups/<file>` restores (stop the server first). |
| `npm run sql -- tables` | List DB tables. |
| `npm run sql -- "SELECT * FROM account"` | Run any read-only query and print a table. |
| `npm run build` | Production build of the web app into `web/dist/`. |

The database lives at `data/finance.sqlite`. To experiment without touching it:

```bash
LEDGER_DB=/tmp/scratch.sqlite npm run dev     # throwaway DB
LEDGER_DB=/tmp/scratch.sqlite npm run seed
```

---

## 3. How the money model works (read once)

* **Cents only.** Every amount is an integer number of cents. `$12.34` is `1234`.
  Use `parseMoney` / `formatCents` from `shared/src/money.ts`; never `parseFloat`.
* **Postings.** A transaction (`txn` table) has 2+ postings. Each posting hits
  exactly one *account* or one *category*. Postings in a txn always sum to zero.
* **Sign.** Debit = positive, credit = negative.
  * Money arriving in checking: checking `+`.
  * Spending on groceries: Groceries `+` (expense categories go up with debits).
  * Salary: Salary `−` (income categories are credits).
  * Credit card/loan balances are negative inside the DB. The UI flips them
    with `ledgerToNatural` so "owed" shows as a positive number.
* **Examples** (amounts in dollars for readability):

  | What happened | Postings |
  |---|---|
  | $50 groceries on a card | card −50, Groceries +50 |
  | Pay $500 card bill from checking | checking −500, card +500 |
  | $20 refund to card | card +20, Clothing −20 |
  | Loan payment $300 (250 principal, 50 interest) | checking −300, loan +250, Interest Expense +50 |
  | Paycheck: $5,000 gross, $1,000 taxes, $500 401k, $3,500 deposited | Salary −5000, Federal Income Tax +1000, 401k +500, checking +3500 |
  | Savings interest $4.12 | savings +4.12, Interest Income −4.12 |
  | 401(k) snapshot says $41,100 but ledger says $41,000 | *system* txn: 401k +100, Valuation Change −100 |

  In the entry form you never type signs: *Spend/Receive* uses Money out/in;
  *Split* lines use **Into / Out of** for accounts and **Spent / Received**
  for categories. `shared/src/entry.ts` converts.
* **Status** of an account posting: *uncleared* (entered) → *cleared* (seen on
  the bank's site; click **C** in the register) → *reconciled* (matched to a
  finished statement; locked). Reconciling = tick items until cleared total =
  statement balance, then Finish. Undo the latest from the reconcile bar.
* **Valuations** are never typed. Each snapshot's valuation is recomputed from
  scratch (oldest first) whenever that investment account changes, so the
  balance at the end of every snapshot date always equals the snapshot.
* **Reports** decide what's income/spending by *where postings land*, not by a
  transaction "type". See PLAN.md for exact definitions.

---

## 4. File map: what every file does

### Root

| File | Purpose | Edit when |
|---|---|---|
| `package.json` | Declares the 3 workspaces and the root scripts in section 2. | Adding a new root command. |
| `tsconfig.base.json` | TypeScript settings shared by all packages (strict mode). | Rarely. |
| `.gitignore` | Keeps databases, backups, exports, PLAN.md, CLAUDE.md, `node_modules` out of git. | Never loosen the DB rules. |
| `DEVELOPING.md` | This file. | Whenever you learn something worth writing down. |
| `PLAN.md` | *(not committed)* Schema, report definitions, decisions, progress log. | End of every work session: add a log entry. |
| `CLAUDE.md` | *(not committed)* Short instructions Claude reads at the start of each session. | If conventions change. |

### `shared/`: code used by both server and web

| File | Purpose |
|---|---|
| `src/types.ts` | Account types/subtypes, labels, the `Account`/`Person`/`Category` shapes the API returns, `Scope`. **Start here when adding a field**: both sides get it. |
| `src/money.ts` | `parseMoney`, `formatCents`, `ledgerToNatural`, `naturalToLedger`. |
| `src/money.test.ts` | Tests for the above. |
| `src/entry.ts` | Entry-form ↔ postings conversion: `entryToPostings`, `txnToEntry`, `lineCents`, `splitImbalance`, `carryStatuses`. **The only place form directions become debit/credit signs.** |
| `src/report.ts` | `OverviewReport` shape, period presets (`presetRange`), `dayBefore`. |
| `src/budget.ts` | Budget helpers: `isValidMonth`, `addMonths`, `monthBounds`, `budgetStatus` (over only when spent > budget), `savingsStatus` (goal met/short), `lineStatus`, `budgetTotals`, and the `BudgetLine`/`BudgetMonth` shapes. |
| `src/balanceUpdate.ts` | Checking/savings statement helper: `compareStatement` (match / interest / shortfall) and `interestPostings`. |
| `src/entry.test.ts` | Tests for the above. |
| `src/index.ts` | Re-exports; import from `'@ledger/shared'`. |

`shared` has no build step: server and web import its `.ts` files directly.

### `server/`: API + database

| File | Purpose |
|---|---|
| `src/index.ts` | Starts the server on 127.0.0.1 and closes the DB cleanly on Ctrl+C. |
| `src/config.ts` | Paths (DB, backups, exports) and port. `HOST` is hard-coded to loopback on purpose. A relative `LEDGER_DB` is resolved from where you typed the command. |
| `src/app.ts` | Builds the Fastify app: error handler + registers route files. Tests use this directly. |
| `src/errors.ts` | `ValidationError` (→ HTTP 400) and `NotFoundError` (→ 404). Throw these from services. |
| `src/dates.ts` | `localToday()` and `isValidDate()` for `YYYY-MM-DD` strings. |
| `src/db/connection.ts` | `openDb(path, { backupsDir })`: opens SQLite, turns on WAL + foreign keys, backs up if migrations are pending, migrates, bootstraps. |
| `src/db/migrate.ts` | Runs `migrations/NNN_*.sql` files newer than `PRAGMA user_version`, with foreign keys off and a `foreign_key_check` before commit. |
| `src/db/migrations/001_initial.sql` | **The whole schema**, with comments. Read this to understand the data. |
| `src/db/migrations/003_budgets.sql` | The `budget` table: one amount per expense category per month. |
| `src/db/migrations/004_budget_accounts.sql` | Rebuilds `budget` so a row targets a category **or** a loan/savings account. |
| `src/db/migrations/005_budget_groups.sql` | Adds `group_key` (`investing`) so a row can target a group of accounts. |
| `src/db/migrations/002_roth_401k.sql` | Adds `roth_401k`; example of rebuilding a table to change a CHECK. Copy this pattern for similar changes. |
| `src/db/bootstrap.ts` | First-run rows: the household, "Me"/"Partner", system + default categories. Helpers `householdId()`, `systemCategoryId()`. |
| `src/db/seed.ts` | Fabricated demo data (used by `npm run seed` and tests). |
| `src/services/accounts.ts` | Account list/get/create/update/archive, balances, opening-balance txns. |
| `src/services/people.ts` | List/rename people; `assertActivePeople` validation helper. |
| `src/services/categories.ts` | List, create, rename/change kind, archive categories (system ones locked). |
| `src/services/ledger.ts` | **The ledger.** `createTxn`, `updateTxn`, `deleteTxn`, `getTxn`, `listTxns` (register filters + running balance). All posting validation rules are in `validate()` here. |
| `src/services/reconcile.ts` | Cleared toggle (`setTxnStatus`), statement reconciliation (`reconcileSummary`, `completeReconciliation`, `undoLastReconciliation`). |
| `src/services/snapshots.ts` | Investment value snapshots and **`recomputeValuations`**, which rebuilds the system "Valuation change" txns. Called by ledger/accounts writes that touch an investment account. |
| `src/services/reports.ts` | **Report engine** (PLAN §3): `categoryTotals` (category postings in eligible txns), `spendingByCategory` (budgets), `overviewReport` (everything on Overview, incl. the net-worth identity check), `scopeInfo`. |
| `src/services/budgets.ts` | Monthly budgets: `getBudgetMonth` (category, loan, savings and "All investing" lines; loan = whole payment, its interest moved off the category line), `setBudget`, `setAccountBudget`, `setGroupBudget`, `copyPreviousMonth`. |
| `src/services/today.ts` | `todaySummary` (Today cards; `STALE_AFTER_DAYS = 7`) and `listPayees` (payee → last category). |
| `src/services/scope.ts` | Parses `?scope=household` / `person:1` and turns it into "which accounts". |
| `src/routes/*.ts` | One file per resource; each just maps a URL to a service function. |
| `src/ops/backup.ts` | Backup / restore logic (tested). |
| `src/ops/export.ts` | CSV export (`exportDb`, `toCsv`, `centsToDecimal`). |
| `scripts/*.ts` | Command-line wrappers: `seed`, `backup`, `restore`, `export`, `sql`. |
| `test/helpers.ts` | `testDb()` (fresh in-memory DB), `accountInput()`, `unbalancedTxnIds()`, `acct()`/`cat()` posting shorthands, `balance()`, `categoryTotal()`, `categoryId()`. |
| `test/ledger.test.ts` | Ledger rules: AT-1–4, 9, 10, 12, 13, 18, 20 and register filters. |
| `test/reconcile.test.ts` | Cleared toggle, AT-13 (lock via real reconcile), AT-14, AT-21 (ledger part), API. |
| `test/snapshots.test.ts` | AT-6 valuation rules, snapshot validation, seed invariant, API. |
| `test/reports.test.ts` | Report rules: AT-1–8, 11, 17, 20, 21 (report side), Uncategorized by sign, period edges, archived accounts, API. |
| `test/today.test.ts` | AT-16 stale values, review counts, uncategorized + budget glance per scope, payee hints, API. |
| `test/budgets.test.ts` | AT-22: spending per category (what counts and what doesn't), scope, budget set/clear/validation, copy last month, seed, API. |
| `test/migrations.test.ts` | Migration 002 on a v1 DB; pre-migrate backup. |
| `test/*.test.ts` | Tests. `api.test.ts` uses `app.inject()` to call routes without a real port. |

**Layering rule:** routes are thin, *services hold all logic and validation*,
SQL lives in services. Any multi-step write is wrapped in `db.transaction(() => …)()`
so it either fully happens or doesn't.

### `web/`: React UI

| File | Purpose |
|---|---|
| `index.html` | Page shell. |
| `vite.config.ts` | Dev server on 127.0.0.1:5173, proxies `/api` to the server; test env = jsdom. |
| `src/main.tsx` | Mounts `<App>` inside `<ScopeProvider>`. |
| `src/index.css` | Tailwind import + the `.money` class (right-aligned tabular digits). |
| `src/App.tsx` | Header, tab nav, picks the page from the route. **Add new pages here.** |
| `src/api.ts` | Every API call the UI makes. **Add new endpoints here.** |
| `src/scope.tsx` | "Viewing as" + "Entering as" state, people list. `useScope()` in any component. |
| `src/lookups.ts` | `useLookups()`: all accounts + categories with `accountName()`/`categoryName()` for pickers and tables. |
| `src/router.ts` | `useRoute()` parses `#/page?key=value`; `href()` builds links. |
| `src/components/ScopeSwitcher.tsx` | The header dropdowns. |
| `src/components/AccountForm.tsx` | Create/edit account form; converts natural ↔ ledger sign. |
| `src/components/AccountForm.test.tsx` | Component tests with Testing Library. |
| `src/components/TxnForm.tsx` | Transaction entry: Spend/Receive, Transfer, Split modes; edit and duplicate. Stays open after adding (`clearForNext` decides what resets; the date is kept). |
| `src/components/TxnForm.test.tsx` | Tests each mode, split balancing, edit, duplicate, sticky date. |
| `src/pages/AccountsPage.tsx` | Accounts screen; row links: Register, Reconcile, Update balance / Update value, Edit, Archive. |
| `src/components/ReconcileBar.tsx` | Statement date/balance, difference, Finish, Undo; shown by the register in reconcile mode (`#/transactions?accountId=N&reconcile=1`). |
| `src/components/SnapshotPanel.tsx` | "Update value" for investment accounts: add/edit/delete snapshots, shows growth/loss per snapshot. |
| `src/components/BalanceUpdatePanel.tsx` | "Update balance" for checking/savings: compare statement vs. app, book interest. |
| `src/components/*.test.tsx` | Component tests; `ReconcileBar` and `BalanceUpdatePanel` mock `../api` with `vi.mock`. |
| `src/pages/TransactionsPage.tsx` | Register: rows red while pending, green once cleared/reconciled (`statusTint`); filters (URL params `accountId`, `categoryId`, `from`, `to`, `uncategorized`, `reconcile`), table rows (`TxnRow`), edit/duplicate/delete. |
| `src/pages/TodayPage.tsx` | **Default page.** Quick entry + cards: month budget, review status, stale investment values, uncategorized. Test: `TodayPage.test.tsx`. |
| `src/entryDate.ts` | `useEntryDate()`: the sticky entry date shared by Today and Transactions. |
| `src/payees.ts` | `usePayees()`: payee hints for the entry form. |
| `src/pages/OverviewPage.tsx` | Overview: period presets, totals, income/tax/spending breakdowns, net worth by group with valuation dates, change-in-net-worth check. Test: `OverviewPage.test.tsx`. |
| `src/pages/BudgetPage.tsx` | Budget tab: month picker, inline budget inputs, spent vs. budget (red over / green under), copy last month. Test: `BudgetPage.test.tsx`. |
| `src/pages/CategoriesPage.tsx` | Add/rename/archive categories. |
| `src/pages/PeoplePage.tsx` | Rename people. |

Styling is Tailwind utility classes directly in JSX (`className="rounded px-3"`).
No component library; copy patterns from existing pages.

---

## 5. Testing workflow

1. Open a terminal in the package you're working on and run watch mode:
   `cd server && npx vitest`.
2. Write or change a test in `server/test/…`. Start each test with `testDb()`:
   a brand-new in-memory database, so tests never touch your real data and
   can run in any order.
3. Save. Vitest re-runs instantly. Press `f` to rerun only failures, `q` to quit.
4. Before committing: `npm test && npm run typecheck` from the root.

Test naming convention: acceptance tests from PLAN.md are tagged in a comment,
e.g. `// AT-11 …`, so you can `grep -rn "AT-" server/test` to see coverage.

Example of a new service test:

```ts
import { it, expect } from 'vitest';
import { createAccount, listAccounts } from '../src/services/accounts';
import { accountInput, testDb } from './helpers';

it('my new rule', () => {
  const { db, me } = testDb();
  createAccount(db, accountInput(me, { type: 'savings', openingBalanceCents: 1000 }));
  expect(listAccounts(db)[0].balanceCents).toBe(1000);
});
```

---

## 6. Visualizing / inspecting

* **The app**: `npm run dev`, open http://127.0.0.1:5173. Use `npm run seed` first
  so there's something to look at. Switch "Viewing as" to check scoping.
* **Raw data**: `npm run sql -- "SELECT * FROM txn"`. Useful queries:
  ```sql
  -- every posting with its target name
  SELECT t.date, t.kind, t.payee, COALESCE(a.name, c.name) AS target, p.amount_cents
  FROM posting p JOIN txn t ON t.id = p.txn_id
  LEFT JOIN account a ON a.id = p.account_id
  LEFT JOIN category c ON c.id = p.category_id
  ORDER BY t.date, t.id;

  -- any unbalanced transactions (should always be empty)
  SELECT txn_id, SUM(amount_cents) FROM posting GROUP BY txn_id HAVING SUM(amount_cents) <> 0;

  -- account balances
  SELECT a.name, SUM(p.amount_cents) AS cents FROM account a
  LEFT JOIN posting p ON p.account_id = a.id GROUP BY a.id;
  ```
* **The API directly** while `npm run dev` runs:
  `curl -s http://127.0.0.1:4317/api/accounts`, or open that URL in the browser
  (Firefox/Chrome pretty-print JSON). Add `?scope=person:1` to see one person's view.
* **React state**: browser DevTools (works offline). `console.log` in components
  shows in the browser console; in services it shows in the `npm run dev` terminal.

---

## 7. Recipe: building a feature yourself

Work from the bottom up; each step is testable before the next.

1. **Schema** (only if you need new columns/tables): add
   `server/src/db/migrations/002_short_name.sql`. Never edit `001`. It runs
   automatically next time the server or a test opens a DB.
   *Back up first* (`npm run backup`) before running a new migration on real data.
2. **Shared type**: add/extend the interface in `shared/src/types.ts`.
3. **Service + test**: write the function in `server/src/services/<thing>.ts`.
   Validate input, throw `ValidationError` with a human message, wrap
   multi-step writes in `db.transaction`. Write tests in `server/test/` first
   or alongside; get them green in watch mode.
4. **Route**: add a file in `server/src/routes/` (copy `categories.ts` as a
   template) and register it in `server/src/app.ts`. Add an `app.inject` test.
5. **API client**: add a function in `web/src/api.ts`.
6. **UI**: add a page in `web/src/pages/` and wire it in `App.tsx` (`PAGES`
   list + the `<main>` switch), or extend an existing page.
7. `npm test && npm run typecheck`, try it in the browser, commit.

**Worked example (already built, read it as a model): categories.**
`services/categories.ts` (`createCategory`, `updateCategory`, validation) →
`test/api.test.ts` "categories API" → `routes/categories.ts` → `web/src/api.ts`
(`createCategory`…) → `web/src/pages/CategoriesPage.tsx` → `PAGES` in `App.tsx`.

**Exercise you could try:** a "payee contains" quick filter chip on the
register, or showing each person's name in an "Entered by" column. Both are
web-only: `TransactionsPage.tsx` already receives `createdByPersonId`.

---

## 8. Git workflow (works offline)

```bash
git checkout -b my-feature       # keep your work separate from main
git add -A && git status         # double-check: no .sqlite, backups/, exports/
git commit -m "Add category rename"
# back online:
git push -u origin my-feature
```

`.gitignore` blocks database files, but always glance at `git status` before
committing. If you ever see a `.sqlite` or a CSV with real numbers staged,
`git restore --staged <file>`.

**Leave notes for the next Claude session:** append a short entry to the
*Progress log* in `PLAN.md` describing what you changed by hand (files, any new
migration, anything unfinished). Claude reads PLAN.md first every session.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `Port 5173 is in use` / `EADDRINUSE 4317` | Another `npm run dev` is running. Close it, or `pkill -f vite; pkill -f tsx`. |
| Web shows "Failed to fetch" errors | The server half crashed; check the `server` lines in the dev terminal. |
| `better-sqlite3` "was compiled against a different Node.js version" | You changed Node versions. `npm rebuild better-sqlite3` (works offline). |
| A migration broke the DB | `npm run restore -- backups/<latest>.sqlite`, fix the migration, retry. |
| Want a clean slate | `npm run seed -- --force` (backs up first). |
