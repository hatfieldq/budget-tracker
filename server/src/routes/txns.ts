import type { FastifyInstance } from 'fastify';
import type { PostingStatus, TxnInput } from '@ledger/shared';
import type { DB } from '../db/connection';
import { ValidationError } from '../errors';
import { createTxn, deleteTxn, getTxn, listTxns, updateTxn } from '../services/ledger';
import { parseScope } from '../services/scope';

type ListQuery = Partial<
  Record<
    'scope' | 'accountId' | 'categoryId' | 'from' | 'to' | 'q' | 'status' | 'uncategorized' | 'createdBy' | 'limit' | 'offset',
    string
  >
>;

const optionalInt = (v: string | undefined, name: string) => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ValidationError(`${name} must be a whole number`);
  return n;
};

export function registerTxnRoutes(app: FastifyInstance, db: DB) {
  // GET /api/txns?scope=&accountId=&categoryId=&from=&to=&q=&status=&uncategorized=1&createdBy=&limit=&offset=
  app.get<{ Querystring: ListQuery }>('/api/txns', async (req) => {
    const q = req.query;
    if (q.status && !['uncleared', 'cleared', 'reconciled'].includes(q.status)) {
      throw new ValidationError('status must be uncleared, cleared or reconciled');
    }
    return listTxns(db, {
      scope: parseScope(db, q.scope),
      accountId: optionalInt(q.accountId, 'accountId'),
      categoryId: optionalInt(q.categoryId, 'categoryId'),
      from: q.from || undefined,
      to: q.to || undefined,
      q: q.q,
      status: (q.status || undefined) as PostingStatus | undefined,
      uncategorized: q.uncategorized === '1',
      createdBy: optionalInt(q.createdBy, 'createdBy'),
      limit: optionalInt(q.limit, 'limit'),
      offset: optionalInt(q.offset, 'offset'),
    });
  });

  app.get<{ Params: { id: string } }>('/api/txns/:id', async (req) => getTxn(db, Number(req.params.id)));

  app.post<{ Body: TxnInput }>('/api/txns', async (req, reply) => {
    reply.status(201);
    return createTxn(db, req.body);
  });

  app.put<{ Params: { id: string }; Body: TxnInput }>('/api/txns/:id', async (req) =>
    updateTxn(db, Number(req.params.id), req.body),
  );

  app.delete<{ Params: { id: string } }>('/api/txns/:id', async (req, reply) => {
    deleteTxn(db, Number(req.params.id));
    return reply.status(204).send();
  });
}
