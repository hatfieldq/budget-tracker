import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/connection';
import { overviewReport } from '../services/reports';
import { parseScope } from '../services/scope';

export function registerReportRoutes(app: FastifyInstance, db: DB) {
  app.get<{ Querystring: { scope?: string; from?: string; to?: string } }>('/api/reports/overview', async (req) =>
    overviewReport(db, parseScope(db, req.query.scope), req.query.from ?? '', req.query.to ?? ''),
  );
}
