import { createExecutionContext, createScheduledController, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OAuthStore } from '../../src/durable-objects/oauth-store';
import { needsRefresh } from '../../src/durable-objects/oauth-store';
import worker from '../../src/index';
import { decryptString, encryptString, generateKeyMaterial, importAesKey, parseKeyMaterial } from '../../src/oauth/crypto';
import type { OAuthTokens } from '../../src/oauth/providers';
import { oauthStore } from '../../src/secrets';
import { asResponse, OAUTH, type RecordedResponse } from '../fixtures/providers';
import { ADMIN, adminSetSecrets, call, env } from './helpers';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

/** Replaces the global fetch (shared with the Durable Object in this isolate) with recorded provider answers. */
function provider(...answers: RecordedResponse[]) {
  const calls: Captured[] = [];
  const queue = [...answers];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: new URLSearchParams(await req.text()) });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch ${req.url}`);
    return asResponse(next);
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const stub = () => oauthStore(env);
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

async function connect(service: 'linear' | 'slack', tokenAnswer: RecordedResponse) {
  const start = await call('/setup/start', { method: 'POST', headers: ADMIN, body: JSON.stringify({ service }) });
  expect(start.status).toBe(200);
  const url = new URL((await json(start)).authorizeUrl as string);
  const calls = provider(tokenAnswer);
  const cb = await call(`/oauth/callback?code=code-${service}&state=${url.searchParams.get('state')}`);
  return { url, calls, cb };
}

beforeAll(async () => {
  await adminSetSecrets({
    LINEAR_CLIENT_ID: 'lin-client-id',
    LINEAR_CLIENT_SECRET: 'lin-client-secret-value',
    SLACK_CLIENT_ID: 'slack-client-id',
    SLACK_CLIENT_SECRET: 'slack-client-secret-value',
  });
});

describe('AES-GCM helpers', () => {
  it('round-trips, and fails on tampering or a different key', async () => {
    const key = await importAesKey(generateKeyMaterial());
    const sealed = await encryptString(key, 'refresh-token-value');
    expect(sealed).not.toContain('refresh-token-value');
    expect(await decryptString(key, sealed)).toBe('refresh-token-value');
    expect(await encryptString(key, 'x')).not.toBe(await encryptString(key, 'x')); // random IV

    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1]! ^= 1;
    await expect(decryptString(key, btoa(String.fromCharCode(...bytes)))).rejects.toThrow();
    await expect(decryptString(await importAesKey(generateKeyMaterial()), sealed)).rejects.toThrow();
  });

  it('accepts 32-byte keys as hex or base64 only', () => {
    expect(parseKeyMaterial('ab'.repeat(32))).toHaveLength(32);
    expect(parseKeyMaterial(btoa('k'.repeat(32)))).toHaveLength(32);
    expect(() => parseKeyMaterial(btoa('short'))).toThrow(/32 bytes/);
  });
});

describe('refresh window (80% of the lifetime)', () => {
  it('is due once less than 20% of the lifetime is left; tokens without expiry never are', () => {
    const t = { obtained_at: 0, expires_at: 1000 };
    expect(needsRefresh(t, 799)).toBe(false);
    expect(needsRefresh(t, 800)).toBe(true);
    expect(needsRefresh(t, 5000)).toBe(true);
    expect(needsRefresh({ obtained_at: 0, expires_at: 0 }, 10 ** 12)).toBe(false);
  });
});

describe('Linear OAuth flow', () => {
  it('start -> callback stores encrypted tokens and status shows connected', async () => {
    const { url, calls, cb } = await connect('linear', OAUTH.linear.tokenOk);
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'lin-client-id',
      redirect_uri: 'https://transfer.test/oauth/callback',
      response_type: 'code',
      scope: 'read,write',
      prompt: 'consent',
    });
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);

    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('linear is connected');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.linear.app/oauth/token');
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(calls[0]!.body)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-linear',
      redirect_uri: 'https://transfer.test/oauth/callback',
      client_id: 'lin-client-id',
      client_secret: 'lin-client-secret-value',
    });

    expect(await json(await call('/oauth/status', { headers: ADMIN }))).toEqual({ connected: ['linear'] });
    expect((await call('/oauth/status')).status).toBe(401);

    // The state is single use.
    const replay = await call(`/oauth/callback?code=again&state=${url.searchParams.get('state')}`);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('invalid_state');
  });

  it('nothing sensitive is stored in plaintext in the Durable Object', async () => {
    const raw = await runInDurableObject(stub(), async (_i: OAuthStore, state) => {
      const all = await state.storage.list();
      return JSON.stringify([...all.entries()]);
    });
    expect(raw).toContain('tokens:linear');
    expect(raw).not.toContain(OAUTH.linear.tokenOk.body.access_token);
    expect(raw).not.toContain(OAUTH.linear.tokenOk.body.refresh_token);
    expect(raw).not.toContain('lin-client-secret-value');
  });

  it('health reports the expiry from expires_in', async () => {
    const before = Date.now();
    const { services } = (await json(await call('/oauth/health', { headers: ADMIN }))) as { services: Record<string, unknown>[] };
    const lin = services.find((s) => s.service === 'linear')!;
    expect(lin).toMatchObject({ connected: true, needs_refresh: false, needs_reconnect: false, last_refresh_error: null });
    expect(lin.expires_at as number).toBeGreaterThan(before + 86_000_000);
    expect(lin.expires_at as number).toBeLessThanOrEqual(Date.now() + 86_399_000);
  });

  it('forced refresh rotates the refresh token: the next refresh sends the new one', async () => {
    const rotated1 = { ...OAUTH.linear.tokenOk, body: { ...OAUTH.linear.tokenOk.body, access_token: 'access-2', refresh_token: 'rotated-1' } };
    const rotated2 = { ...OAUTH.linear.tokenOk, body: { ...OAUTH.linear.tokenOk.body, access_token: 'access-3', refresh_token: 'rotated-2' } };
    const calls = provider(rotated1, rotated2);
    expect((await call('/oauth/refresh?service=linear', { method: 'POST', headers: ADMIN })).status).toBe(200);
    expect((await call('/oauth/refresh?service=linear', { method: 'POST', headers: ADMIN })).status).toBe(200);
    expect(calls.map((c) => Object.fromEntries(c.body))).toEqual([
      { grant_type: 'refresh_token', refresh_token: OAUTH.linear.tokenOk.body.refresh_token, client_id: 'lin-client-id', client_secret: 'lin-client-secret-value' },
      { grant_type: 'refresh_token', refresh_token: 'rotated-1', client_id: 'lin-client-id', client_secret: 'lin-client-secret-value' },
    ]);
    expect(await stub().getAccessToken('linear')).toBe('access-3');
  });

  it('concurrent refreshes share one token request (refresh tokens are single use)', async () => {
    const calls = provider(OAUTH.linear.tokenOk);
    const [a, b] = await Promise.all([stub().refresh('linear'), stub().refresh('linear')]);
    expect(calls).toHaveLength(1);
    expect(a.last_refresh_error).toBeNull();
    expect(b.last_refresh_error).toBeNull();
  });

  it('an expired token shows needs_refresh and the hourly cron refreshes it', async () => {
    await runInDurableObject(stub(), async (instance: OAuthStore, state) => {
      const sealed = await (instance as unknown as { seal(v: unknown): Promise<string> }).seal({
        access_token: 'stale',
        refresh_token: 'rt-before-cron',
        expires_at: Date.now() - 1000,
        obtained_at: Date.now() - 86_400_000,
        scope: 'read write',
        token_type: 'Bearer',
      } satisfies OAuthTokens);
      await state.storage.put('tokens:linear', sealed);
    });
    let { services } = (await json(await call('/oauth/health', { headers: ADMIN }))) as { services: Record<string, unknown>[] };
    expect(services.find((s) => s.service === 'linear')).toMatchObject({ needs_refresh: true });

    const calls = provider(OAUTH.linear.tokenOk);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '0 * * * *', scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.get('refresh_token')).toBe('rt-before-cron');

    ({ services } = (await json(await call('/oauth/health', { headers: ADMIN }))) as { services: Record<string, unknown>[] });
    const lin = services.find((s) => s.service === 'linear')!;
    expect(lin).toMatchObject({ needs_refresh: false, last_refresh_error: null });
    expect(lin.expires_at as number).toBeGreaterThan(Date.now() + 86_000_000);
  });

  it('a cron run with nothing due makes no provider call', async () => {
    const calls = provider();
    const res = await stub().refreshAllIfNeeded(Date.now());
    expect(res).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('refresh rejected with the real invalid_client answer records the error but keeps the connection', async () => {
    provider(OAUTH.linear.invalidClient);
    const res = await call('/oauth/refresh?service=linear', { method: 'POST', headers: ADMIN });
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ last_refresh_error: 'invalid_client', needs_reconnect: false, connected: true });
  });

  it('reconnect clears the tokens and a new authorization reconnects the service', async () => {
    const res = await call('/oauth/reconnect?service=linear', { method: 'POST', headers: ADMIN });
    expect(res.status).toBe(200);
    const url = new URL((await json(res)).authorizeUrl as string);
    expect(url.hostname).toBe('linear.app');
    expect(await json(await call('/oauth/status', { headers: ADMIN }))).toEqual({ connected: [] });

    provider(OAUTH.linear.tokenOk);
    const cb = await call(`/oauth/callback?code=new-code&state=${url.searchParams.get('state')}`);
    expect(cb.status).toBe(200);
    expect(await json(await call('/oauth/status', { headers: ADMIN }))).toEqual({ connected: ['linear'] });
  });

  it('a state older than 10 minutes is refused', async () => {
    const started = await stub().startAuth('linear', 'https://transfer.test/oauth/callback', Date.now());
    if (!started.ok) throw new Error(started.error);
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    expect(await stub().completeAuth(state, 'c', Date.now() + 10 * 60_000 + 1)).toEqual({ ok: false, error: 'expired_state' });
  });

  it('disconnect revokes with the token form field only (Linear rejects it combined with legacy auth) and drops the tokens', async () => {
    const calls = provider({ status: 200, source: 'linear revoke 200 (documented)', body: {} });
    const res = await call('/oauth/disconnect?service=linear', { method: 'POST', headers: ADMIN });
    expect(await json(res)).toEqual({ disconnected: true, revoked: true });
    expect(calls[0]!.url).toBe('https://api.linear.app/oauth/revoke');
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(Object.fromEntries(calls[0]!.body)).toEqual({ token: OAUTH.linear.tokenOk.body.access_token, token_type_hint: 'access_token' });
    expect(await json(await call('/oauth/status', { headers: ADMIN }))).toEqual({ connected: [] });
  });
});

describe('Slack OAuth flow', () => {
  it('the real invalid_code answer (HTTP 200, ok:false) fails the callback', async () => {
    const { cb } = await connect('slack', OAUTH.slack.invalidCode);
    expect(cb.status).toBe(400);
    expect(await cb.text()).toContain('invalid_code');
    expect(await json(await call('/oauth/status', { headers: ADMIN }))).toEqual({ connected: [] });
  });

  it('connects with token rotation and keeps the team id', async () => {
    const { url, cb } = await connect('slack', OAUTH.slack.tokenOk);
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('scope')).toBe('app_mentions:read,chat:write');
    expect(cb.status).toBe(200);
    const tokens = await runInDurableObject(stub(), async (instance: OAuthStore) =>
      (instance as unknown as { tokens(s: string): Promise<OAuthTokens> }).tokens('slack'),
    );
    expect(tokens).toMatchObject({ access_token: 'xoxe.xoxb-1-fixture', refresh_token: 'xoxe-1-fixture', team_id: 'T9TK3CUKW' });
  });

  it('the real invalid_refresh_token answer marks the service for reconnection', async () => {
    provider(OAUTH.slack.invalidRefreshToken);
    const res = await call('/oauth/refresh?service=slack', { method: 'POST', headers: ADMIN });
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ last_refresh_error: 'invalid_refresh_token', needs_reconnect: true });
  });

  it('disconnect calls auth.revoke with the bearer token; a rejected revoke still disconnects', async () => {
    const calls = provider(OAUTH.slack.revokeInvalidAuth);
    const res = await call('/oauth/disconnect?service=slack', { method: 'POST', headers: ADMIN });
    expect(await json(res)).toEqual({ disconnected: true, revoked: false });
    expect(calls[0]).toMatchObject({ url: 'https://slack.com/api/auth.revoke', method: 'POST' });
    expect(calls[0]!.headers.authorization).toBe('Bearer xoxe.xoxb-1-fixture');
  });

  it('refresh of a service that is not connected is a 404; unknown services are a 400', async () => {
    expect((await call('/oauth/refresh?service=slack', { method: 'POST', headers: ADMIN })).status).toBe(404);
    expect((await call('/oauth/refresh?service=discord', { method: 'POST', headers: ADMIN })).status).toBe(400);
  });
});

describe('/setup wizard API', () => {
  it('serves the page with a strict CSP and reports where each secret comes from', async () => {
    const page = await call('/setup');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('hermesQ');

    const state = await json(await call('/setup/state', { headers: ADMIN }));
    const sources = Object.fromEntries((state.secrets as { name: string; source: string | null }[]).map((s) => [s.name, s.source]));
    expect(sources).toMatchObject({ GITHUB_WEBHOOK_SECRET: 'worker-secret', LINEAR_CLIENT_ID: 'setup' });
    expect(state.urls).toMatchObject({ linear: 'https://transfer.test/linear', oauthCallback: 'https://transfer.test/oauth/callback' });
    expect(state.encryptionKey).toBe('generated');
  });

  it('generates the Hermes secret once and only that one; unknown names are refused', async () => {
    const gen = await json(await call('/setup/generate', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'HERMES_WEBHOOK_SECRET' }) }));
    expect(gen.value).toMatch(/^[0-9a-f]{64}$/);
    expect(await stub().getSecret('HERMES_WEBHOOK_SECRET')).toBe(gen.value);
    expect((await call('/setup/generate', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'LINEAR_CLIENT_SECRET' }) })).status).toBe(400);
    expect((await call('/setup/secrets', { method: 'POST', headers: ADMIN, body: JSON.stringify({ NOT_A_SECRET: 'x' }) })).status).toBe(400);
  });
});
