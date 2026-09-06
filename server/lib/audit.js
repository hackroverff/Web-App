/** Append-only audit trail for anything that touches money, prices or approval. */
import { run, all, pluck } from '../db/index.js';

export function audit({ actorType = 'owner', actorId = null, actorLabel = 'owner', action, entity = null, entityId = null, detail = null }) {
  const note = typeof detail === 'object' && detail !== null ? JSON.stringify(detail).slice(0, 1500) : detail === null || detail === undefined ? null : String(detail).slice(0, 1500);
  return run(
    'INSERT INTO audit_log (actor_type, actor_id, actor_label, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?,?)',
    [actorType, actorId, actorLabel, action, entity, entityId, note],
  ).lastInsertRowid;
}

export function recentAudit(limit = 50) {
  return all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [Math.min(200, Number(limit) || 50)]);
}

export function auditCount() {
  return Number(pluck('SELECT COUNT(*) AS n FROM audit_log') || 0);
}
