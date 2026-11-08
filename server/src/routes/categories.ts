import type { FastifyInstance } from 'fastify';
import type { CategoryInput } from '@ledger/shared';
import type { DB } from '../db/connection';
import {
  createCategory,
  listCategories,
  setCategoryArchived,
  updateCategory,
} from '../services/categories';

export function registerCategoryRoutes(app: FastifyInstance, db: DB) {
  app.get('/api/categories', async () => listCategories(db));

  app.post<{ Body: CategoryInput }>('/api/categories', async (req, reply) => {
    reply.status(201);
    return createCategory(db, req.body);
  });

  app.patch<{ Params: { id: string }; Body: Partial<CategoryInput> }>(
    '/api/categories/:id',
    async (req) => updateCategory(db, Number(req.params.id), req.body ?? {}),
  );

  app.post<{ Params: { id: string } }>('/api/categories/:id/archive', async (req) =>
    setCategoryArchived(db, Number(req.params.id), true),
  );

  app.post<{ Params: { id: string } }>('/api/categories/:id/unarchive', async (req) =>
    setCategoryArchived(db, Number(req.params.id), false),
  );
}
