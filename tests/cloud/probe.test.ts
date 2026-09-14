import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPABILITIES, PROBE_NAME } from '../../bridge/src/cloud/capabilities.js';
import { runCloudTool } from '../../bridge/src/cloud/index.js';
import { classify } from '../../bridge/src/cloud/probe.js';
import { startFakeCloud, type FakeCloud } from './fake-cloud.js';
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
  it('gives every capability an id, the calls it covers and at least one permission line', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const c of CAPABILITIES) {
      expect(c.id, 'id').toMatch(/^[a-z_]+\.[A-Za-z]+$/);
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(c.calls.length, c.id).toBeGreaterThan(0);
      expect(c.permissions.length, c.id).toBeGreaterThan(0);
      // A capability is either probeable (and knows how to build the request) or says why not.
      if (c.kind === 'none') expect(c.because, c.id).toBeTruthy();
      else expect(typeof c.request, c.id).toBe('function');
    }
  });

  it('only ever probes reserved names, never a name a real game would use', () => {
    const ids = { universeId: 111, placeId: 222, creatorType: 'Group' as const, creatorId: 333 };
    for (const c of CAPABILITIES) {
      const request = c.request?.(ids);
      if (!request) continue;
      // Anything addressing a store/entry must address the reserved probe name.
      if (/data-stores\/|\/entries\//.test(request.path)) expect(request.path, c.id).toContain(encodeURIComponent(PROBE_NAME));
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

describe('info what:"key"', () => {
  it('probes reads only by default and sorts capabilities into allowed / denied / unknown', async () => {
    const { ctx } = makeCtx(home);
    fake.respond((req) => {
      if (req.path.includes('/data-stores') && !req.path.includes('/entries')) return { status: 403, body: { message: 'Insufficient scope' } };
      if (req.path.includes('/entries')) return { status: 404, body: { message: 'not found' } };
      return { status: 200, body: { displayName: 'ok' } };
    });

    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    const byId = capabilities(value);

    expect(value.what).toBe('key');
    expect(value.deep).toBe(false);
    expect(value.universe_id).toBe(111);
    expect(value.creator).toEqual({ type: 'Group', id: 333 });

    // 403 on list_stores → denied, and the result still names the permission to add.
    expect(byId.get('datastore.list')?.status).toBe('denied');
    expect(byId.get('datastore.list')?.http).toBe(403);
    expect(byId.get('datastore.list')?.permissions).toEqual(['Data Stores → universe-datastores.control:list']);
    // 404 against the reserved name → the scope is present.
    expect(byId.get('datastore.read')?.status).toBe('allowed');
    expect(byId.get('datastore.read')?.http).toBe(404);
    expect(byId.get('info.universe')?.status).toBe('allowed');

    expect(value.allowed).toContain('datastore.read');
    expect(value.denied).toContain('datastore.list');
    expect(String(value.summary)).toMatch(/\d+ allowed, \d+ denied, \d+ unknown/);
  });

  it('never probes a write by default: set / increment / message / luau / assets come back unknown with the reason', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 200, body: {} }));
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    const byId = capabilities(value);

    for (const id of ['datastore.set', 'datastore.increment', 'message.publish', 'luau.execute', 'asset.upload']) {
      expect(byId.get(id)?.status, id).toBe('unknown');
      expect(byId.get(id)?.note, id).toContain('not probeable');
    }
    // Reversible ones are skipped too, but say how to settle them.
    expect(byId.get('ordered.write')?.status).toBe('unknown');
    expect(byId.get('ordered.write')?.note).toContain('deep: true');

    // Nothing that changes state was sent.
    for (const seen of fake.seen) expect(seen.method).toBe('GET');
  });

  it('deep:true settles the reversible writes with a delete against the reserved name and nothing else', async () => {
    const { ctx } = makeCtx(home);
    fake.respond((req) => (req.method === 'DELETE' ? { status: 404, body: { message: 'no such entry' } } : { status: 200, body: {} }));

    const value = parse(await runCloudTool({ action: 'info', what: 'key', deep: true }, ctx));
    const byId = capabilities(value);

    expect(value.deep).toBe(true);
    expect(byId.get('ordered.write')?.status).toBe('allowed');
    expect(byId.get('datastore.delete')?.status).toBe('allowed');

    const deletes = fake.seen.filter((s) => s.method === 'DELETE');
    expect(deletes.length).toBe(2);
    for (const del of deletes) expect(del.path).toContain(encodeURIComponent(PROBE_NAME));
    // Still nothing that could create data.
    expect(fake.seen.some((s) => s.method === 'POST' || s.method === 'PATCH')).toBe(false);
  });

  it('reports a rejected key once rather than as a dozen missing scopes', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 401, body: { message: 'Invalid API key' } }));
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    expect(String(value.summary)).toContain('401');
    expect(String(value.summary)).toMatch(/key itself was rejected/i);
  });

  it('does not guess from a 429 or a 5xx, and does not retry them across a dozen probes', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 429, headers: { 'retry-after': '0' }, body: { message: 'slow down' } }));
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    const byId = capabilities(value);
    expect(byId.get('info.universe')?.status).toBe('unknown');
    expect(byId.get('info.universe')?.note).toContain('rate limited');

    // Exactly one request per capability that these ids can address — a retrying probe would
    // multiply this by four. (info.user is not among them: STUDIO's place is group-owned.)
    const runnable = CAPABILITIES.filter((c) => c.kind === 'read' && c.request?.({ universeId: 111, placeId: 222, creatorType: 'Group', creatorId: 333 }) !== null).length;
    expect(runnable).toBe(7);
    expect(fake.seen.length).toBe(runnable);
  });

  it('says which ids are missing instead of probing with a guess when no Studio session is connected', async () => {
    const { ctx } = makeCtx(home, null);
    const value = parse(await runCloudTool({ action: 'info', what: 'key' }, ctx));
    const byId = capabilities(value);
    expect(byId.get('info.universe')?.status).toBe('unknown');
    expect(byId.get('info.universe')?.note).toContain('universe_id');
    expect(value.universe_id).toBeUndefined();
    expect(fake.seen).toHaveLength(0);
  });

  it('accepts an explicit universe_id with no session, and picks group vs user probes off the place owner', async () => {
    fake.respond(() => ({ status: 200, body: {} }));
    const { ctx: none } = makeCtx(home, null);
    await runCloudTool({ action: 'info', what: 'key', universe_id: 4242 }, none);
    expect(fake.seen.every((s) => !s.path.includes('/groups/') && !s.path.includes('/users/'))).toBe(true);
    expect(fake.seen.some((s) => s.path.startsWith('/cloud/v2/universes/4242'))).toBe(true);

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
    fake.respond((req) => ({ status: 403, body: { message: `denied for ${req.headers['x-api-key']}` } }));
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
