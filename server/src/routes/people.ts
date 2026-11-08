import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/connection';
import { listPeople, renamePerson } from '../services/people';

export function registerPeopleRoutes(app: FastifyInstance, db: DB) {
  app.get('/api/people', async () => listPeople(db));

  app.patch<{ Params: { id: string }; Body: { displayName?: string } }>(
    '/api/people/:id',
    async (req) => renamePerson(db, Number(req.params.id), req.body?.displayName),
  );
}
