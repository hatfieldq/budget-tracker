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

  app.get<{ Params: { id: string } }>('/api/accounts/:id', async (req) =>
    getAccount(db, Number(req.params.id)),
  );

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
