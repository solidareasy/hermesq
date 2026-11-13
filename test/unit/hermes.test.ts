import { beforeAll, describe, expect, it } from 'vitest';
import { DeliveryStore } from '../../src/deliveries/store';
import type { HermesDelivery } from '../../src/types';
import { ack, ADMIN, adminSetSecrets, call, env, HERMES_SECRET, hermesHeaders, poll } from './helpers';

const store = () => new DeliveryStore(env.DB, env.EVENT_STORE);

let n = 0;
function delivery(over: Partial<HermesDelivery> = {}): HermesDelivery {
  n += 1;
  return {
    deliveryId: `d-${Date.now()}-${n}`,
    subscriptionName: 'test-sub',
    event: 'Issue.created',
    prompt: `prompt ${n}`,
    skills: [],
    deliver: 'log',
    payload: { n },
    sourceDeliveryId: `test:${n}`,
    createdAt: new Date().toISOString(),
    attempts: 0,
    maxAttempts: 3,
    status: 'pending',
    ...over,
  };
}

/** Claims everything that is ready so a test starts from an empty queue. */
async function drain() {
  for (;;) {
    const { body } = await poll('limit=50&wait=0', 'drainer');
    if (body.deliveries.length === 0) return;
    for (const d of body.deliveries) await ack(d.deliveryId as string, 'delivered', null, 'drainer');
  }
}

beforeAll(async () => {
  await adminSetSecrets({ HERMES_WEBHOOK_SECRET: HERMES_SECRET });
});

describe('/hermes authentication', () => {
  it('rejects missing, wrong, stale and path-swapped signatures', async () => {
    expect((await call('/hermes/poll?wait=0')).status).toBe(401);

    const bad = await call('/hermes/poll?wait=0', { headers: { ...(await hermesHeaders('GET', '/hermes/poll?wait=0', '')), 'x-hermes-signature': `sha256=${'0'.repeat(64)}` } });
    expect(await bad.json()).toMatchObject({ reason: 'bad_signature' });

    const old = Math.floor(Date.now() / 1000) - 301;
    const stale = await call('/hermes/poll?wait=0', { headers: await hermesHeaders('GET', '/hermes/poll?wait=0', '', 'h', old) });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ reason: 'stale_timestamp' });

    // A signature for one query string must not authorize another (limit is covered by the signature).
    const swapped = await call('/hermes/poll?wait=0&limit=50', { headers: await hermesHeaders('GET', '/hermes/poll?wait=0', '') });
    expect(await swapped.json()).toMatchObject({ reason: 'bad_signature' });

    // The ack body is signed too.
    const body = JSON.stringify({ deliveryId: 'x', status: 'delivered' });
    const tampered = await call('/hermes/ack', { method: 'POST', headers: await hermesHeaders('POST', '/hermes/ack', body), body: body.replace('x', 'y') });
    expect(tampered.status).toBe(401);
  });

  it('validates the ack body', async () => {
    const body = JSON.stringify({ deliveryId: 'x', status: 'done' });
    const res = await call('/hermes/ack', { method: 'POST', headers: await hermesHeaders('POST', '/hermes/ack', body), body });
    expect(res.status).toBe(400);
    const missing = await ack('does-not-exist', 'delivered');
    expect(missing.res.status).toBe(404);
  });
});

describe('/hermes/poll long-poll', () => {
  it('holds an empty poll for the configured 5 s and returns the cursor it was given', async () => {
    await drain();
    const t0 = Date.now();
    const { res, body } = await poll('limit=5&lastDeliveryId=cursor-1');
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(body).toEqual({ deliveries: [], cursor: 'cursor-1' });
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    expect(elapsed).toBeLessThan(7000);
  });

  it('returns as soon as a delivery arrives during the hold', async () => {
    await drain();
    const d = delivery();
    const t0 = Date.now();
    const pending = poll('limit=5&wait=5000');
    await new Promise((r) => setTimeout(r, 700));
    await store().insert(d);
    const { body } = await pending;
    const elapsed = Date.now() - t0;
    expect(body.deliveries.map((x) => x.deliveryId)).toEqual([d.deliveryId]);
    expect(body.cursor).toBe(d.deliveryId);
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(2500);
    await ack(d.deliveryId, 'delivered');
  });

  it('two consumers get disjoint deliveries, in order, and only the owner can ack', async () => {
    await drain();
    const ds = [delivery(), delivery(), delivery(), delivery()];
    for (const d of ds) await store().insert(d);
    const a = await poll('limit=2&wait=0', 'host-a');
    const b = await poll('limit=10&wait=0', 'host-b');
    const ida = a.body.deliveries.map((d) => d.deliveryId);
    const idb = b.body.deliveries.map((d) => d.deliveryId);
    expect(ida).toEqual([ds[0]!.deliveryId, ds[1]!.deliveryId]);
    expect(idb).toEqual([ds[2]!.deliveryId, ds[3]!.deliveryId]);

    const stolen = await ack(ida[0] as string, 'delivered', null, 'host-b');
    expect(stolen.res.status).toBe(409);
    expect(stolen.body).toEqual({ error: 'not_owner' });
    for (const id of ida) expect((await ack(id as string, 'delivered', null, 'host-a')).res.status).toBe(200);
    for (const id of idb) expect((await ack(id as string, 'delivered', null, 'host-b')).res.status).toBe(200);
  });
});

describe('delivery retry and dead-letter', () => {
  it('failed acks back off 1 s then 2 s; the 3rd failure is a dead letter kept in KV without TTL', async () => {
    await drain();
    const d = delivery();
    await store().insert(d);

    const claimOne = async () => (await poll('limit=1&wait=0')).body.deliveries[0];
    const first = await claimOne();
    expect(first).toMatchObject({ deliveryId: d.deliveryId, attempts: 1 });
    expect((await ack(d.deliveryId, 'failed', { error: 'boom 1' })).body).toEqual({ deliveryId: d.deliveryId, status: 'pending' });

    expect(await claimOne()).toBeUndefined(); // backoff: not ready yet
    await new Promise((r) => setTimeout(r, 1100));
    expect(await claimOne()).toMatchObject({ deliveryId: d.deliveryId, attempts: 2 });
    expect((await ack(d.deliveryId, 'failed', { error: 'boom 2' })).body.status).toBe('pending');

    await new Promise((r) => setTimeout(r, 1100));
    expect(await claimOne()).toBeUndefined(); // second backoff is 2 s
    await new Promise((r) => setTimeout(r, 1000));
    expect(await claimOne()).toMatchObject({ deliveryId: d.deliveryId, attempts: 3 });
    expect((await ack(d.deliveryId, 'failed', { error: 'boom 3' })).body.status).toBe('dead-letter');

    expect(await claimOne()).toBeUndefined();
    const kv = (await env.EVENT_STORE.get(`delivery:${d.deliveryId}`, 'json')) as Record<string, unknown>;
    expect(kv).toMatchObject({ status: 'dead-letter', attempts: 3, result: { error: 'boom 3' } });
    const listed = await env.EVENT_STORE.list({ prefix: `delivery:${d.deliveryId}` });
    expect(listed.keys[0]?.expiration).toBeUndefined();
    const auditRow = await env.DB.prepare('SELECT kind FROM audit WHERE ref = ?').bind(d.deliveryId).first<{ kind: string }>();
    expect(auditRow?.kind).toBe('delivery.dead-letter');

    // Manual reprocessing through the admin API puts it back with a fresh budget.
    const requeue = await call(`/admin/deliveries/${d.deliveryId}/requeue`, { method: 'POST', headers: ADMIN });
    expect(await requeue.json()).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await claimOne()).toMatchObject({ deliveryId: d.deliveryId, attempts: 1 });
    await ack(d.deliveryId, 'delivered');
  }, 15_000);

  it('a claim whose lease expires without an ack is retried, and dead-lettered on the last attempt', async () => {
    await drain();
    const d = delivery({ maxAttempts: 2 });
    const s = store();
    await s.insert(d);
    const now = Date.now();
    expect((await s.claim('h', 1, 1000, now)).map((x) => x.deliveryId)).toEqual([d.deliveryId]);
    expect(await s.reclaimExpired(now + 500)).toEqual([]);
    expect(await s.reclaimExpired(now + 1001)).toEqual([{ deliveryId: d.deliveryId, status: 'pending' }]);
    expect((await s.claim('h', 1, 1000, now + 1002)).map((x) => x.attempts)).toEqual([2]);
    expect(await s.reclaimExpired(now + 2003)).toEqual([{ deliveryId: d.deliveryId, status: 'dead-letter' }]);
    expect(await s.get(d.deliveryId)).toMatchObject({ status: 'dead-letter', result: 'lease_expired' });
  });

  it('inserting the same delivery id twice keeps one row (consumer retries never duplicate work)', async () => {
    const d = delivery();
    expect(await store().insert(d)).toBe(true);
    expect(await store().insert(d)).toBe(false);
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS c FROM deliveries WHERE delivery_id = ?').bind(d.deliveryId).all<{ c: number }>();
    expect(results[0]?.c).toBe(1);
  });
});

describe('admin delivery API', () => {
  it('lists by status and requires the admin token', async () => {
    expect((await call('/admin/deliveries')).status).toBe(401);
    const res = await call('/admin/deliveries?status=dead-letter', { headers: ADMIN });
    const body = (await res.json()) as { deliveries: { status: string }[] };
    expect(body.deliveries.every((d) => d.status === 'dead-letter')).toBe(true);
    expect((await call('/admin/deliveries?status=bogus', { headers: ADMIN })).status).toBe(400);
  });
});
