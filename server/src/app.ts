import Fastify from 'fastify';
import type { DB } from './db/connection';
import { HttpError } from './errors';
import { registerAccountRoutes } from './routes/accounts';
import { registerPeopleRoutes } from './routes/people';
import { registerCategoryRoutes } from './routes/categories';
import { registerTxnRoutes } from './routes/txns';
import { registerReconcileRoutes } from './routes/reconcile';
import { registerBudgetRoutes } from './routes/budgets';
import { registerReportRoutes } from './routes/reports';

/** Build the HTTP app around an open DB. Tests call this with an in-memory DB. */
export function buildApp(db: DB) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.message });
    }
    // Fastify's own errors (bad JSON etc.) carry a statusCode.
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(status).send({ error: status >= 500 ? 'Internal error' : message });
  });

  app.get('/api/health', async () => ({ ok: true }));
  registerPeopleRoutes(app, db);
  registerCategoryRoutes(app, db);
  registerAccountRoutes(app, db);
  registerTxnRoutes(app, db);
  registerReconcileRoutes(app, db);
  registerBudgetRoutes(app, db);
  registerReportRoutes(app, db);
  return app;
}

export type App = ReturnType<typeof buildApp>;
