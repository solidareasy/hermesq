/**
 * Renders `{path.to.field}` placeholders against the event payload.
 * A leading `payload.` is optional (`{payload.pr.number}` == `{pr.number}`); array indexes use dots (`{labels.0.name}`).
 * Missing fields render as an empty string; objects render as JSON.
 */
export function lookup(payload: unknown, path: string): unknown {
  const parts = path.split('.');
  if (parts[0] === 'payload') parts.shift();
  let cur: unknown = payload;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function renderTemplate(template: string, payload: unknown): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_m, path: string) => {
    const v = lookup(payload, path);
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}
