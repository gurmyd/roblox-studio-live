import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPABILITIES, PROBE_NAME } from '../../bridge/src/cloud/capabilities.js';
import { runCloudTool } from '../../bridge/src/cloud/index.js';
import { INTROSPECT_PATH, classify, parseIntrospection } from '../../bridge/src/cloud/probe.js';
import { startFakeCloud, type FakeCloud, type SeenRequest } from './fake-cloud.js';
import { KEY, makeCtx, parse } from './harness.js';

interface Capability {
  id: string;
  calls: string;
  status: string;
  permissions: string[];
  http?: number;
  note?: string;
}

function capabilities(value: Record<string, unknown>): Map<string, Capability> {
  return new Map((value.capabilities as Capability[]).map((c) => [c.id, c]));
}

/** The trial requests only — every run also makes one introspection call first. */
function probes(seen: SeenRequest[]): SeenRequest[] {
  return seen.filter((s) => s.path !== INTROSPECT_PATH);
}

/** An introspection answer for a key bound to universe 111 unless told otherwise. */
function introspection(scopes: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'agent key', authorizedUserId: 234, scopes, enabled: true, expired: false, expirationTimeUtc: '2027-01-01T00:00:00.000Z', ...extra };
}

let fake: FakeCloud;
let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  fake = await startFakeCloud();
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-probe-test-'));
  for (const name of ['ROBLOX_OPEN_CLOUD_KEY', 'ROBLOX_OPEN_CLOUD_BASE_URL']) savedEnv[name] = process.env[name];
  process.env.ROBLOX_OPEN_CLOUD_BASE_URL = fake.url;
});

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fake.close();
  await fsp.rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  fake.reset();
  process.env.ROBLOX_OPEN_CLOUD_KEY = KEY;
});

describe('capability table', () => {
  it('gives every capability an id, the calls it covers, a permission line and a scope requirement', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const c of CAPABILITIES) {
      expect(c.id, 'id').toMatch(/^[a-z_]+\.[A-Za-z]+$/);
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(c.calls.length, c.id).toBeGreaterThan(0);
      expect(c.permissions.length, c.id).toBeGreaterThan(0);
      expect(Array.isArray(c.requires), c.id).toBe(true);
      for (const alternatives of c.requires) expect(alternatives.length, c.id).toBeGreaterThan(0);
      expect(['universe', 'creator', 'none'], c.id).toContain(c.binding);
      // A capability is either probeable by request (and knows how to build it) or says why not.
      if (c.kind === 'none') expect(c.because, c.id).toBeTruthy();
      else expect(typeof c.request, c.id).toBe('function');
    }
  });

  it('only ever probes reserved names, never a name a real game would use', () => {
    const ids = { universeId: 111, placeId: 222, creatorType: 'Group' as const, creatorId: 333 };
    for (const c of CAPABILITIES) {
      const request = c.request?.(ids);
      if (!request) continue;
      // Anything addressing a store, map, queue or entry must address the reserved probe name.
      if (/data-stores\/|\/entries\/|sorted-maps\/|queues\//.test(request.path)) expect(request.path, c.id).toContain(encodeURIComponent(PROBE_NAME));
      // Nothing may create or change anything.
      expect(['GET', 'DELETE'], c.id).toContain(request.method);
    }
  });
});

describe('classify', () => {
  it('reads authorization out of the status: 403 denies, 404 proves the scope is present', () => {
    expect(classify(200).status).toBe('allowed');
    expect(classify(204).status).toBe('allowed');
    expect(classify(404).status).toBe('allowed');
    expect(classify(400).status).toBe('allowed');
    expect(classify(403).status).toBe('denied');
    expect(classify(401).status).toBe('denied');
    expect(classify(429).status).toBe('unknown');
    expect(classify(500).status).toBe('unknown');
    expect(classify(418).status).toBe('unknown');
    expect(classify(404).note).toBeTruthy();
  });
});

describe('info what:"key" — introspection', () => {
  it('asks the introspection endpoint with the key in the body, and judges writes without calling anything', async () => {
    const { ctx } = makeCtx(home);
    fake.respond((req) =>
      req.path === INTROSPECT_PATH
        ? {
            body: introspection([
              { name: 'universe-datastores.objects', operations: ['read', 'list'], universeIds: ['111'] },
              { name: 'universe-messaging-service', operations: ['publish'], universeIds: ['*'] },
              { name: 'asset', operations: ['read', 'write'], groupIds: ['*'], userIds: ['*'] },
            ]),
          }
        : { status: 500, body: 'should not be called' },
    );

    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    // One request: the introspection. No trial probes, no writes.
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: INTROSPECT_PATH });
    expect(fake.seen[0].json).toEqual({ apiKey: KEY });
    // The documented sample sends the key only in the body, not as x-api-key.
    expect(fake.seen[0].headers['x-api-key']).toBeUndefined();

    const byId = capabilities(value);
    expect(value).toMatchObject({ what: 'key', method: 'introspect', universe_id: 111, bound_to_this_universe: true });
    expect(value.key).toEqual({ name: 'agent key', owner_user_id: 234, enabled: true, expired: false, expires: '2027-01-01T00:00:00.000Z' });
    expect(byId.get('datastore.read')?.status).toBe('allowed');
    expect(byId.get('datastore.listEntries')?.status).toBe('allowed');
    // Writes are judged too — the whole point of introspecting.
    expect(byId.get('message.publish')?.status).toBe('allowed');
    expect(byId.get('asset.upload')?.status).toBe('allowed');
    expect(byId.get('datastore.set')?.status).toBe('denied');
    expect(byId.get('datastore.set')?.note).toContain('universe-datastores.objects:update');
    expect(byId.get('place.publish')?.status).toBe('denied');
    // Scope-free reads are allowed for any live key.
    expect(byId.get('info.universe')?.status).toBe('allowed');
    expect(value.scopes_held).toEqual(expect.arrayContaining(['universe-datastores.objects:read', 'universe-messaging-service:publish', 'asset:write']));
    expect(String(value.note)).toContain('introspection');
  });

  it('denies a scope held only for a different universe, and says the key is not bound here', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: introspection([{ name: 'universe-datastores.objects', operations: ['read'], universeIds: ['999'] }]) }));
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    const byId = capabilities(value);
    expect(byId.get('datastore.read')?.status).toBe('denied');
    expect(byId.get('datastore.read')?.note).toContain('not for universe 111');
    expect(value.bound_to_this_universe).toBe(false);
    expect(String(value.summary)).toContain('not bound to universe 111');
  });

  it('notes a data store scope narrowed to named stores instead of implying all of them', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: introspection([{ name: 'universe-datastores.objects', operations: ['read'], universeDatastores: [{ universeId: '111', datastoreName: 'playerData' }] }]) }));
    const byId = capabilities(parse(await runCloudTool({ action: 'info', what: 'key' }, ctx)));
    expect(byId.get('datastore.read')?.status).toBe('allowed');
    expect(byId.get('datastore.read')?.note).toContain('playerData');
  });

  it('binds asset scopes to the creator: a user-only asset scope does not reach a group-owned place', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: introspection([{ name: 'asset', operations: ['read', 'write'], userIds: ['234'] }]) }));
    const byId = capabilities(parse(await runCloudTool({ action: 'info', what: 'key' }, ctx)));
    expect(byId.get('asset.upload')?.status).toBe('denied');
    expect(byId.get('asset.upload')?.note).toContain('this group (333)');
  });

  it('treats the notification scope as universe-bound, the way a real key reports it', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: introspection([{ name: 'user.user-notification', operations: ['write'], universeIds: ['999'] }]) }));
    let byId = capabilities(parse(await runCloudTool({ action: 'info', what: 'key' }, ctx)));
    expect(byId.get('notify.send')?.status).toBe('denied');
    expect(byId.get('notify.send')?.note).toContain('not for universe 111');

    fake.respond(() => ({ body: introspection([{ name: 'user.user-notification', operations: ['write'], universeIds: ['111'] }]) }));
    byId = capabilities(parse(await runCloudTool({ action: 'info', what: 'key' }, ctx)));
    expect(byId.get('notify.send')?.status).toBe('allowed');
  });

  it('reports a disabled or expired key once, whichever expiry spelling arrives', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: introspection([{ name: 'universe-messaging-service', operations: ['publish'], universeIds: ['*'] }], { enabled: false }) }));
    let value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    expect(value.allowed).toEqual([]);
    expect(String(value.summary)).toContain('disabled');

    fake.respond(() => ({ body: { name: 'old', authorizedUserId: '234', scopes: [], enabled: true, expired: true, expirationUtcTime: '2025-01-01T00:00:00Z' } }));
    value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    expect(value.allowed).toEqual([]);
    expect(String(value.summary)).toContain('2025-01-01T00:00:00Z');
    expect(value.key).toMatchObject({ owner_user_id: 234, expired: true, expires: '2025-01-01T00:00:00Z' });
  });

  it('accepts every known memory store spelling, and reports an unknown one rather than calling it missing', async () => {
    const { ctx } = makeCtx(home);
    // The bare OpenAPI form is what a real key's introspection returned (2026-09-14).
    fake.respond(() => ({ body: introspection([{ name: 'memory-store.sorted-map', operations: ['read', 'write'], universeIds: ['111'] }, { name: 'memory-store.queue', operations: ['add', 'dequeue', 'discard'], universeIds: ['111'] }]) }));
    let byId = capabilities(parse(await runCloudTool({ action: 'info', what: 'key' }, ctx)));
    for (const id of ['memory.mapRead', 'memory.mapWrite', 'memory.queueRead', 'memory.queueWrite']) expect(byId.get(id)?.status, id).toBe('allowed');

    fake.respond(() => ({ body: introspection([{ name: 'memoryStores:sortedMap', operations: ['read'], universeIds: ['111'] }]) }));
    byId = capabilities(parse(await runCloudTool({ action: 'info', what: 'key' }, ctx)));
    expect(byId.get('memory.mapRead')?.status).toBe('allowed');

    fake.respond(() => ({ body: introspection([{ name: 'universe.memory-store-sorted-map-item', operations: ['read'], universeIds: ['111'] }]) }));
    byId = capabilities(parse(await runCloudTool({ action: 'info', what: 'key' }, ctx)));
    expect(byId.get('memory.mapRead')?.status).toBe('allowed');

    fake.respond(() => ({ body: introspection([{ name: 'universe.memory-store.sorted-map-v9', operations: ['read'], universeIds: ['111'] }]) }));
    byId = capabilities(parse(await runCloudTool({ action: 'info', what: 'key' }, ctx)));
    expect(byId.get('memory.mapRead')?.status).toBe('unknown');
    expect(byId.get('memory.mapRead')?.note).toContain('does not recognise');
  });

  it('leaves the Groups / Users reads unknown: they need no scope, but a group-owned key gets 401 there', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: introspection([]) }));
    const byId = capabilities(parse(await runCloudTool({ action: 'info', what: 'key' }, ctx)));
    for (const id of ['info.group', 'info.user', 'group.read']) {
      expect(byId.get(id)?.status, id).toBe('unknown');
      expect(byId.get(id)?.note, id).toContain('group-owned key');
    }
    // A key with no scopes at all still introspects; scope-free reads stay allowed.
    expect(byId.get('info.universe')?.status).toBe('allowed');
  });

  it('never lets the key reach the result or the logs, even though it travels in the introspection body', async () => {
    const { ctx, logs } = makeCtx(home);
    fake.respond((req) => ({ body: { ...introspection([]), echoed: JSON.stringify(req.json) } }));
    const result = await runCloudTool({ action: 'info', what: 'key' }, ctx);
    expect(result.content[0].text).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  it('parses introspection defensively', () => {
    expect(parseIntrospection({ displayName: 'not an introspection' })).toBeNull();
    expect(parseIntrospection(null)).toBeNull();
    const parsed = parseIntrospection({ scopes: [{ name: 'asset', operations: ['read'], groupIds: [5] }, { operations: ['x'] }], authorizedUserId: 7 });
    expect(parsed?.scopes).toHaveLength(1);
    expect(parsed?.scopes[0].groupIds).toEqual(['5']);
    expect(parsed?.ownerUserId).toBe(7);
    expect(parsed?.enabled).toBe(true);
  });
});

describe('info what:"key" — fallback probing when introspection is unavailable', () => {
  it('falls back to trial reads and sorts capabilities into allowed / denied / unknown', async () => {
    const { ctx } = makeCtx(home);
    fake.respond((req) => {
      if (req.path === INTROSPECT_PATH) return { status: 404, body: { message: 'not found' } };
      if (req.path.includes('/data-stores') && !req.path.includes('/entries')) return { status: 403, body: { message: 'Insufficient scope' } };
      if (req.path.includes('/entries')) return { status: 404, body: { message: 'not found' } };
      return { status: 200, body: { displayName: 'ok' } };
    });

    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    const byId = capabilities(value);

    expect(value).toMatchObject({ what: 'key', method: 'probe', deep: false, universe_id: 111 });
    expect(String(value.introspect_error)).toContain('404');
    expect(value.creator).toEqual({ type: 'Group', id: 333 });
    // 403 on list_stores → denied, and the result still names the permission to add.
    expect(byId.get('datastore.list')?.status).toBe('denied');
    expect(byId.get('datastore.list')?.http).toBe(403);
    expect(byId.get('datastore.list')?.permissions).toEqual(['Data Stores → universe-datastores.control:list']);
    // 404 against the reserved name → the scope is present.
    expect(byId.get('datastore.read')?.status).toBe('allowed');
    expect(byId.get('datastore.read')?.http).toBe(404);
    expect(byId.get('info.universe')?.status).toBe('allowed');
    expect(String(value.summary)).toMatch(/\d+ allowed, \d+ denied, \d+ unknown/);
  });

  it('never probes a write by default: set / increment / message / luau / assets come back unknown with the reason', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 200, body: {} }));
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    const byId = capabilities(value);
    expect(value.method).toBe('probe');

    for (const id of ['datastore.set', 'datastore.increment', 'message.publish', 'luau.execute', 'asset.upload', 'place.publish', 'restriction.write', 'notify.send']) {
      expect(byId.get(id)?.status, id).toBe('unknown');
      expect(byId.get(id)?.note, id).toContain('not probeable');
    }
    // Reversible ones are skipped too, but say how to settle them.
    expect(byId.get('ordered.write')?.status).toBe('unknown');
    expect(byId.get('ordered.write')?.note).toContain('deep: true');

    // Nothing that changes state was sent.
    for (const seen of probes(fake.seen)) expect(seen.method).toBe('GET');
  });

  it('deep:true settles the reversible capabilities against the reserved name and nothing else', async () => {
    const { ctx } = makeCtx(home);
    fake.respond((req) => (req.path === INTROSPECT_PATH ? { status: 503 } : req.method === 'DELETE' ? { status: 404, body: { message: 'no such entry' } } : { status: 200, body: {} }));

    const value = parse(await runCloudTool({ action: 'info', what: 'key', deep: true }, ctx));
    const byId = capabilities(value);

    expect(value.deep).toBe(true);
    const reversible = CAPABILITIES.filter((c) => c.kind === 'reversible');
    for (const c of reversible) expect(byId.get(c.id)?.status, c.id).toBe('allowed');
    for (const del of probes(fake.seen).filter((s) => s.method === 'DELETE')) expect(del.path).toContain(encodeURIComponent(PROBE_NAME));
    // Still nothing that could create data.
    expect(probes(fake.seen).some((s) => s.method === 'POST' || s.method === 'PATCH')).toBe(false);
  });

  it('reports a rejected key once rather than as a dozen missing scopes', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 401, body: { message: 'Invalid API key' } }));
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    expect(String(value.summary)).toContain('401');
    expect(String(value.summary)).toMatch(/key itself was rejected/i);
  });

  it('reads 403 on every universe-scoped probe as an unbound universe, not a dozen missing scopes', async () => {
    const { ctx } = makeCtx(home);
    fake.respond((req) => (req.path === INTROSPECT_PATH ? { status: 404 } : req.path === '/cloud/v2/universes/111' ? { body: {} } : { status: 403, body: { message: 'User cannot manage universe.' } }));
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    expect(String(value.summary)).toContain('not bound to universe 111');
  });

  it('does not guess from a 429 or a 5xx, and does not retry them across a dozen probes', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 429, headers: { 'retry-after': '0' }, body: { message: 'slow down' } }));
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    const byId = capabilities(value);
    expect(byId.get('info.universe')?.status).toBe('unknown');
    expect(byId.get('info.universe')?.note).toContain('rate limited');

    // Exactly one request per capability these ids can address, plus the one introspection call —
    // a retrying probe would multiply this by four. (User-only probes such as info.user are not
    // among them: STUDIO's place is group-owned.)
    const runnable = CAPABILITIES.filter((c) => c.kind === 'read' && c.request?.({ universeId: 111, placeId: 222, creatorType: 'Group', creatorId: 333 }) != null).length;
    expect(runnable).toBeGreaterThan(5);
    expect(probes(fake.seen).length).toBe(runnable);
    expect(fake.seen.filter((s) => s.path === INTROSPECT_PATH)).toHaveLength(1);
  });

  it('says which ids are missing instead of probing with a guess when no Studio session is connected', async () => {
    const { ctx } = makeCtx(home, null);
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    const byId = capabilities(value);
    expect(byId.get('info.universe')?.status).toBe('unknown');
    expect(byId.get('info.universe')?.note).toContain('universe_id');
    expect(value.universe_id).toBeUndefined();
    // Introspection needs no ids, so it is still asked; no trial probe is.
    expect(probes(fake.seen)).toHaveLength(0);
  });

  it('accepts an explicit universe_id with no session, and picks group vs user probes off the place owner', async () => {
    fake.respond(() => ({ status: 200, body: {} }));
    const { ctx: none } = makeCtx(home, null);
    await runCloudTool({ action: 'info', what: 'key', universe_id: 4242 }, none);
    expect(probes(fake.seen).every((s) => !s.path.includes('/groups/') && !s.path.includes('/users/'))).toBe(true);
    expect(probes(fake.seen).some((s) => s.path.startsWith('/cloud/v2/universes/4242'))).toBe(true);

    fake.reset();
    fake.respond(() => ({ status: 200, body: {} }));
    const { ctx: userOwned } = makeCtx(home, { universeId: 7, placeId: 8, creatorType: 'User', creatorId: 9 });
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, userOwned));
    const byId = capabilities(value);
    expect(fake.seen.some((s) => s.path === '/cloud/v2/users/9')).toBe(true);
    expect(fake.seen.some((s) => s.path.includes('/groups/'))).toBe(false);
    expect(byId.get('info.user')?.status).toBe('allowed');
    expect(byId.get('info.group')?.status).toBe('unknown');
  });

  it('never lets the key reach the probe result, even when the server echoes it', async () => {
    const { ctx, logs } = makeCtx(home);
    fake.respond((req) => ({ status: 403, body: { message: `denied for ${req.headers['x-api-key']} ${JSON.stringify(req.json ?? {})}` } }));
    const result = await runCloudTool({ action: 'info', what: 'key' }, ctx);
    expect(result.content[0].text).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  it('tells the agent where the key came from and how to fix a denied capability', async () => {
    delete process.env.ROBLOX_OPEN_CLOUD_KEY;
    await fsp.writeFile(path.join(home, 'opencloud.key'), KEY);
    try {
      const { ctx } = makeCtx(home);
      fake.respond(() => ({ status: 403, body: {} }));
      const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
      expect(String(value.key_source)).toContain('opencloud.key');
      expect(String(value.note)).toContain('Access Permissions');
    } finally {
      await fsp.rm(path.join(home, 'opencloud.key'), { force: true });
    }
  });

  it('still reports no_api_key (not an empty probe) when there is no key at all', async () => {
    delete process.env.ROBLOX_OPEN_CLOUD_KEY;
    const { ctx } = makeCtx(home);
    const result = await runCloudTool({ action: 'info', what: 'key' }, ctx);
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: { code: 'no_api_key' } });
    expect(fake.seen).toHaveLength(0);
  });
});
