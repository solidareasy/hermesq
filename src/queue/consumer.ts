import { audit } from '../db/schema';
import { DeliveryStore } from '../deliveries/store';
import { eventRecordKey } from '../routes/ingest';
import { buildDelivery, matchSubscriptions } from '../subscriptions/matcher';
import { loadSubscriptions } from '../subscriptions/store';
import { type DeliveryMessage, type Env, type EventMessage, intVar, type QueueMessageBody } from '../types';
import { EVENT_TTL_SECONDS } from '../utils/idempotency';

/** Consumer attempts per message before it becomes a dead letter (spec: 3). */
export const DEFAULT_MAX_ATTEMPTS = 3;

export const retryDelaySeconds = (attempts: number) => 2 ** Math.max(0, attempts - 1); // 1s, 2s, 4s...

async function processEvent(env: Env, msg: EventMessage): Promise<number> {
  const subs = await loadSubscriptions(env.EVENT_STORE);
  const matches = matchSubscriptions(subs, msg.eventTypes, msg.payload);
  const maxAttempts = intVar(env.MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
  const now = new Date();
  const deliveries: DeliveryMessage[] = [];
  for (const { sub, event } of matches) deliveries.push({ kind: 'delivery', delivery: await buildDelivery(msg, sub, event, maxAttempts, now) });
  if (deliveries.length) await env.HERMES_QUEUE.sendBatch(deliveries.map((body) => ({ body, contentType: 'json' as const })));
  await env.EVENT_STORE.put(
    eventRecordKey(msg.eventKey),
    JSON.stringify({ status: deliveries.length ? 'routed' : 'no-match', service: msg.service, eventTypes: msg.eventTypes, deliveries: deliveries.map((d) => d.delivery.deliveryId), receivedAt: msg.receivedAt }),
    { expirationTtl: EVENT_TTL_SECONDS },
  );
  return deliveries.length;
}

async function processDelivery(env: Env, msg: DeliveryMessage): Promise<void> {
  await new DeliveryStore(env.DB, env.EVENT_STORE).insert(msg.delivery);
}

async function deadLetter(env: Env, body: QueueMessageBody, error: string, attempts: number): Promise<void> {
  const ref = body.kind === 'event' ? body.eventKey : body.delivery.deliveryId;
  const key = body.kind === 'event' ? eventRecordKey(body.eventKey) : `delivery:${body.delivery.deliveryId}`;
  // No TTL: dead letters stay until an operator reprocesses them.
  await env.EVENT_STORE.put(key, JSON.stringify({ status: 'dead-letter', error, attempts, failedAt: new Date().toISOString(), message: body }));
  await audit(env.DB, `${body.kind}.dead-letter`, ref, { error, attempts });
  console.error(JSON.stringify({ msg: 'dead-letter', kind: body.kind, ref, error, attempts }));
}

/**
 * One handler for every queue (dispatch by message kind, not queue name, so renamed queues still work).
 * Failure: retry with backoff 1s, 2s...; on the last attempt the message is written to KV as `dead-letter` and acked.
 */
export async function handleQueue(batch: MessageBatch<QueueMessageBody>, env: Env): Promise<void> {
  const maxAttempts = intVar(env.MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
  for (const message of batch.messages) {
    const body = message.body;
    try {
      if (body?.kind === 'event') await processEvent(env, body);
      else if (body?.kind === 'delivery') await processDelivery(env, body);
      else throw new Error('unknown message kind');
      message.ack();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (message.attempts >= maxAttempts) {
        try {
          await deadLetter(env, body, error, message.attempts);
          message.ack();
        } catch (dlqErr) {
          console.error(JSON.stringify({ msg: 'dead-letter write failed', error: String(dlqErr) }));
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        }
      } else {
        console.warn(JSON.stringify({ msg: 'retry', kind: body?.kind, attempts: message.attempts, error }));
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  }
}
