import type { FastifyInstance } from 'fastify';
import type { AccountInput, AccountUpdate } from '@ledger/shared';
import type { DB } from '../db/connection';
import {
  createAccount,
  getAccount,
  listAccounts,
  setArchived,
  updateAccount,
} from '../services/accounts';
import { parseScope } from '../services/scope';
import { isValidDate } from '../dates';
import { ValidationError } from '../errors';

export function registerAccountRoutes(app: FastifyInstance, db: DB) {
  // GET /api/accounts?scope=household|person:1&includeArchived=1
  app.get<{ Querystring: { scope?: string; includeArchived?: string } }>(
    '/api/accounts',
    async (req) =>
      listAccounts(db, {
        scope: parseScope(db, req.query.scope),
        includeArchived: req.query.includeArchived === '1',
      }),
  );

  // GET /api/accounts/:id?asOf=YYYY-MM-DD  (balance at end of that date; default today)
  app.get<{ Params: { id: string }; Querystring: { asOf?: string } }>('/api/accounts/:id', async (req) => {
    const { asOf } = req.query;
    if (asOf !== undefined && !isValidDate(asOf)) throw new ValidationError('asOf must be YYYY-MM-DD');
    return getAccount(db, Number(req.params.id), asOf);
  });

  app.post<{ Body: AccountInput }>('/api/accounts', async (req, reply) => {
    reply.status(201);
    return createAccount(db, req.body);
  });

  app.patch<{ Params: { id: string }; Body: AccountUpdate }>('/api/accounts/:id', async (req) =>
    updateAccount(db, Number(req.params.id), req.body ?? {}),
  );

  app.post<{ Params: { id: string } }>('/api/accounts/:id/archive', async (req) =>
    setArchived(db, Number(req.params.id), true),
  );

  app.post<{ Params: { id: string } }>('/api/accounts/:id/unarchive', async (req) =>
    setArchived(db, Number(req.params.id), false),
  );
}
