import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/connection';
import { parseScope } from '../services/scope';
import { listPayees, todaySummary } from '../services/today';

export function registerTodayRoutes(app: FastifyInstance, db: DB) {
  app.get<{ Querystring: { scope?: string } }>('/api/today', async (req) =>
    todaySummary(db, parseScope(db, req.query.scope)),
  );
  app.get('/api/payees', async () => listPayees(db));
}
