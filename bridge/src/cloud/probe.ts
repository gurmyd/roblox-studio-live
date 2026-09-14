import { CAPABILITIES, type Capability, type ProbeIds, type ProbeRequest } from './capabilities.js';
import { CloudError } from './errors.js';
import type { HttpClient } from './http.js';
import { asObject } from './shared.js';
import type { ActionOutcome, CloudContext } from './types.js';

/**
 * The capability report behind `info what:"key"`: what this API key may do, per capability.
 *
 * First choice: Roblox's key introspection endpoint, POST /api-keys/v1/introspect (shipped
 * 2026-01-27; https://create.roblox.com/docs/cloud/auth/api-keys). It returns the key's own scope
 * list — with the universes and creators each scope is bound to — so every capability, writes
 * included, is judged without calling anything. It is not in Roblox's openapi.json, and it takes
 * the key in the request BODY rather than the x-api-key header; http.ts handles that
 * (`keyInBody`) so the key still never reaches a result or a log line.
 *
 * Fallback, when introspection is unavailable: trial requests. Roblox authorizes a leaf resource
 * before resolving it, so a probe aimed at a reserved name reads 403 as "scope missing" and 404
 * as "scope present". Weaker, for reasons the result states: writes cannot be tried harmlessly,
 * and a universe the key is not bound to answers 403 to everything.
 */
export type ProbeStatus = 'allowed' | 'denied' | 'unknown';

export const INTROSPECT_PATH = '/api-keys/v1/introspect';
/** How many fallback probes are in flight at once. Small enough not to trip the per-key rate limit. */
const PROBE_CONCURRENCY = 4;
/** Held scope names are listed in the report; a key with hundreds is still readable at this cap. */
const MAX_SCOPES_LISTED = 100;

export interface ProbeOutcome {
  id: string;
  calls: string;
  status: ProbeStatus;
  permissions: string[];
  http?: number;
  note?: string;
}

// ---------------------------------------------------------------------------
// introspection
// ---------------------------------------------------------------------------

export interface KeyScope {
  name: string;
  operations: string[];
  /** Resource ids are strings ("123", or the "*" wildcard); a key is absent when the scope has no such binding. */
  universeIds?: string[] | undefined;
  userIds?: string[] | undefined;
  groupIds?: string[] | undefined;
  universeDatastores?: Array<{ universeId?: string | undefined; datastoreName?: string | undefined }> | undefined;
}

export interface Introspection {
  name?: string | undefined;
  ownerUserId?: number | undefined;
  enabled: boolean;
  expired: boolean;
  expires?: string | undefined;
  scopes: KeyScope[];
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((v) => String(v)) : undefined;
}

/** Reads the introspection body defensively; null when it is not an introspection at all. */
export function parseIntrospection(body: unknown): Introspection | null {
  const record = asObject(body);
  if (!Array.isArray(record.scopes)) return null;
  const scopes: KeyScope[] = [];
  for (const raw of record.scopes) {
    const s = asObject(raw);
    if (typeof s.name !== 'string') continue;
    scopes.push({
      name: s.name,
      operations: Array.isArray(s.operations) ? s.operations.map((op) => String(op)) : [],
      universeIds: stringList(s.universeIds),
      userIds: stringList(s.userIds),
      groupIds: stringList(s.groupIds),
      universeDatastores: Array.isArray(s.universeDatastores)
        ? s.universeDatastores.map((d) => {
            const o = asObject(d);
            return {
              universeId: o.universeId !== undefined && o.universeId !== null ? String(o.universeId) : undefined,
              datastoreName: typeof o.datastoreName === 'string' ? o.datastoreName : undefined,
            };
          })
        : undefined,
    });
  }
  // The docs example spells it expirationTimeUtc; Roblox's launch post and a production client read
  // expirationUtcTime. Take whichever arrives.
  const expires = typeof record.expirationTimeUtc === 'string' ? record.expirationTimeUtc : typeof record.expirationUtcTime === 'string' ? record.expirationUtcTime : undefined;
  const owner = record.authorizedUserId;
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    ownerUserId: typeof owner === 'number' ? owner : typeof owner === 'string' && /^\d+$/.test(owner) ? Number(owner) : undefined,
    enabled: record.enabled !== false,
    expired: record.expired === true,
    expires,
    scopes,
  };
}

/** "scope-name:operation" → every held scope object granting it. */
function heldIndex(scopes: KeyScope[]): Map<string, KeyScope[]> {
  const out = new Map<string, KeyScope[]>();
  for (const scope of scopes) {
    for (const op of scope.operations) {
      const key = `${scope.name}:${op}`;
      const list = out.get(key) ?? [];
      list.push(scope);
      out.set(key, list);
    }
  }
  return out;
}

/** Whether a held scope covers the resource this call touches — this universe, or this creator. */
function coverage(scope: KeyScope, capability: Capability, ids: ProbeIds): { covers: boolean; limited?: string } {
  if (capability.binding === 'universe') {
    if (!ids.universeId) return { covers: true };
    const universe = String(ids.universeId);
    if (scope.universeIds) return { covers: scope.universeIds.includes('*') || scope.universeIds.includes(universe) };
    if (scope.universeDatastores) {
      const here = scope.universeDatastores.filter((d) => d.universeId === '*' || d.universeId === universe);
      if (here.length === 0) return { covers: false };
      // A data store scope can be narrowed to named stores; say so rather than implying all of them.
      const everyStore = here.some((d) => d.datastoreName === undefined || d.datastoreName === '*');
      const names = here.map((d) => d.datastoreName).filter((n): n is string => typeof n === 'string' && n !== '*');
      return everyStore || names.length === 0 ? { covers: true } : { covers: true, limited: `only the data stores ${names.join(', ')}` };
    }
    return { covers: true };
  }
  if (capability.binding === 'creator') {
    if (!ids.creatorType || !ids.creatorId) return { covers: true };
    const id = String(ids.creatorId);
    const mine = ids.creatorType === 'User' ? scope.userIds : scope.groupIds;
    const other = ids.creatorType === 'User' ? scope.groupIds : scope.userIds;
    if (mine) return { covers: mine.includes('*') || mine.includes(id) };
    // Bound to the other kind of creator only — it does not reach this one.
    if (other) return { covers: false };
    return { covers: true };
  }
  return { covers: true };
}

function where(capability: Capability, ids: ProbeIds): string {
  if (capability.binding === 'universe') return `universe ${ids.universeId}`;
  return `this ${ids.creatorType === 'Group' ? 'group' : 'user'} (${ids.creatorId})`;
}

/** Judges one capability against the introspected scope list. */
export function judge(capability: Capability, index: Map<string, KeyScope[]>, ids: ProbeIds, key: Introspection): ProbeOutcome {
  const base = { id: capability.id, calls: capability.calls, permissions: capability.permissions };
  if (!key.enabled) return { ...base, status: 'denied', note: 'the key is disabled' };
  if (key.expired) return { ...base, status: 'denied', note: `the key expired${key.expires ? ` at ${key.expires}` : ''}` };

  const notes: string[] = [];
  for (const alternatives of capability.requires) {
    let satisfied = false;
    let heldElsewhere: string | undefined;
    for (const scopeName of alternatives) {
      for (const scope of index.get(scopeName) ?? []) {
        const c = coverage(scope, capability, ids);
        if (c.covers) {
          satisfied = true;
          if (c.limited) notes.push(`${scopeName}: ${c.limited}`);
          break;
        }
        heldElsewhere = scopeName;
      }
      if (satisfied) break;
    }
    if (satisfied) continue;
    if (heldElsewhere) {
      return { ...base, status: 'denied', note: `the key holds ${heldElsewhere}, but not for ${where(capability, ids)} — add it under the key's Access Permissions` };
    }
    // Roblox has shipped several spellings for some scope families; one the table does not know
    // is not proof of absence, so it is reported rather than called denied.
    const family = capability.family;
    if (family) {
      const unrecognised = [...index.keys()].filter((held) => family.some((f) => held.includes(f)));
      if (unrecognised.length > 0) {
        return { ...base, status: 'unknown', note: `the key holds ${unrecognised.join(', ')} — a spelling of this scope family the tool does not recognise, so it cannot say whether that covers ${alternatives[0]}` };
      }
    }
    return { ...base, status: 'denied', note: `missing ${alternatives[0]}` };
  }

  if (capability.userKeyOnly) {
    return {
      ...base,
      status: 'unknown',
      note: `${capability.requires.length === 0 ? 'needs no scope' : 'the key holds the scope'}, but Roblox answers 401 here to a group-owned key whatever its permissions, and introspection does not say who owns the key — only the call itself can tell`,
    };
  }
  if (capability.binding === 'universe' && !ids.universeId && capability.requires.length > 0) {
    notes.push('universe binding not checked: no universe is known (open the place in Studio, or pass universe_id)');
  }
  return { ...base, status: 'allowed', ...(notes.length > 0 ? { note: notes.join('; ') } : {}) };
}

async function introspect(http: HttpClient): Promise<{ ok: true; key: Introspection } | { ok: false; reason: string }> {
  try {
    // POST /api-keys/v1/introspect  body {"apiKey": "<key>"} — no x-api-key header, per the documented sample.
    const res = await http.request({ method: 'POST', path: INTROSPECT_PATH, keyInBody: 'apiKey', noRetry: true });
    const key = parseIntrospection(res.body);
    return key ? { ok: true, key } : { ok: false, reason: 'the introspection endpoint answered, but without a scopes list' };
  } catch (err) {
    if (err instanceof CloudError) return { ok: false, reason: `${err.code}${err.status !== undefined ? ` (${err.status})` : ''}` };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// fallback: trial requests
// ---------------------------------------------------------------------------

/** Status → verdict. Anything that got past authorization counts as allowed, 404 included. */
export function classify(status: number): { status: ProbeStatus; note?: string } {
  if (status >= 200 && status < 300) return { status: 'allowed' };
  // Authorization is checked before a leaf resource is resolved, so "not found" proves the scope is present.
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

async function probeByRequests(ids: ProbeIds, http: HttpClient, deep: boolean): Promise<{ capabilities: ProbeOutcome[]; probed: ProbeOutcome[] }> {
  const planned = CAPABILITIES.map((capability) => ({
    capability,
    request: capability.kind === 'none' || (capability.kind === 'reversible' && !deep) ? null : (capability.request?.(ids) ?? null),
  }));
  const runnable = planned.filter((p): p is { capability: Capability; request: ProbeRequest } => p.request !== null);
  const probed = await pool(
    runnable.map(({ capability, request }) => () => probeOne(capability, request, http)),
    PROBE_CONCURRENCY,
  );
  const byId = new Map(probed.map((p) => [p.id, p]));
  const capabilities = planned.map(({ capability }): ProbeOutcome => {
    const done = byId.get(capability.id);
    if (done) return done;
    const base = { id: capability.id, calls: capability.calls, status: 'unknown' as const, permissions: capability.permissions };
    if (capability.kind === 'none') return { ...base, note: `not probeable: ${capability.because ?? 'the only way to settle it is a real write'}` };
    if (capability.kind === 'reversible') return { ...base, note: 'settled only by a harmless probe against a reserved name; re-run with deep: true' };
    return { ...base, note: 'the ids this probe needs are not known (open the place in Studio, or pass universe_id / place_id)' };
  });
  return { capabilities, probed };
}

// ---------------------------------------------------------------------------

export interface ProbeArgs {
  deep?: boolean | undefined;
  universe_id?: number | undefined;
  place_id?: number | undefined;
}

const HOW_TO_FIX = 'Add a denied capability in Creator Hub (create.roblox.com/dashboard/credentials → your key → Access Permissions) using the permissions listed against it.';

function tally(capabilities: ProbeOutcome[]): { allowed: string[]; denied: string[]; unknown: string[] } {
  const pick = (status: ProbeStatus): string[] => capabilities.filter((c) => c.status === status).map((c) => c.id);
  return { allowed: pick('allowed'), denied: pick('denied'), unknown: pick('unknown') };
}

/**
 * Reports, per capability, allowed | denied | unknown for the configured key: from introspection
 * when Roblox answers it, otherwise by trial requests (`deep` adds the ones that need a harmless
 * request against a reserved name).
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
  const context = {
    what: 'key',
    key_source: keySource ?? 'unknown',
    ...(ids.universeId ? { universe_id: ids.universeId } : {}),
    ...(ids.placeId ? { place_id: ids.placeId } : {}),
    ...(ids.creatorType && ids.creatorId ? { creator: { type: ids.creatorType, id: ids.creatorId } } : {}),
    deep,
  };

  const introspected = await introspect(http);
  if (introspected.ok) {
    const key = introspected.key;
    const index = heldIndex(key.scopes);
    const capabilities = CAPABILITIES.map((capability) => judge(capability, index, ids, key));
    const { allowed, denied, unknown } = tally(capabilities);
    const universeBound = key.scopes.filter((s) => s.universeIds || s.universeDatastores);
    const universe = ids.universeId ? String(ids.universeId) : undefined;
    const boundHere =
      universe === undefined || universeBound.length === 0
        ? null
        : universeBound.some((s) => (s.universeIds ?? []).some((u) => u === '*' || u === universe) || (s.universeDatastores ?? []).some((d) => d.universeId === '*' || d.universeId === universe));
    const held = [...index.keys()].sort();
    return {
      value: {
        ...context,
        method: 'introspect',
        key: {
          ...(key.name !== undefined ? { name: key.name } : {}),
          ...(key.ownerUserId !== undefined ? { owner_user_id: key.ownerUserId } : {}),
          enabled: key.enabled,
          expired: key.expired,
          ...(key.expires !== undefined ? { expires: key.expires } : {}),
        },
        ...(boundHere !== null ? { bound_to_this_universe: boundHere } : {}),
        allowed,
        denied,
        unknown,
        capabilities,
        scopes_held: held.slice(0, MAX_SCOPES_LISTED),
        ...(held.length > MAX_SCOPES_LISTED ? { scopes_held_truncated: held.length - MAX_SCOPES_LISTED } : {}),
        summary: !key.enabled
          ? 'The key is disabled, so it can do nothing; re-enable it in Creator Hub.'
          : key.expired
            ? `The key has expired${key.expires ? ` (${key.expires})` : ''}, so it can do nothing; renew it or create a new one.`
            : boundHere === false
              ? `The key is not bound to universe ${ids.universeId} at all — add this experience under the key's Access Permissions. ${allowed.length} allowed, ${denied.length} denied, ${unknown.length} unknown of ${capabilities.length} capabilities.`
              : `${allowed.length} allowed, ${denied.length} denied, ${unknown.length} unknown of ${capabilities.length} capabilities, read from the key itself.`,
        note: [
          'Read from Roblox’s key introspection endpoint (api-keys/v1/introspect), so writes are judged too and nothing was called to find out.',
          denied.length > 0 ? HOW_TO_FIX : '',
        ]
          .filter((line) => line !== '')
          .join(' '),
      },
    };
  }

  // Fallback: introspection did not answer, so ask by trial request.
  const { capabilities, probed } = await probeByRequests(ids, http, deep);
  const { allowed, denied, unknown } = tally(capabilities);
  // Every probe answering 401 means the key itself is bad, not that a dozen scopes are missing.
  const allRejected = probed.length > 0 && probed.every((p) => p.http === 401);
  // A universe the key is not bound to is authorized before anything inside it is resolved, so it
  // answers 403 to every scoped probe — which reads like a dozen missing scopes but is one fix.
  const universeScoped = probed.filter((p) => {
    const c = CAPABILITIES.find((cap) => cap.id === p.id);
    return c?.binding === 'universe' && c.requires.length > 0;
  });
  const unboundUniverse = !allRejected && universeScoped.length > 1 && universeScoped.every((p) => p.http === 403);

  return {
    value: {
      ...context,
      method: 'probe',
      introspect_error: introspected.reason,
      allowed,
      denied,
      unknown,
      capabilities,
      summary: allRejected
        ? 'Every probe answered 401: the key itself was rejected (mistyped, expired, revoked, or IP-limited), so nothing could be measured.'
        : unboundUniverse
          ? `Every universe-scoped probe answered 403, which usually means the key is not bound to universe ${ids.universeId} at all rather than missing each scope — add this experience under the key's Access Permissions. ${allowed.length} allowed, ${denied.length} denied, ${unknown.length} unknown of ${capabilities.length} capabilities.`
          : `${allowed.length} allowed, ${denied.length} denied, ${unknown.length} unknown of ${capabilities.length} capabilities.`,
      note: [
        `Key introspection was unavailable (${introspected.reason}), so this was measured by trial requests: a 403 means the scope is missing, a 404 means the scope is present and the probed name simply does not exist. Writes cannot be tried harmlessly, so most stay unknown.`,
        denied.length > 0 ? HOW_TO_FIX : '',
        !deep ? 'deep: true additionally probes writes that a request against a reserved name can settle (nothing real is changed).' : '',
      ]
        .filter((line) => line !== '')
        .join(' '),
    },
  };
}
