import { withSchema } from '../db/schema';

export const EVENT_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Claims an event key. Returns false when the key was already seen (a provider retry).
 * D1 gives a strongly consistent unique insert; KV alone is eventually consistent and would
 * let two concurrent retries through.
 */
export async function claimEvent(db: D1Database, eventKey: string, service: string, now = Date.now()): Promise<boolean> {
  const res = await withSchema(db, () =>
    db.prepare('INSERT INTO events (event_key, service, received_at) VALUES (?, ?, ?) ON CONFLICT (event_key) DO NOTHING').bind(eventKey, service, now).run(),
  );
  return (res.meta.changes ?? 0) > 0;
}

/** Undo a claim when the event could not be stored, so the provider's retry is accepted. */
export async function releaseEvent(db: D1Database, eventKey: string): Promise<void> {
  await withSchema(db, () => db.prepare('DELETE FROM events WHERE event_key = ?').bind(eventKey).run());
}

export async function pruneEvents(db: D1Database, now = Date.now()): Promise<number> {
  const res = await withSchema(db, () => db.prepare('DELETE FROM events WHERE received_at < ?').bind(now - EVENT_TTL_SECONDS * 1000).run());
  return res.meta.changes ?? 0;
}
