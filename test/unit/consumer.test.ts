import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema } from '../../src/db/schema';
import worker from '../../src/index';
import { SUBSCRIPTIONS_KEY } from '../../src/subscriptions/store';
import type { EventMessage, QueueMessageBody } from '../../src/types';
import { env, waitFor } from './helpers';

/**
 * A MessageBatch whose messages record ack()/retry(options). The plugin's createMessageBatch drops
 * retry options, and the backoff delay is exactly what these tests check.
 */
function recordingBatch(body: QueueMessageBody, attempts: number) {
  const result = { explicitAcks: [] as string[], retryMessages: [] as { msgId: string; delaySeconds?: number }[] };
  const id = `m-${attempts}`;
  const message = {
    id,
    timestamp: new Date(),
    attempts,
    body,
    ack: () => result.explicitAcks.push(id),
    retry: (opts?: QueueRetryOptions) => result.retryMessages.push({ msgId: id, delaySeconds: opts?.delaySeconds }),
  };
  const batch = { queue: 'webhook-linear', messages: [message], ackAll() {}, retryAll() {} } as unknown as MessageBatch<QueueMessageBody>;
  return { batch, result };
}

beforeAll(async () => {
  await ensureSchema(env.DB);
});

function event(id: string, eventTypes = ['Issue.created']): EventMessage {
  return {
    kind: 'event',
    service: 'linear',
    eventKey: `linear:${id}`,
    deliveryId: id,
    eventTypes,
    payload: { action: 'create', data: { identifier: 'ENG-9', title: 'T', state: { name: 'Todo' } } },
    receivedAt: new Date().toISOString(),
  };
}

async function run(body: QueueMessageBody, attempts: number) {
  const { batch, result } = recordingBatch(body, attempts);
  await worker.queue(batch, env);
  return result;
}

afterEach(async () => {
  await env.EVENT_STORE.delete(SUBSCRIPTIONS_KEY);
});

describe('queue consumer', () => {
  it('routes an event to every matching subscription and acks it', async () => {
    await env.EVENT_STORE.put(
      SUBSCRIPTIONS_KEY,
      JSON.stringify([
        { name: 'a', events: ['Issue.created'], prompt: 'A {data.identifier}' },
        { name: 'b', events: ['*'], prompt: 'B {data.title}', skills: ['x'], deliver: 'telegram', deliverChatId: '42' },
        { name: 'off', events: ['Issue.created'], prompt: 'never', enabled: false },
      ]),
    );
    const result = await run(event('c-1'), 1);
    expect(result.explicitAcks).toEqual(['m-1']);
    expect(result.retryMessages).toEqual([]);

    // The HERMES_QUEUE consumer stores them (real queue, real D1).
    const rows = await waitFor(async () => {
      const { results } = await env.DB.prepare("SELECT subscription_name, body FROM deliveries WHERE source_event_key = 'linear:c-1' ORDER BY subscription_name").all<{
        subscription_name: string;
        body: string;
      }>();
      return results.length === 2 ? results : null;
    });
    expect(rows.map((r) => r.subscription_name)).toEqual(['a', 'b']);
    expect(JSON.parse(rows[1]!.body)).toMatchObject({ prompt: 'B T', skills: ['x'], deliver: 'telegram', deliverChatId: '42' });
    expect(await env.EVENT_STORE.get('event:linear:c-1', 'json')).toMatchObject({ status: 'routed' });
  });

  it('a subscription edited in KV changes routing without a redeploy', async () => {
    await env.EVENT_STORE.put(SUBSCRIPTIONS_KEY, JSON.stringify([{ name: 'only-comments', events: ['Comment.created'], prompt: 'c' }]));
    await run(event('c-2'), 1);
    expect(await env.EVENT_STORE.get('event:linear:c-2', 'json')).toMatchObject({ status: 'no-match', deliveries: [] });
  });

  it('retries a failing message with backoff 1 s, 2 s and dead-letters it on the 3rd attempt', async () => {
    // An invalid subscription list makes processing throw.
    await env.EVENT_STORE.put(SUBSCRIPTIONS_KEY, JSON.stringify({ not: 'a list' }));
    const body = event('c-3');

    const r1 = await run(body, 1);
    expect(r1.retryMessages).toEqual([{ msgId: 'm-1', delaySeconds: 1 }]);
    expect(r1.explicitAcks).toEqual([]);
    const r2 = await run(body, 2);
    expect(r2.retryMessages).toEqual([{ msgId: 'm-2', delaySeconds: 2 }]);

    const r3 = await run(body, 3);
    expect(r3.retryMessages).toEqual([]);
    expect(r3.explicitAcks).toEqual(['m-3']);
    const dl = (await env.EVENT_STORE.get('event:linear:c-3', 'json')) as Record<string, unknown>;
    expect(dl).toMatchObject({ status: 'dead-letter', attempts: 3, error: 'subscriptions must be an array', message: body });
    const listed = await env.EVENT_STORE.list({ prefix: 'event:linear:c-3' });
    expect(listed.keys[0]?.expiration).toBeUndefined();
    const auditRow = await env.DB.prepare("SELECT kind FROM audit WHERE ref = 'linear:c-3'").first<{ kind: string }>();
    expect(auditRow?.kind).toBe('event.dead-letter');
  });

  it('a redelivered batch does not duplicate deliveries (stable delivery id)', async () => {
    await env.EVENT_STORE.put(SUBSCRIPTIONS_KEY, JSON.stringify([{ name: 'a', events: ['Issue.created'], prompt: 'A' }]));
    await run(event('c-4'), 1);
    await run(event('c-4'), 2);
    await new Promise((r) => setTimeout(r, 2500));
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE source_event_key = 'linear:c-4'").all<{ c: number }>();
    expect(results[0]?.c).toBe(1);
  });

  it('an unknown message kind is retried, not silently acked', async () => {
    const r = await run({ kind: 'bogus' } as unknown as QueueMessageBody, 1);
    expect(r.retryMessages).toEqual([{ msgId: 'm-1', delaySeconds: 1 }]);
  });
});
