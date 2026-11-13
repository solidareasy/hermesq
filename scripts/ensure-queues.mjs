#!/usr/bin/env node
// Creates the Cloudflare Queues named in wrangler.jsonc for one environment if they do not exist yet.
// `wrangler deploy` provisions KV and D1 by itself but stops with "Queue X does not exist" for queues.
// Usage (needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID): node scripts/ensure-queues.mjs [staging|production]
//        node scripts/ensure-queues.mjs --list <env>   (print the names only; no API call)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function queueNames(config, env) {
  const block = env && env !== 'production' ? config.env?.[env] : config;
  if (!block) throw new Error(`environment "${env}" not found in wrangler.jsonc`);
  const q = block.queues ?? {};
  return [...new Set([...(q.producers ?? []).map((p) => p.queue), ...(q.consumers ?? []).map((c) => c.queue)])];
}

/** wrangler.jsonc -> object (drops // and /* *\/ comments outside strings, then trailing commas). */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const wrangler = (...args) => spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8' });

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const listOnly = args[0] === '--list';
  const env = (listOnly ? args[1] : args[0]) ?? 'production';
  const names = queueNames(parseJsonc(readFileSync('wrangler.jsonc', 'utf8')), env);
  if (listOnly) {
    console.log(names.join('\n'));
    process.exit(0);
  }
  let failed = 0;
  for (const name of names) {
    if (wrangler('queues', 'info', name).status === 0) {
      console.log(`exists   ${name}`);
      continue;
    }
    const created = wrangler('queues', 'create', name);
    if (created.status === 0) console.log(`created  ${name}`);
    else {
      failed++;
      console.error(`FAILED   ${name}\n${created.stderr || created.stdout}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
