import { describe, expect, it } from 'vitest';
import { call } from './helpers';

describe('GET /health', () => {
  it('answers ok with the service name and security headers', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'hermesq' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('unknown route is a JSON 404', async () => {
    const res = await call('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
