import { Hono, type MiddlewareHandler } from 'hono';
import { DeliveryStore } from '../deliveries/store';
import { loadSubscriptions, saveSubscriptions, SubscriptionError } from '../subscriptions/store';
import { type DeliveryStatus, type Env, intVar } from '../types';
import { timingSafeEqual } from '../utils/hmac';

/** Bearer ADMIN_TOKEN (a Worker secret, asked for by the Deploy button). Without it every admin route is closed. */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.json({ error: 'admin_disabled', detail: 'set the ADMIN_TOKEN Worker secret' }, 503);
  const header = c.req.header('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given || !timingSafeEqual(given, token)) return c.json({ error: 'unauthorized' }, 401);
  await next();
};

const STATUSES: DeliveryStatus[] = ['pending', 'processing', 'delivered', 'failed', 'dead-letter'];

export const admin = new Hono<{ Bindings: Env }>();
admin.use('*', requireAdmin);

admin.get('/deliveries', async (c) => {
  const status = c.req.query('status') as DeliveryStatus | undefined;
  if (status && !STATUSES.includes(status)) return c.json({ error: 'invalid_status' }, 400);
  const limit = Math.min(200, Math.max(1, intVar(c.req.query('limit'), 50)));
  return c.json({ deliveries: await new DeliveryStore(c.env.DB, c.env.EVENT_STORE).list(status, limit) });
});

admin.get('/deliveries/:id', async (c) => {
  const d = await new DeliveryStore(c.env.DB, c.env.EVENT_STORE).get(c.req.param('id'));
  return d ? c.json(d) : c.json({ error: 'not_found' }, 404);
});

admin.post('/deliveries/:id/requeue', async (c) => {
  const d = await new DeliveryStore(c.env.DB, c.env.EVENT_STORE).requeue(c.req.param('id'));
  return d ? c.json(d) : c.json({ error: 'not_found' }, 404);
});

admin.get('/subscriptions', async (c) => c.json({ subscriptions: await loadSubscriptions(c.env.EVENT_STORE) }));

admin.put('/subscriptions', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const list = Array.isArray(body) ? body : (body as { subscriptions?: unknown })?.subscriptions;
  try {
    return c.json({ subscriptions: await saveSubscriptions(c.env.EVENT_STORE, list) });
  } catch (err) {
    if (err instanceof SubscriptionError) return c.json({ error: 'invalid_subscriptions', detail: err.message }, 400);
    throw err;
  }
});
