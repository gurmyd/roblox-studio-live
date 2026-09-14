import { CAPABILITIES, type Capability, type ProbeIds, type ProbeRequest } from './capabilities.js';
import { CloudError } from './errors.js';
import type { HttpClient } from './http.js';
import type { ActionOutcome, CloudContext } from './types.js';

/**
 * The capability probe behind `info what:"key"`.
 *
 * Open Cloud has no endpoint that describes an API key, so before this existed an agent could
 * only discover a missing scope by attempting the real call and reading the 403 — one wasted
 * round trip per unknown scope, and no way to plan a multi-step job up front. The probe asks
 * instead: it fires the harmless read registered for each capability and classifies the status.
 *
 * Roblox authorizes before it resolves the resource, so for a probe aimed at a name that cannot
 * exist a 403 means "scope missing" and a 404 means "scope present, nothing there" — which is
 * exactly the signal we want. Statuses that say nothing about permission (429, 5xx, a network
 * failure) are reported `unknown` rather than guessed.
 */
export type ProbeStatus = 'allowed' | 'denied' | 'unknown';

/** How many probes are in flight at once. Small enough not to trip the per-key rate limit. */
const PROBE_CONCURRENCY = 4;

export interface ProbeOutcome {
  id: string;
  calls: string;
  status: ProbeStatus;
  permissions: string[];
  http?: number;
  note?: string;
}

/** Status → verdict. Anything that got past authorization counts as allowed, 404 included. */
export function classify(status: number): { status: ProbeStatus; note?: string } {
  if (status >= 200 && status < 300) return { status: 'allowed' };
  // Authorization is checked before the resource is resolved, so "not found" proves the scope is present.
  if (status === 404) return { status: 'allowed', note: 'nothing at the probed name, which only a permitted call can learn' };
  // The request reached the handler and was rejected on its arguments, so the scope is present.
  if (status === 400) return { status: 'allowed', note: 'the probe arguments were rejected (400), which only a permitted call reaches' };
  if (status === 403) return { status: 'denied' };
  if (status === 401) return { status: 'denied', note: 'the key was rejected outright (401) — it may be mistyped, expired, revoked, IP-limited, or the wrong key type for this endpoint' };
  if (status === 429) return { status: 'unknown', note: 'rate limited (429) before the probe could settle it; try again in a minute' };
  if (status >= 500) return { status: 'unknown', note: `Open Cloud answered ${status}; this says nothing about the key` };
  return { status: 'unknown', note: `unexpected status ${status}` };
}

async function probeOne(capability: Capability, request: ProbeRequest, http: HttpClient): Promise<ProbeOutcome> {
  const base = { id: capability.id, calls: capability.calls, permissions: capability.permissions };
  try {
    // One request per capability, never retried: across a dozen capabilities the usual
    // 429/5xx retries would multiply the probe fourfold and hammer an already-limited key.
    // `unknown` is a good enough answer for a probe that could not settle.
    const res = await http.request({ ...request, idempotent: false, noRetry: true });
    const verdict = classify(res.status);
    return { ...base, status: verdict.status, http: res.status, ...(verdict.note ? { note: verdict.note } : {}) };
  } catch (err) {
    if (err instanceof CloudError) {
      if (err.status !== undefined) {
        const verdict = classify(err.status);
        return { ...base, status: verdict.status, http: err.status, ...(verdict.note ? { note: verdict.note } : {}) };
      }
      return { ...base, status: 'unknown', note: `${err.code}: ${err.message}` };
    }
    return { ...base, status: 'unknown', note: err instanceof Error ? err.message : String(err) };
  }
}

/** Runs `tasks` with a bounded number in flight, preserving input order. */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = next++;
      const task = tasks[index];
      if (!task) return;
      out[index] = await task();
    }
  });
  await Promise.all(workers);
  return out;
}

export interface ProbeArgs {
  deep?: boolean | undefined;
  universe_id?: number | undefined;
  place_id?: number | undefined;
}

/**
 * Probes the configured key and reports, per capability, allowed | denied | unknown.
 * Read probes run always; `deep` adds the ones that need a DELETE against a reserved
 * name (harmless, but a write, so an agent has to ask for it).
 */
export async function probeKey(a: ProbeArgs, ctx: CloudContext, http: HttpClient, keySource: string | undefined): Promise<ActionOutcome> {
  const session = ctx.ids();
  const ids: ProbeIds = {
    universeId: a.universe_id ?? session?.universeId,
    placeId: a.place_id ?? session?.placeId,
    creatorType: session?.creatorType,
    creatorId: session?.creatorId,
  };
  const deep = a.deep === true;

  const planned: Array<{ capability: Capability; request: ProbeRequest | null }> = CAPABILITIES.map((capability) => ({
    capability,
    request: capability.kind === 'none' || (capability.kind === 'reversible' && !deep) ? null : (capability.request?.(ids) ?? null),
  }));

  const runnable = planned.filter((p): p is { capability: Capability; request: ProbeRequest } => p.request !== null);
  const probed = await pool(
    runnable.map(({ capability, request }) => () => probeOne(capability, request, http)),
    PROBE_CONCURRENCY,
  );
  const byId = new Map(probed.map((p) => [p.id, p]));

  const capabilities: ProbeOutcome[] = planned.map(({ capability }) => {
    const done = byId.get(capability.id);
    if (done) return done;
    const base = { id: capability.id, calls: capability.calls, status: 'unknown' as const, permissions: capability.permissions };
    if (capability.kind === 'none') return { ...base, note: `not probeable: ${capability.because ?? 'the only way to settle it is a real write'}` };
    if (capability.kind === 'reversible') return { ...base, note: 'settled only by a harmless probe delete; re-run with deep: true' };
    return { ...base, note: 'the ids this probe needs are not known (open the place in Studio, or pass universe_id / place_id)' };
  });

  const pick = (status: ProbeStatus): string[] => capabilities.filter((c) => c.status === status).map((c) => c.id);
  const allowed = pick('allowed');
  const denied = pick('denied');
  const unknown = pick('unknown');
  // Every probe answering 401 means the key itself is bad, not that a dozen scopes are missing.
  const allRejected = probed.length > 0 && probed.every((p) => p.http === 401);

  return {
    value: {
      what: 'key',
      key_source: keySource ?? 'unknown',
      ...(ids.universeId ? { universe_id: ids.universeId } : {}),
      ...(ids.placeId ? { place_id: ids.placeId } : {}),
      ...(ids.creatorType && ids.creatorId ? { creator: { type: ids.creatorType, id: ids.creatorId } } : {}),
      deep,
      allowed,
      denied,
      unknown,
      capabilities,
      summary: allRejected
        ? 'Every probe answered 401: the key itself was rejected (mistyped, expired, revoked, or IP-limited), so nothing could be measured.'
        : `${allowed.length} allowed, ${denied.length} denied, ${unknown.length} unknown of ${capabilities.length} capabilities.`,
      note: [
        'Open Cloud has no endpoint that describes a key, so this is measured by probing: a 403 means the scope is missing, a 404 means the scope is present and the probed name simply does not exist.',
        denied.length > 0 ? 'Add a denied capability in Creator Hub (create.roblox.com/dashboard/credentials → your key → Access Permissions) using the permissions listed against it.' : '',
        !deep ? 'deep: true additionally probes writes that a delete against a reserved name can settle (nothing real is deleted).' : '',
      ]
        .filter((line) => line !== '')
        .join(' '),
    },
  };
}
