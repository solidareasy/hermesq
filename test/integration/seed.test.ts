import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { DEFAULT_SUBSCRIPTIONS } from '../../src/subscriptions/defaults.ts';

const URL_ = inject('workerUrl');
const VARS = inject('vars');

function seed(...args: string[]) {
  return spawnSync('npx', ['tsx', 'scripts/seed_subscriptions.ts', '--url', URL_, ...args], { encoding: 'utf8', env: { ...process.env, ADMIN_TOKEN: VARS.ADMIN_TOKEN! } });
}
async function names() {
  const res = await fetch(`${URL_}/admin/subscriptions`, { headers: { authorization: `Bearer ${VARS.ADMIN_TOKEN}` } });
  return ((await res.json()) as { subscriptions: { name: string }[] }).subscriptions.map((s) => s.name);
}

describe('scripts/seed_subscriptions.ts against wrangler dev', () => {
  it('replaces the list from a file, rejects an invalid one, and restores the defaults', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wt-seed-'));
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify([{ name: 'only-mentions', events: ['app_mention'], prompt: '{event.text}', deliver: 'slack', deliverChatId: 'C1' }]));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify([{ name: 'no events' }]));

    const r1 = seed('--file', good);
    expect(r1.status, r1.stderr).toBe(0);
    expect(await names()).toEqual(['only-mentions']);

    const r2 = seed('--file', bad);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('invalid_subscriptions');
    expect(await names()).toEqual(['only-mentions']);

    const r3 = seed('--defaults');
    expect(r3.status, r3.stderr).toBe(0);
    expect(await names()).toEqual(DEFAULT_SUBSCRIPTIONS.map((s) => s.name));
  });
});
