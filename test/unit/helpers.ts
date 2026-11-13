import { env as cfEnv, exports } from 'cloudflare:workers';
import { hermesSigningString } from '../../src/routes/hermes';
import type { Env } from '../../src/types';
import { hmacSha256Hex } from '../../src/utils/hmac';

export const env = cfEnv as unknown as Env;

export const BASE = 'https://transfer.test';
export const ADMIN = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };
export const HERMES_SECRET = 'hermes-shared-secret-for-tests';
export const LINEAR_SECRET = 'lin_wh_test_secret';

export function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

export async function adminSetSecrets(values: Record<string, string>): Promise<void> {
  const res = await call('/setup/secrets', { method: 'POST', headers: ADMIN, body: JSON.stringify(values) });
  if (res.status !== 200) throw new Error(`setSecrets ${res.status} ${await res.text()}`);
}

export async function hermesHeaders(method: string, pathWithQuery: string, body: string, consumer = 'test-host', ts = Math.floor(Date.now() / 1000)) {
  const sig = await hmacSha256Hex(HERMES_SECRET, hermesSigningString(String(ts), method, pathWithQuery, body));
  return { 'x-hermes-timestamp': String(ts), 'x-hermes-signature': `sha256=${sig}`, 'x-hermes-consumer': consumer, 'content-type': 'application/json' };
}

export async function poll(query = 'limit=10&wait=0', consumer = 'test-host') {
  const path = `/hermes/poll?${query}`;
  const res = await call(path, { headers: await hermesHeaders('GET', path, '', consumer) });
  return { res, body: (await res.json()) as { deliveries: Array<Record<string, unknown>>; cursor: string | null } };
}

export async function ack(deliveryId: string, status: 'delivered' | 'failed', result: unknown = null, consumer = 'test-host') {
  const body = JSON.stringify({ deliveryId, status, result });
  const res = await call('/hermes/ack', { method: 'POST', headers: await hermesHeaders('POST', '/hermes/ack', body, consumer), body });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

export async function signedLinear(payload: Record<string, unknown>, deliveryId: string, secret = LINEAR_SECRET) {
  const raw = JSON.stringify({ webhookTimestamp: Date.now(), ...payload });
  const sig = await hmacSha256Hex(secret, raw);
  return call('/linear', { method: 'POST', headers: { 'content-type': 'application/json', 'linear-signature': sig, 'linear-delivery': deliveryId }, body: raw });
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 8000, stepMs = 100): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

type Delivery = Record<string, unknown>;

/**
 * Polls (claiming) until a delivery for every `sourceDeliveryId` was seen. A single poll may claim
 * several deliveries at once, so results are accumulated instead of searched one at a time.
 */
export async function collect(sourceIds: string[], consumer = 'test-host', timeoutMs = 8000): Promise<Record<string, Delivery>> {
  const seen: Record<string, Delivery> = {};
  await waitFor(async () => {
    const { body } = await poll('limit=50&wait=0', consumer);
    for (const d of body.deliveries) seen[d.sourceDeliveryId as string] = d;
    return sourceIds.every((id) => seen[id]);
  }, timeoutMs);
  return seen;
}
