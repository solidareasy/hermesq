import type { Env, StorableSecret } from './types';

const CACHE_MS = 30_000;
const cache = new Map<string, { value: string | null; at: number }>();

export function oauthStore(env: Env) {
  return env.OAUTH_STORE.get(env.OAUTH_STORE.idFromName('global'));
}

export function clearSecretCache(): void {
  cache.clear();
}

/** A Worker secret wins; otherwise the value typed into /setup (encrypted in the Durable Object). */
export async function resolveSecret(env: Env, name: StorableSecret): Promise<string | null> {
  const fromEnv = env[name];
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await oauthStore(env).getSecret(name);
  cache.set(name, { value, at: Date.now() });
  return value;
}
