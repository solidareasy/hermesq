// Monitor do hermesQ para rodar em cron, sem LLM: stdout vazio = tudo bem; só problema vira mensagem.
// Uso: node scripts/watch.ts   (Node >= 22.18, type stripping; sem build)
// Env: HERMESQ_URL (obrigatória), HERMESQ_ADMIN_TOKEN ou HERMESQ_ADMIN_TOKEN_FILE.
import { problems, type Delivery } from '../src/ops/monitor.ts';

async function get(base: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(base + path, { headers: { 'user-agent': 'hermesq-watch', ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function adminToken(): Promise<string> {
  if (process.env.HERMESQ_ADMIN_TOKEN) return process.env.HERMESQ_ADMIN_TOKEN;
  const file = process.env.HERMESQ_ADMIN_TOKEN_FILE;
  if (!file) throw new Error('defina HERMESQ_ADMIN_TOKEN ou HERMESQ_ADMIN_TOKEN_FILE');
  return (await (await import('node:fs/promises')).readFile(file, 'utf8')).trim();
}

async function main(): Promise<void> {
  const base = process.env.HERMESQ_URL;
  if (!base) throw new Error('defina HERMESQ_URL');
  try {
    await get(base, '/health');
  } catch {
    console.log(`hermesQ: /health não responde em ${base}`);
    return;
  }
  let deliveries: Delivery[];
  try {
    const res = await get(base, '/admin/deliveries?limit=50', { authorization: `Bearer ${await adminToken()}` });
    deliveries = ((await res.json()) as { deliveries: Delivery[] }).deliveries;
  } catch {
    console.log('hermesQ: não consegui ler /admin/deliveries');
    return;
  }
  const bad = problems(deliveries);
  if (bad.length) console.log(`hermesQ: entregas com problema: ${bad.slice(0, 5).join('; ')}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
