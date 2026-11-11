import type { FastifyInstance } from 'fastify';
import type { ReconcileInput, SnapshotInput, StatusInput } from '@ledger/shared';
import type { DB } from '../db/connection';
import {
  completeReconciliation,
  reconcileSummary,
  setTxnStatus,
  undoLastReconciliation,
} from '../services/reconcile';
import {
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  updateSnapshot,
} from '../services/snapshots';

/** Cleared status, statement reconciliation and investment snapshots. */
export function registerReconcileRoutes(app: FastifyInstance, db: DB) {
  // Cleared toggle: { status: 'cleared' | 'uncleared', accountId? }
  app.post<{ Params: { id: string }; Body: StatusInput }>('/api/txns/:id/status', async (req) =>
    setTxnStatus(db, Number(req.params.id), req.body),
  );

  app.get<{ Params: { id: string }; Querystring: { statementDate?: string } }>(
    '/api/accounts/:id/reconcile',
    async (req) => reconcileSummary(db, Number(req.params.id), req.query.statementDate ?? ''),
  );

  app.post<{ Params: { id: string }; Body: ReconcileInput }>(
    '/api/accounts/:id/reconciliations',
    async (req, reply) => {
      reply.status(201);
      return completeReconciliation(db, Number(req.params.id), req.body);
    },
  );

  // Undo the latest reconciliation for the account.
  app.delete<{ Params: { id: string } }>('/api/accounts/:id/reconciliations/latest', async (req, reply) => {
    undoLastReconciliation(db, Number(req.params.id));
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/accounts/:id/snapshots', async (req) =>
    listSnapshots(db, Number(req.params.id)),
  );

  app.post<{ Params: { id: string }; Body: SnapshotInput }>('/api/accounts/:id/snapshots', async (req, reply) => {
    reply.status(201);
    return createSnapshot(db, Number(req.params.id), req.body);
  });

  app.patch<{ Params: { id: string }; Body: Partial<SnapshotInput> }>('/api/snapshots/:id', async (req) =>
    updateSnapshot(db, Number(req.params.id), req.body ?? {}),
  );

  app.delete<{ Params: { id: string } }>('/api/snapshots/:id', async (req, reply) => {
    deleteSnapshot(db, Number(req.params.id));
    return reply.status(204).send();
  });
}
