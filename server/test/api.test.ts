import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { accountInput, testDb } from './helpers';

describe('HTTP API', () => {
  it('creates, edits, archives and scopes accounts', async () => {
    const { db, me, partner } = testDb();
    const app = buildApp(db);

    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: accountInput(me, { name: 'Emergency Fund', type: 'savings', openingBalanceCents: 5000 }),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${id}`,
      payload: { name: 'Rainy Day', ownerIds: [me, partner] },
    });
    expect(patched.json()).toMatchObject({ name: 'Rainy Day', isJoint: true, balanceCents: 5000 });

    const partnerView = await app.inject({ url: `/api/accounts?scope=person:${partner}` });
    expect(partnerView.json()).toHaveLength(1);

    await app.inject({ method: 'POST', url: `/api/accounts/${id}/archive` });
    expect((await app.inject({ url: '/api/accounts' })).json()).toHaveLength(0);
    expect((await app.inject({ url: '/api/accounts?includeArchived=1' })).json()).toHaveLength(1);
  });

  it('returns 400 with a message for invalid input and 404 for missing rows', async () => {
    const { db, me } = testDb();
    const app = buildApp(db);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: accountInput(me, { name: '' }),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/name/);
    expect((await app.inject({ url: '/api/accounts/999' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/accounts?scope=person:999' })).statusCode).toBe(400);
  });

  it('renames people', async () => {
    const { db, partner } = testDb();
    const app = buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/people/${partner}`,
      payload: { displayName: 'Sam' },
    });
    expect(res.json().displayName).toBe('Sam');
  });
});

describe('transactions API', () => {
  it('create → list → update → delete', async () => {
    const { db, me } = testDb();
    const app = buildApp(db);
    const account = (
      await app.inject({ method: 'POST', url: '/api/accounts', payload: accountInput(me, { openingBalanceCents: 10000 }) })
    ).json();
    const groceries = (await app.inject({ url: '/api/categories' })).json().find((c: any) => c.name === 'Groceries');

    const body = {
      date: '2026-03-01',
      payee: 'Market',
      createdByPersonId: me,
      postings: [
        { accountId: account.id, categoryId: null, amountCents: -1234 },
        { accountId: null, categoryId: groceries.id, amountCents: 1234 },
      ],
    };
    const created = await app.inject({ method: 'POST', url: '/api/txns', payload: body });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const list = (await app.inject({ url: `/api/txns?accountId=${account.id}&q=mark` })).json();
    expect(list.total).toBe(1);
    expect(list.txns[0].runningBalanceCents).toBe(10000 - 1234);

    body.postings[0].amountCents = -2000;
    body.postings[1].amountCents = 2000;
    const updated = await app.inject({ method: 'PUT', url: `/api/txns/${id}`, payload: body });
    expect(updated.json().postings[0].amountCents).toBe(-2000);

    body.postings[1].amountCents = 1999;
    const unbalanced = await app.inject({ method: 'PUT', url: `/api/txns/${id}`, payload: body });
    expect(unbalanced.statusCode).toBe(400);
    expect(unbalanced.json().error).toMatch(/balance/);

    expect((await app.inject({ method: 'DELETE', url: `/api/txns/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/txns/${id}` })).statusCode).toBe(404);
  });

  it('rejects bad filters', async () => {
    const { db } = testDb();
    const app = buildApp(db);
    expect((await app.inject({ url: '/api/txns?status=nope' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/txns?accountId=abc' })).statusCode).toBe(400);
  });
});

describe('categories API', () => {
  it('adds, renames, changes kind, archives; system categories are locked', async () => {
    const { db } = testDb();
    const app = buildApp(db);
    const created = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Pets', kind: 'expense' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const dup = await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'pets', kind: 'expense' } });
    expect(dup.json().error).toMatch(/already exists/);

    const renamed = await app.inject({ method: 'PATCH', url: `/api/categories/${id}`, payload: { name: 'Pet Care', kind: 'expense' } });
    expect(renamed.json().name).toBe('Pet Care');

    const badKind = await app.inject({ method: 'PATCH', url: `/api/categories/${id}`, payload: { kind: 'valuation' } });
    expect(badKind.statusCode).toBe(400);

    expect((await app.inject({ method: 'POST', url: `/api/categories/${id}/archive` })).json().archivedAt).not.toBeNull();

    const system = (await app.inject({ url: '/api/categories' })).json().find((c: any) => c.name === 'Uncategorized');
    const locked = await app.inject({ method: 'PATCH', url: `/api/categories/${system.id}`, payload: { name: 'X' } });
    expect(locked.json().error).toMatch(/managed by the app/);
  });
});
