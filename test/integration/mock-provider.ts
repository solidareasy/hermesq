import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { OAUTH } from '../fixtures/providers.ts';

/**
 * A small OAuth 2.0 provider shaped like Linear's (authorize -> code -> token, refresh_token rotation,
 * revoke). Answers use the recorded fixture bodies; `/__control` lets a test set the next token lifetime
 * and read every call the Worker made.
 */
export interface ProviderCall {
  path: string;
  form: Record<string, string>;
  authorization?: string;
}

export function startMockProvider(port: number): Promise<Server> {
  const clientId = 'it-client-id';
  const clientSecret = 'it-client-secret';
  const codes = new Map<string, string>(); // code -> redirect_uri
  let refreshToken: string | null = null;
  let accessToken: string | null = null;
  let nextExpiresIn = 86399;
  const calls: ProviderCall[] = [];

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(raw));
    });
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };
  const issue = () => {
    accessToken = `it-access-${randomBytes(6).toString('hex')}`;
    refreshToken = `it-refresh-${randomBytes(6).toString('hex')}`;
    return { ...OAUTH.linear.tokenOk.body, access_token: accessToken, refresh_token: refreshToken, expires_in: nextExpiresIn };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/__control') {
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { expiresIn?: number; reset?: boolean };
        if (body.expiresIn !== undefined) nextExpiresIn = body.expiresIn;
        if (body.reset) calls.length = 0;
      }
      return send(res, 200, { calls, refreshToken, accessToken });
    }
    if (url.pathname === '/linear/authorize') {
      // The user "approves": redirect back with a fresh code and the same state.
      if (url.searchParams.get('client_id') !== clientId) return send(res, 400, { error: 'invalid_client' });
      const code = randomBytes(8).toString('hex');
      const redirect = url.searchParams.get('redirect_uri')!;
      codes.set(code, redirect);
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    calls.push({ path: url.pathname, form, authorization: req.headers.authorization });
    if (url.pathname === '/linear/token') {
      if (form.client_id !== clientId || form.client_secret !== clientSecret) return send(res, OAUTH.linear.invalidClient.status, OAUTH.linear.invalidClient.body);
      if (form.grant_type === 'authorization_code') {
        if (!form.code || codes.get(form.code) !== form.redirect_uri) return send(res, 400, { error: 'invalid_grant', error_description: 'code' });
        codes.delete(form.code);
        return send(res, 200, issue());
      }
      if (form.grant_type === 'refresh_token') {
        if (!refreshToken || form.refresh_token !== refreshToken) return send(res, 400, { error: 'invalid_grant', error_description: 'refresh token' });
        return send(res, 200, issue()); // rotation: the old refresh token stops working
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/linear/revoke') {
      if (form.token && form.token === accessToken) {
        accessToken = refreshToken = null;
        return send(res, 200, {});
      }
      return send(res, OAUTH.linear.revokeUnknownToken.status, OAUTH.linear.revokeUnknownToken.body);
    }
    return send(res, 404, { error: 'not_found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export const MOCK_CLIENT = { id: 'it-client-id', secret: 'it-client-secret' };
