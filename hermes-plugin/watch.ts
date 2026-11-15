// Monitor do hermesQ (`hermes hermesq watch`, cron sem LLM): stdout vazio e exit 0 = tudo bem;
// problema = uma linha no stdout e exit 1. Uso: node hermes-plugin/watch.ts (Node >= 22.18, type stripping, sem build).
// Env: HERMESQ_URL (obrigatória), HERMESQ_ADMIN_TOKEN ou HERMESQ_ADMIN_TOKEN_FILE.
import { readFile } from 'node:fs/promises';

const MAX_AGE_MIN = 10;

export interface Delivery {
  subscriptionName: string;
  status: string;
  createdAt: string;
}

/** Entregas que pedem atenção: falhas, dead-letter e paradas na fila há mais de MAX_AGE_MIN. */
export function problems(deliveries: Delivery[], now = Date.now()): string[] {
  return deliveries.flatMap((d) => {
    const age = (now - Date.parse(d.createdAt)) / 60_000;
    const stuck = (d.status === 'pending' || d.status === 'processing') && age > MAX_AGE_MIN;
    return d.status === 'failed' || d.status === 'dead-letter' || stuck ? [`${d.subscriptionName} ${d.status} (${Math.round(age)} min)`] : [];
  });
}

async function get(base: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(base + path, { headers: { 'user-agent': 'hermesq-watch', ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function adminToken(): Promise<string> {
  if (process.env.HERMESQ_ADMIN_TOKEN) return process.env.HERMESQ_ADMIN_TOKEN;
  const file = process.env.HERMESQ_ADMIN_TOKEN_FILE;
  if (!file) throw new Error('defina HERMESQ_ADMIN_TOKEN ou HERMESQ_ADMIN_TOKEN_FILE');
  return (await readFile(file, 'utf8')).trim();
}

/** null = saudável; senão, a mensagem do alerta. */
export async function check(): Promise<string | null> {
  const base = process.env.HERMESQ_URL;
  if (!base) return 'hermesQ: defina HERMESQ_URL';
  try {
    await get(base, '/health');
  } catch {
    return `hermesQ: /health não responde em ${base}`;
  }
  let deliveries: Delivery[];
  try {
    const res = await get(base, '/admin/deliveries?limit=50', { authorization: `Bearer ${await adminToken()}` });
    deliveries = ((await res.json()) as { deliveries: Delivery[] }).deliveries;
  } catch {
    return 'hermesQ: não consegui ler /admin/deliveries';
  }
  const bad = problems(deliveries);
  return bad.length ? `hermesQ: entregas com problema: ${bad.slice(0, 5).join('; ')}` : null;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const message = await check();
  if (message) {
    console.log(message);
    process.exitCode = 1;
  }
}
