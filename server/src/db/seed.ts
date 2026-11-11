import type { AccountInput, PostingInput } from '@ledger/shared';
import type { DB } from './connection';
import { createAccount, getAccount } from '../services/accounts';
import { createTxn, listTxns } from '../services/ledger';
import { completeReconciliation, reconcileSummary, setTxnStatus } from '../services/reconcile';
import { createSnapshot } from '../services/snapshots';
import { setAccountBudget, setBudget, setGroupBudget } from '../services/budgets';
import { listPeople } from '../services/people';
import { listCategories } from '../services/categories';

/**
 * Fabricated demo data, generated from code. Also used by tests.
 * Amounts are ledger sign: liabilities (cards, loans) are negative.
 * Everything here is made up. Never put real names or numbers in this file.
 */
export function seedDemoData(db: DB): string {
  const [me, partner] = listPeople(db);
  const both = [me.id, partner.id];
  const opened = '2026-01-01';

  const accounts: Omit<AccountInput, 'createdByPersonId' | 'openingDate'>[] = [
    { name: 'Joint Checking', type: 'checking', subtype: null, ownerIds: both, openingBalanceCents: 425_000 },
    { name: 'My Checking', type: 'checking', subtype: null, ownerIds: [me.id], openingBalanceCents: 118_250 },
    { name: 'Emergency Fund', type: 'savings', subtype: null, ownerIds: both, openingBalanceCents: 1_200_000 },
    { name: 'Car Fund', type: 'savings', subtype: null, ownerIds: [me.id], openingBalanceCents: 340_000 },
    { name: 'Travel Card', type: 'credit_card', subtype: null, ownerIds: [me.id], openingBalanceCents: -84_317 },
    { name: 'Everyday Card', type: 'credit_card', subtype: null, ownerIds: [partner.id], openingBalanceCents: -21_005 },
    { name: 'Hatchback Loan', type: 'loan', subtype: 'auto', ownerIds: [me.id], openingBalanceCents: -1_450_000 },
    { name: 'Grad School Loan', type: 'loan', subtype: 'student', ownerIds: [partner.id], openingBalanceCents: -2_275_000 },
    { name: 'Taxable Brokerage', type: 'brokerage', subtype: null, ownerIds: both, openingBalanceCents: 1_830_000 },
    { name: 'Work Roth 401(k)', type: 'retirement', subtype: 'roth_401k', ownerIds: [me.id], openingBalanceCents: 4_125_000 },
    { name: 'Roth IRA', type: 'retirement', subtype: 'roth_ira', ownerIds: [partner.id], openingBalanceCents: 960_000 },
    { name: 'Health Savings', type: 'retirement', subtype: 'hsa', ownerIds: [partner.id], openingBalanceCents: 0 },
  ];

  const id: Record<string, number> = {};
  for (const a of accounts) {
    id[a.name] = createAccount(db, { ...a, openingDate: opened, createdByPersonId: me.id }).id;
  }
  const c: Record<string, number> = Object.fromEntries(listCategories(db).map((x) => [x.name, x.id]));

  const A = (name: string, cents: number): PostingInput => ({ accountId: id[name], categoryId: null, amountCents: cents });
  const C = (name: string, cents: number): PostingInput => ({ accountId: null, categoryId: c[name], amountCents: cents });
  let count = 0;
  const add = (date: string, payee: string, postings: PostingInput[], by = me.id) => {
    createTxn(db, { date, payee, postings, createdByPersonId: by });
    count++;
  };

  // Three months of fabricated activity.
  for (const month of ['01', '02', '03']) {
    const d = (day: number) => `2026-${month}-${String(day).padStart(2, '0')}`;

    // Paycheck: gross, taxes, Roth 401(k) contribution, net to joint checking.
    for (const day of [1, 15]) {
      add(d(day), 'Acme Widgets Payroll', [
        C('Salary', -320_000),
        C('Federal Income Tax', 41_000),
        C('State Income Tax', 12_800),
        C('Social Security & Medicare', 24_480),
        A('Work Roth 401(k)', 19_200),
        A('Joint Checking', 222_520),
      ]);
    }
    // Partner's paycheck, simpler.
    add(d(5), 'Northwind Clinic', [
      C('Salary', -410_000),
      C('Federal Income Tax', 52_000),
      C('Social Security & Medicare', 31_365),
      A('Health Savings', 15_000),
      A('Joint Checking', 311_635),
    ], partner.id);

    add(d(2), 'Maple Street Rentals', [A('Joint Checking', -185_000), C('Housing', 185_000)]);
    add(d(3), 'City Power & Water', [A('Joint Checking', -14_237), C('Utilities', 14_237)], partner.id);
    add(d(6), 'Green Basket Grocery', [A('Travel Card', -12_784), C('Groceries', 12_784)]);
    add(d(9), 'Corner Bistro', [A('Everyday Card', -6_450), C('Dining', 6_450)], partner.id);
    add(d(13), 'Green Basket Grocery', [A('Everyday Card', -9_912), C('Groceries', 9_912)], partner.id);
    add(d(18), 'Big Box Store', [
      A('Travel Card', -15_600),
      C('Groceries', 6_100),
      C('Clothing', 7_200),
      C('Entertainment', 2_300),
    ]);
    add(d(20), 'Fuel Stop', [A('Travel Card', -4_811), C('Transportation', 4_811)]);

    // Card payments and savings: transfers.
    add(d(22), 'Travel Card payment', [A('Joint Checking', -40_000), A('Travel Card', 40_000)]);
    add(d(23), 'Everyday Card payment', [A('Joint Checking', -16_362), A('Everyday Card', 16_362)], partner.id);
    add(d(24), 'To Emergency Fund', [A('Joint Checking', -50_000), A('Emergency Fund', 50_000)]);
    add(d(24), 'To Car Fund', [A('My Checking', -20_000), A('Car Fund', 20_000)]);

    // Loan payments: principal vs. interest.
    add(d(25), 'Hatchback Loan payment', [
      A('My Checking', -38_500),
      A('Hatchback Loan', 32_458),
      C('Interest Expense', 6_042),
    ]);
    add(d(25), 'Grad School Loan payment', [
      A('Joint Checking', -29_000),
      A('Grad School Loan', 18_571),
      C('Interest Expense', 10_429),
    ], partner.id);

    // Investment contribution and savings interest.
    add(d(26), 'Brokerage deposit', [A('Joint Checking', -30_000), A('Taxable Brokerage', 30_000)]);
    add(d(28), 'Interest', [A('Emergency Fund', 3_812), C('Interest Income', -3_812)]);
    add(d(27), 'Transfer for spending money', [A('Joint Checking', -30_000), A('My Checking', 30_000)]);
  }

  // A refund and two items left to categorize.
  add('2026-02-20', 'Big Box Store (return)', [A('Travel Card', 3_600), C('Clothing', -3_600)]);
  add('2026-03-29', 'SQ *POPUP MKT', [A('Travel Card', -2_475), C('Uncategorized', 2_475)]);
  add('2026-03-30', 'Venmo', [A('My Checking', 4_000), C('Uncategorized', -4_000)]);

  // Month-end investment values: the ledger balance plus made-up growth/loss,
  // so each snapshot books a Valuation change.
  const growth: Record<string, number[]> = {
    'Taxable Brokerage': [41_250, -18_730, 27_115],
    'Work Roth 401(k)': [88_420, -35_610, 52_005],
    'Roth IRA': [19_870, -8_240, 12_330],
    'Health Savings': [310, -120, 455],
  };
  let snapshots = 0;
  for (const [name, deltas] of Object.entries(growth)) {
    ['2026-01-31', '2026-02-28', '2026-03-31'].forEach((date, i) => {
      const ledger = getAccount(db, id[name], date).balanceCents;
      createSnapshot(db, id[name], { date, balanceCents: ledger + deltas[i], createdByPersonId: me.id });
      snapshots++;
    });
  }

  // Cleared through February on the joint checking account and travel card;
  // the travel card's January statement is reconciled.
  for (const name of ['Joint Checking', 'Travel Card']) {
    for (const t of listTxns(db, { accountId: id[name], to: '2026-02-28', limit: 1000 }).txns) {
      if (t.kind === 'standard') setTxnStatus(db, t.id, { status: 'cleared', accountId: id[name] });
    }
  }
  const jan = reconcileSummary(db, id['Travel Card'], '2026-01-31');
  completeReconciliation(db, id['Travel Card'], {
    statementDate: '2026-01-31',
    statementBalanceCents: jan.reconciledCents + jan.clearedCents,
    personId: me.id,
  });

  // Monthly budgets for the three demo months: Dining lands over every month,
  // Clothing over in Jan/Mar but under in Feb (the refund), Housing exactly on
  // budget. Health/Fees/Other are left without a budget. The two loans are
  // budgeted as whole payments (principal + interest) and the Car Fund as a
  // savings goal; the Emergency Fund has no goal. All investing has a $900
  // goal: 2 × 192 Roth 401(k) + 150 HSA + 300 brokerage = 834, so it falls short.
  const plan: Record<string, number> = {
    Groceries: 30_000,
    Dining: 6_000,
    Housing: 185_000,
    Utilities: 15_000,
    Transportation: 6_000,
    Clothing: 5_000,
    Entertainment: 5_000,
  };
  const accountPlan: Record<string, number> = {
    'Hatchback Loan': 38_500,
    'Grad School Loan': 29_000,
    'Car Fund': 20_000,
  };
  let budgets = 0;
  for (const month of ['2026-01', '2026-02', '2026-03']) {
    for (const [name, cents] of Object.entries(plan)) {
      setBudget(db, month, c[name], cents);
      budgets++;
    }
    for (const [name, cents] of Object.entries(accountPlan)) {
      setAccountBudget(db, month, id[name], cents);
      budgets++;
    }
    setGroupBudget(db, month, 'investing', 90_000);
    budgets++;
  }

  return `${accounts.length} accounts, ${count} transactions, ${snapshots} balance snapshots, ${budgets} budget amounts`;
}
