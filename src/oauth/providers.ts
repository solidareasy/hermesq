import type { Env, OAuthService, StorableSecret } from '../types';

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  /** Unix ms; 0 = the provider did not set an expiry. */
  expires_at: number;
  /** Unix ms when this access token was issued (for the 80% TTL rule). */
  obtained_at: number;
  scope: string;
  token_type: 'Bearer';
  team_id?: string;
  workspace_id?: string;
}

export interface ProviderConfig {
  service: OAuthService;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  scopes: string;
  clientIdName: StorableSecret;
  clientSecretName: StorableSecret;
  /** Extra query params for the authorize URL. */
  authorizeParams: Record<string, string>;
  /** Slack answers errors with HTTP 200 and `{ ok: false }`. */
  okFlag: boolean;
  /** How the revoke call carries the token. */
  revokeStyle: 'form-token' | 'bearer';
}

export type TokenParse = { ok: true; tokens: OAuthTokens } | { ok: false; error: string; description?: string };

type Overrides = Partial<Record<OAuthService, Partial<Pick<ProviderConfig, 'authorizeUrl' | 'tokenUrl' | 'revokeUrl'>>>>;

function overrides(env: Env): Overrides {
  if (!env.OAUTH_PROVIDER_OVERRIDES) return {};
  try {
    return JSON.parse(env.OAUTH_PROVIDER_OVERRIDES) as Overrides;
  } catch {
    return {};
  }
}

export function providerConfig(service: OAuthService, env: Env): ProviderConfig {
  const o = overrides(env)[service] ?? {};
  if (service === 'linear') {
    const params: Record<string, string> = { response_type: 'code', prompt: 'consent' };
    if (env.LINEAR_OAUTH_ACTOR) params.actor = env.LINEAR_OAUTH_ACTOR;
    return {
      service,
      authorizeUrl: o.authorizeUrl ?? 'https://linear.app/oauth/authorize',
      tokenUrl: o.tokenUrl ?? 'https://api.linear.app/oauth/token',
      revokeUrl: o.revokeUrl ?? 'https://api.linear.app/oauth/revoke',
      scopes: env.LINEAR_OAUTH_SCOPES || 'read,write',
      clientIdName: 'LINEAR_CLIENT_ID',
      clientSecretName: 'LINEAR_CLIENT_SECRET',
      authorizeParams: params,
      okFlag: false,
      revokeStyle: 'form-token',
    };
  }
  return {
    service,
    authorizeUrl: o.authorizeUrl ?? 'https://slack.com/oauth/v2/authorize',
    tokenUrl: o.tokenUrl ?? 'https://slack.com/api/oauth.v2.access',
    revokeUrl: o.revokeUrl ?? 'https://slack.com/api/auth.revoke',
    scopes: env.SLACK_OAUTH_SCOPES || 'app_mentions:read,chat:write',
    clientIdName: 'SLACK_CLIENT_ID',
    clientSecretName: 'SLACK_CLIENT_SECRET',
    authorizeParams: {},
    okFlag: true,
    revokeStyle: 'bearer',
  };
}

/** Parses a token endpoint answer (authorization_code or refresh_token grant). */
export async function parseTokenResponse(cfg: ProviderConfig, res: Response, now: number): Promise<TokenParse> {
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== 'object') return { ok: false, error: `invalid_response_http_${res.status}` };
  if (cfg.okFlag ? json.ok !== true : !res.ok || typeof json.error === 'string') {
    const error = typeof json.error === 'string' ? json.error : `http_${res.status}`;
    const description = typeof json.error_description === 'string' ? json.error_description : undefined;
    return description ? { ok: false, error, description } : { ok: false, error };
  }
  if (typeof json.access_token !== 'string' || json.access_token === '') return { ok: false, error: 'missing_access_token' };
  // Linear apps created before Dec 2023 return scope as an array.
  const scope = Array.isArray(json.scope) ? json.scope.join(' ') : typeof json.scope === 'string' ? json.scope : '';
  const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 0;
  const tokens: OAuthTokens = {
    access_token: json.access_token,
    expires_at: expiresIn ? now + expiresIn * 1000 : 0,
    obtained_at: now,
    scope,
    token_type: 'Bearer',
  };
  if (typeof json.refresh_token === 'string' && json.refresh_token) tokens.refresh_token = json.refresh_token;
  const team = json.team as { id?: unknown } | null | undefined;
  if (team && typeof team.id === 'string') tokens.team_id = team.id;
  return { ok: true, tokens };
}

/** Refresh-token errors that mean the grant is gone and only a new OAuth flow fixes it. */
export const RECONNECT_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_revoked', 'token_expired', 'no_refresh_token', 'invalid_code']);
