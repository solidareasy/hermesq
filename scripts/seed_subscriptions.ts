// Replaces the Worker's subscription list (KV `subscriptions:list`) through the admin API; no redeploy.
//   ADMIN_TOKEN=... npm run seed -- --url https://<worker> --file my-subscriptions.json
//   ADMIN_TOKEN=... npm run seed -- --url https://<worker> --defaults      (the built-in list)
// The file holds a JSON array of subscriptions (see README, "Subscriptions").
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_SUBSCRIPTIONS } from '../src/subscriptions/defaults.ts';

const { values } = parseArgs({ options: { url: { type: 'string' }, file: { type: 'string' }, defaults: { type: 'boolean' } } });
const token = process.env.ADMIN_TOKEN;
if (!values.url || !token || (!values.file && !values.defaults)) {
  console.error('usage: ADMIN_TOKEN=... seed_subscriptions.ts --url <worker url> (--file <subscriptions.json> | --defaults)');
  process.exit(2);
}
const list: unknown = values.defaults ? DEFAULT_SUBSCRIPTIONS : JSON.parse(readFileSync(values.file!, 'utf8'));
const res = await fetch(`${values.url.replace(/\/+$/, '')}/admin/subscriptions`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(list),
});
const body = (await res.json()) as { subscriptions?: { name: string }[]; error?: string; detail?: string };
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${body.error ?? ''} ${body.detail ?? ''}`.trim());
  process.exit(1);
}
console.log(`saved ${body.subscriptions?.length ?? 0} subscriptions: ${(body.subscriptions ?? []).map((s) => s.name).join(', ')}`);
