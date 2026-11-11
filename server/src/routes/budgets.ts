import type { FastifyInstance } from 'fastify';
import type { BudgetSetInput } from '@ledger/shared';
import type { DB } from '../db/connection';
import { ValidationError } from '../errors';
import { copyPreviousMonth, getBudgetMonth, setBudget } from '../services/budgets';
import { parseScope } from '../services/scope';

export function registerBudgetRoutes(app: FastifyInstance, db: DB) {
  app.get<{ Params: { month: string }; Querystring: { scope?: string } }>('/api/budgets/:month', async (req) =>
    getBudgetMonth(db, parseScope(db, req.query.scope), req.params.month),
  );

  app.put<{ Params: { month: string; categoryId: string }; Body: BudgetSetInput }>(
    '/api/budgets/:month/:categoryId',
    async (req, reply) => {
      if (!req.body || !('amountCents' in req.body)) throw new ValidationError('amountCents is required (null clears)');
      setBudget(db, req.params.month, Number(req.params.categoryId), req.body.amountCents);
      reply.status(204);
    },
  );

  app.post<{ Params: { month: string } }>('/api/budgets/:month/copy-previous', async (req) => ({
    copied: copyPreviousMonth(db, req.params.month),
  }));
}
