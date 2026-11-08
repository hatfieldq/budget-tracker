import { describe, expect, it } from 'vitest';
import {
  createAccount,
  getAccount,
  listAccounts,
  setArchived,
  updateAccount,
} from '../src/services/accounts';
import { renamePerson } from '../src/services/people';
import { seedDemoData } from '../src/db/seed';
import { accountInput, testDb, unbalancedTxnIds } from './helpers';

describe('bootstrap', () => {
  it('creates one household, two renamable people and the system categories', () => {
    const { db, me } = testDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM household').get()).toEqual({ n: 1 });
    expect(renamePerson(db, me, '  Quinn ').displayName).toBe('Quinn');
    const kinds = db.prepare('SELECT kind FROM category WHERE is_system = 1 ORDER BY kind').all();
    expect(kinds.map((k: any) => k.kind)).toEqual(['opening_equity', 'uncategorized', 'valuation']);
  });

  it('rejects an empty name', () => {
    const { db, me } = testDb();
    expect(() => renamePerson(db, me, '  ')).toThrow(/required/);
  });
});

describe('accounts', () => {
  it('creates savings accounts with custom nicknames', () => {
    const { db, me } = testDb();
    createAccount(db, accountInput(me, { name: 'Emergency Fund', type: 'savings' }));
    createAccount(db, accountInput(me, { name: 'Car Fund', type: 'savings' }));
    expect(listAccounts(db).map((a) => a.name)).toEqual(['Car Fund', 'Emergency Fund']);
  });

  it('requires a valid subtype for loans and retirement accounts only', () => {
    const { db, me } = testDb();
    expect(() => createAccount(db, accountInput(me, { type: 'loan', subtype: null }))).toThrow(
      /subtype/,
    );
    expect(() =>
      createAccount(db, accountInput(me, { type: 'retirement', subtype: 'auto' })),
    ).toThrow(/subtype/);
    expect(() =>
      createAccount(db, accountInput(me, { type: 'checking', subtype: '401k' })),
    ).toThrow(/no subtype/);
    const loan = createAccount(db, accountInput(me, { type: 'loan', subtype: 'mortgage' }));
    expect(loan.subtype).toBe('mortgage');
  });

  it('requires at least one active owner', () => {
    const { db, me } = testDb();
    expect(() => createAccount(db, accountInput(me, { ownerIds: [] }))).toThrow(/owner/);
    expect(() => createAccount(db, accountInput(me, { ownerIds: [999] }))).toThrow(/unknown person/);
  });

  it('marks accounts with two owners as joint', () => {
    const { db, me, partner } = testDb();
    const a = createAccount(db, accountInput(me, { ownerIds: [partner, me, me] }));
    expect(a.ownerIds).toEqual([me, partner]);
    expect(a.isJoint).toBe(true);
  });
});

// AT-11 (opening part): opening balances are a system txn against Opening Balance.
describe('opening balances', () => {
  it('books a balanced opening txn against the Opening Balance category', () => {
    const { db, me } = testDb();
    const card = createAccount(
      db,
      accountInput(me, { type: 'credit_card', name: 'Card', openingBalanceCents: -90000 }),
    );
    expect(card.balanceCents).toBe(-90000);
    expect(card.openingBalanceCents).toBe(-90000);

    const postings = db
      .prepare(
        `SELECT t.kind, p.account_id, c.kind AS category_kind, p.amount_cents
         FROM posting p JOIN txn t ON t.id = p.txn_id LEFT JOIN category c ON c.id = p.category_id
         ORDER BY p.id`,
      )
      .all();
    expect(postings).toEqual([
      { kind: 'opening', account_id: card.id, category_kind: null, amount_cents: -90000 },
      { kind: 'opening', account_id: null, category_kind: 'opening_equity', amount_cents: 90000 },
    ]);
    expect(unbalancedTxnIds(db)).toEqual([]);
  });

  it('a zero opening balance creates no txn', () => {
    const { db, me } = testDb();
    createAccount(db, accountInput(me));
    expect(db.prepare('SELECT COUNT(*) AS n FROM txn').get()).toEqual({ n: 0 });
  });

  it('editing the opening balance replaces the txn instead of adding one', () => {
    const { db, me } = testDb();
    const a = createAccount(db, accountInput(me, { openingBalanceCents: 10000 }));
    updateAccount(db, a.id, { openingBalanceCents: 25000, createdByPersonId: me });
    updateAccount(db, a.id, {
      openingDate: '2025-12-15',
      openingBalanceCents: 30000,
      createdByPersonId: me,
    });
    const updated = getAccount(db, a.id);
    expect(updated.balanceCents).toBe(30000);
    expect(updated.openingDate).toBe('2025-12-15');
    expect(db.prepare("SELECT date FROM txn WHERE kind = 'opening'").all()).toEqual([
      { date: '2025-12-15' },
    ]);

    updateAccount(db, a.id, { openingBalanceCents: 0, createdByPersonId: me });
    expect(db.prepare('SELECT COUNT(*) AS n FROM txn').get()).toEqual({ n: 0 });
  });

  it('balance as of a date before the opening date is zero', () => {
    const { db, me } = testDb();
    createAccount(db, accountInput(me, { openingDate: '2026-03-01', openingBalanceCents: 500 }));
    expect(listAccounts(db, { asOf: '2026-02-28' })[0].balanceCents).toBe(0);
    expect(listAccounts(db, { asOf: '2026-03-01' })[0].balanceCents).toBe(500);
  });

  it('rejects impossible dates and fractional cents', () => {
    const { db, me } = testDb();
    expect(() => createAccount(db, accountInput(me, { openingDate: '2026-02-30' }))).toThrow(/date/);
    expect(() => createAccount(db, accountInput(me, { openingBalanceCents: 12.5 }))).toThrow(/cents/);
  });
});

// AT-18 (account part): archive hides from default lists but keeps history.
describe('archiving', () => {
  it('hides archived accounts by default and keeps their balance', () => {
    const { db, me } = testDb();
    const a = createAccount(db, accountInput(me, { openingBalanceCents: 7700 }));
    setArchived(db, a.id, true);
    expect(listAccounts(db)).toEqual([]);
    const all = listAccounts(db, { includeArchived: true });
    expect(all).toHaveLength(1);
    expect(all[0].archivedAt).not.toBeNull();
    expect(all[0].balanceCents).toBe(7700);
    expect(setArchived(db, a.id, false).archivedAt).toBeNull();
  });
});

describe('scope', () => {
  it('person scope includes own and joint accounts; household counts each once', () => {
    const { db, me, partner } = testDb();
    createAccount(db, accountInput(me, { name: 'Joint', ownerIds: [me, partner] }));
    createAccount(db, accountInput(me, { name: 'Mine' }));
    createAccount(db, accountInput(partner, { name: 'Theirs', ownerIds: [partner] }));
    const names = (scope: Parameters<typeof listAccounts>[1]) =>
      listAccounts(db, scope).map((a) => a.name);
    expect(names({ scope: { type: 'household' } })).toEqual(['Joint', 'Mine', 'Theirs']);
    expect(names({ scope: { type: 'person', personId: me } })).toEqual(['Joint', 'Mine']);
    expect(names({ scope: { type: 'person', personId: partner } })).toEqual(['Joint', 'Theirs']);
  });
});

describe('seed data', () => {
  it('creates balanced fabricated accounts', () => {
    const { db } = testDb();
    seedDemoData(db);
    expect(listAccounts(db).length).toBeGreaterThan(10);
    expect(unbalancedTxnIds(db)).toEqual([]);
  });
});
