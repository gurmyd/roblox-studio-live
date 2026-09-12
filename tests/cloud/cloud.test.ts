import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ASSET_TYPES, normalizeModeration, uploadTimeoutMs } from '../../bridge/src/cloud/actions.js';
import { MORE_KEYS_MARKER, renderResult } from '../../bridge/src/cloud/format.js';
import { createHttp } from '../../bridge/src/cloud/http.js';
import { cloudToolDescription, cloudToolName, cloudToolShape, runCloudTool, type CloudContext, type CloudIds, type ToolText } from '../../bridge/src/cloud/index.js';
import { startFakeCloud, type FakeCloud } from './fake-cloud.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const KEY = 'TESTKEY-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJ';
const OTHER_KEY = 'OTHERKEY-zyxwvutsrqponmlkjihgfedcba9876543210';
const STUDIO: CloudIds = { universeId: 111, placeId: 222, creatorType: 'Group', creatorId: 333, placeName: 'PIRATES' };

interface LogLine {
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}

function makeCtx(home: string, ids: CloudIds | null = STUDIO): { ctx: CloudContext; logs: LogLine[] } {
  const logs: LogLine[] = [];
  return {
    ctx: {
      home,
      ids: () => ids,
      log: (level, msg, data) => {
        logs.push({ level, msg, data });
      },
    },
    logs,
  };
}

function parse(result: ToolText): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function errorOf(result: ToolText): { code: string; message: string; [k: string]: unknown } {
  expect(result.isError).toBe(true);
  return parse(result).error as { code: string; message: string };
}

let fake: FakeCloud;
let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  fake = await startFakeCloud();
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-cloud-test-'));
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

afterEach(async () => {
  await fsp.rm(path.join(home, 'opencloud.json'), { force: true });
  await fsp.rm(path.join(home, 'opencloud.key'), { force: true });
});

describe('tool metadata', () => {
  it('exports the tool name, a short actionable description and a zod raw shape', () => {
    expect(cloudToolName).toBe('cloud');
    expect(Buffer.byteLength(cloudToolDescription)).toBeLessThan(2000);
    for (const action of ['datastore', 'ordered', 'message', 'info', 'asset_upload', 'luau']) expect(cloudToolDescription).toContain(action);
    expect(cloudToolDescription).toMatch(/default to the connected session/i);
    expect(Object.values(cloudToolShape).every((field) => field instanceof z.ZodType)).toBe(true);
    expect(z.object(cloudToolShape).safeParse({ action: 'info', what: 'universe' }).success).toBe(true);
  });

  it('rejects invalid arguments without touching the network', async () => {
    const { ctx } = makeCtx(home);
    const err = errorOf(await runCloudTool({ action: 'nope' }, ctx));
    expect(err.code).toBe('bad_request');
    expect(err.message).toContain('action');
    expect(errorOf(await runCloudTool({ action: 'message', topic: 'x'.repeat(81), message: 'hi' }, ctx)).message).toContain('topic');
    expect(fake.seen).toHaveLength(0);
  });
});

describe('API key resolution', () => {
  it('uses ROBLOX_OPEN_CLOUD_KEY first', async () => {
    await fsp.writeFile(path.join(home, 'opencloud.json'), JSON.stringify({ key: OTHER_KEY }));
    const { ctx } = makeCtx(home);
    const result = await runCloudTool({ action: 'info', what: 'universe' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(fake.seen[0].headers['x-api-key']).toBe(KEY);
  });

  it('falls back to <home>/opencloud.json {"key"} then <home>/opencloud.key, re-reading on every call', async () => {
    delete process.env.ROBLOX_OPEN_CLOUD_KEY;
    const { ctx } = makeCtx(home);
    await fsp.writeFile(path.join(home, 'opencloud.json'), JSON.stringify({ key: ` ${OTHER_KEY}\n` }));
    await runCloudTool({ action: 'info', what: 'universe' }, ctx);
    expect(fake.seen[0].headers['x-api-key']).toBe(OTHER_KEY);

    await fsp.rm(path.join(home, 'opencloud.json'));
    await fsp.writeFile(path.join(home, 'opencloud.key'), `${KEY}\r\n`);
    await runCloudTool({ action: 'info', what: 'universe' }, ctx);
    expect(fake.seen[1].headers['x-api-key']).toBe(KEY);

    // Rotate the key on disk: the very next call must use it (no restart, no cache).
    await fsp.writeFile(path.join(home, 'opencloud.key'), OTHER_KEY);
    await runCloudTool({ action: 'info', what: 'universe' }, ctx);
    expect(fake.seen[2].headers['x-api-key']).toBe(OTHER_KEY);
  });

  it('tolerates a UTF-8 BOM and CRLF in both key files (PowerShell Out-File / Notepad defaults)', async () => {
    delete process.env.ROBLOX_OPEN_CLOUD_KEY;
    const { ctx } = makeCtx(home);
    await fsp.writeFile(path.join(home, 'opencloud.json'), Buffer.concat([BOM, Buffer.from(`{"key": "${OTHER_KEY}"}\r\n`)]));
    let result = await runCloudTool({ action: 'info', what: 'universe' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(fake.seen[0].headers['x-api-key']).toBe(OTHER_KEY);

    await fsp.rm(path.join(home, 'opencloud.json'));
    await fsp.writeFile(path.join(home, 'opencloud.key'), Buffer.concat([BOM, Buffer.from(`${KEY}\r\n`)]));
    result = await runCloudTool({ action: 'info', what: 'universe' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(fake.seen[1].headers['x-api-key']).toBe(KEY);
  });

  it('explains exactly where to put a missing key and which permissions the action needs', async () => {
    delete process.env.ROBLOX_OPEN_CLOUD_KEY;
    const { ctx, logs } = makeCtx(home);
    const err = errorOf(await runCloudTool({ action: 'datastore', op: 'get', store: 's', key: 'k' }, ctx));
    expect(err.code).toBe('no_api_key');
    expect(err.message).toContain('ROBLOX_OPEN_CLOUD_KEY');
    expect(err.message).toContain(path.join(home, 'opencloud.json'));
    expect(err.message).toContain(path.join(home, 'opencloud.key'));
    expect(err.message).toContain('universe-datastores.objects:read');
    expect(err.message).toContain('create.roblox.com');
    expect(fake.seen).toHaveLength(0);
    expect(logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('reports a malformed key file instead of silently ignoring it', async () => {
    delete process.env.ROBLOX_OPEN_CLOUD_KEY;
    await fsp.writeFile(path.join(home, 'opencloud.json'), '{"apiKey": "wrong field"}');
    const { ctx } = makeCtx(home);
    const err = errorOf(await runCloudTool({ action: 'info', what: 'universe' }, ctx));
    expect(err.code).toBe('no_api_key');
    expect(err.message).toMatch(/no "key" string/);
  });
});

describe('id defaulting and overrides', () => {
  it('fails clearly when no Studio session is connected and no id was passed', async () => {
    const { ctx } = makeCtx(home, null);
    const err = errorOf(await runCloudTool({ action: 'datastore', op: 'list_stores' }, ctx));
    expect(err.code).toBe('no_ids');
    expect(err.message).toMatch(/Studio/);
    expect(err.message).toContain('universe_id');
    expect(fake.seen).toHaveLength(0);
  });

  it('tells the user to publish an unpublished place (GameId 0)', async () => {
    const { ctx } = makeCtx(home, { universeId: 0, placeId: 0, placeName: 'Place1' });
    const err = errorOf(await runCloudTool({ action: 'luau', script: 'return 1' }, ctx));
    expect(err.code).toBe('no_ids');
    expect(err.message).toMatch(/publish/i);
    expect(err.message).toContain('Place1');
  });

  it('distinguishes ids the session has not reported yet (undefined, first heartbeat pending) from an unpublished place (0)', async () => {
    // Right after `hello` only placeId/placeName are known; universeId and the creator arrive with the first `hb`.
    const { ctx } = makeCtx(home, { placeId: 222, placeName: 'Fresh' });
    let err = errorOf(await runCloudTool({ action: 'info', what: 'universe' }, ctx));
    expect(err.code).toBe('no_ids');
    expect(err.message).not.toMatch(/publish/i);
    expect(err.message).toMatch(/heartbeat/);
    expect(err.message).toContain('universe_id');
    expect(err.message).toContain('Fresh');

    err = errorOf(await runCloudTool({ action: 'info', what: 'me' }, ctx));
    expect(err.code).toBe('no_ids');
    expect(err.message).not.toMatch(/publish/i);
    expect(err.message).toMatch(/heartbeat/);
    expect(err.message).toContain('creator');

    const unpublished = makeCtx(home, { universeId: 5, placeId: 6, creatorType: 'User', creatorId: 0 });
    err = errorOf(await runCloudTool({ action: 'info', what: 'me' }, unpublished.ctx));
    expect(err.message).toMatch(/publish/i);
    expect(fake.seen).toHaveLength(0);
  });

  it('takes universe/place from the session and lets explicit args override', async () => {
    const { ctx } = makeCtx(home);
    let value = parse(await runCloudTool({ action: 'info', what: 'place' }, ctx));
    expect(fake.seen[0].path).toBe('/cloud/v2/universes/111/places/222');
    expect(value).toMatchObject({ universe_id: 111, place_id: 222, ids_from: 'studio' });

    value = parse(await runCloudTool({ action: 'info', what: 'place', universe_id: 999, place_id: 888 }, ctx));
    expect(fake.seen[1].path).toBe('/cloud/v2/universes/999/places/888');
    expect(value).toMatchObject({ universe_id: 999, place_id: 888, ids_from: 'args' });

    await runCloudTool({ action: 'info', what: 'place', place_id: 777 }, ctx);
    expect(fake.seen[2].path).toBe('/cloud/v2/universes/111/places/777');
  });

  it('resolves group/user/me from the place owner', async () => {
    const { ctx } = makeCtx(home);
    await runCloudTool({ action: 'info', what: 'me' }, ctx);
    expect(fake.seen[0].path).toBe('/cloud/v2/groups/333');
    await runCloudTool({ action: 'info', what: 'group' }, ctx);
    expect(fake.seen[1].path).toBe('/cloud/v2/groups/333');
    await runCloudTool({ action: 'info', what: 'user', id: 42 }, ctx);
    expect(fake.seen[2].path).toBe('/cloud/v2/users/42');
    const err = errorOf(await runCloudTool({ action: 'info', what: 'user' }, ctx));
    expect(err.code).toBe('no_ids');
    expect(err.message).toContain('group');

    const user = makeCtx(home, { universeId: 1, placeId: 2, creatorType: 'User', creatorId: 100000001 });
    await runCloudTool({ action: 'info', what: 'me' }, user.ctx);
    expect(fake.seen[3].path).toBe('/cloud/v2/users/100000001');
  });
});

describe('datastore requests', () => {
  it('shapes list_stores / list_entries / get / set / delete / increment like the v2 reference', async () => {
    const { ctx } = makeCtx(home);
    fake.respond((req) => ({ body: { echo: req.path, value: { coins: 5 }, etag: 'e1', id: 'k1' } }));

    await runCloudTool({ action: 'datastore', op: 'list_stores', page_size: 10, page_token: 'tok', show_deleted: true }, ctx);
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/data-stores', query: { maxPageSize: '10', pageToken: 'tok', showDeleted: 'true' } });
    expect(fake.seen[0].headers.accept).toBe('application/json');

    await runCloudTool({ action: 'datastore', op: 'list_entries', store: 'Players', scope: 'beta', filter: 'id.startsWith("p_")', page_size: 50 }, ctx);
    expect(fake.seen[1]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/data-stores/Players/scopes/beta/entries', query: { filter: 'id.startsWith("p_")', maxPageSize: '50' } });

    const got = parse(await runCloudTool({ action: 'datastore', op: 'get', store: 'Players', key: 'p_1/x' }, ctx));
    expect(fake.seen[2]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/data-stores/Players/entries/p_1%2Fx' });
    expect(got).toMatchObject({ store: 'Players', scope: 'global', key: 'p_1/x', value: { coins: 5 }, etag: 'e1' });

    await runCloudTool({ action: 'datastore', op: 'set', store: 'Players', key: 'p_1', value: { coins: 6 }, etag: 'e1', users: [100000001], attributes: { src: 'agent' } }, ctx);
    expect(fake.seen[3]).toMatchObject({ method: 'PATCH', path: '/cloud/v2/universes/111/data-stores/Players/entries/p_1', query: { allowMissing: 'true' } });
    expect(fake.seen[3].headers['content-type']).toBe('application/json');
    expect(fake.seen[3].json).toEqual({ value: { coins: 6 }, etag: 'e1', users: ['users/100000001'], attributes: { src: 'agent' } });

    const del = parse(await runCloudTool({ action: 'datastore', op: 'delete', store: 'Players', key: 'p_1' }, ctx));
    expect(fake.seen[4]).toMatchObject({ method: 'DELETE', path: '/cloud/v2/universes/111/data-stores/Players/entries/p_1' });
    expect(del).toMatchObject({ deleted: true, key: 'p_1' });

    await runCloudTool({ action: 'datastore', op: 'increment', store: 'Players', key: 'p_1', amount: -2 }, ctx);
    expect(fake.seen[5]).toMatchObject({ method: 'POST', path: '/cloud/v2/universes/111/data-stores/Players/entries/p_1:increment' });
    expect(fake.seen[5].json).toEqual({ amount: -2 });
  });

  it('validates required fields before sending anything', async () => {
    const { ctx } = makeCtx(home);
    expect(errorOf(await runCloudTool({ action: 'datastore', op: 'get', store: 'S' }, ctx)).message).toContain('key');
    expect(errorOf(await runCloudTool({ action: 'datastore', op: 'set', store: 'S', key: 'k' }, ctx)).message).toContain('value');
    expect(errorOf(await runCloudTool({ action: 'datastore', op: 'list', store: 'S' }, ctx)).message).toContain('not a datastore op');
    // The reference requires an integer increment; reject locally instead of relaying a 400.
    expect(errorOf(await runCloudTool({ action: 'datastore', op: 'increment', store: 'S', key: 'k', amount: 0.5 }, ctx)).message).toContain('integer');
    expect(errorOf(await runCloudTool({ action: 'datastore', op: 'increment', store: 'S', key: 'k' }, ctx)).message).toContain('integer');
    expect(fake.seen).toHaveLength(0);
  });
});

describe('ordered data store requests', () => {
  it('shapes list / get / set / delete / increment with the scope in the path', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { orderedDataStoreEntries: [{ id: 'a', value: 10 }], nextPageToken: '' } }));

    const list = parse(await runCloudTool({ action: 'ordered', op: 'list', store: 'Scores', order_by: 'value desc', filter: 'entry >= 10 && entry <= 30', page_size: 3 }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/ordered-data-stores/Scores/scopes/global/entries', query: { orderBy: 'value desc', filter: 'entry >= 10 && entry <= 30', maxPageSize: '3' } });
    expect(list).toMatchObject({ scope: 'global', orderedDataStoreEntries: [{ id: 'a', value: 10 }] });

    await runCloudTool({ action: 'ordered', op: 'get', store: 'Scores', scope: 'season1', key: 'u1' }, ctx);
    expect(fake.seen[1]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/ordered-data-stores/Scores/scopes/season1/entries/u1' });

    await runCloudTool({ action: 'ordered', op: 'set', store: 'Scores', key: 'u1', value: 42 }, ctx);
    expect(fake.seen[2]).toMatchObject({ method: 'PATCH', path: '/cloud/v2/universes/111/ordered-data-stores/Scores/scopes/global/entries/u1', query: { allowMissing: 'true' } });
    expect(fake.seen[2].json).toEqual({ value: 42 });

    await runCloudTool({ action: 'ordered', op: 'delete', store: 'Scores', key: 'u1' }, ctx);
    expect(fake.seen[3]).toMatchObject({ method: 'DELETE', path: '/cloud/v2/universes/111/ordered-data-stores/Scores/scopes/global/entries/u1' });

    await runCloudTool({ action: 'ordered', op: 'increment', store: 'Scores', key: 'u1', amount: 5 }, ctx);
    expect(fake.seen[4]).toMatchObject({ method: 'POST', path: '/cloud/v2/universes/111/ordered-data-stores/Scores/scopes/global/entries/u1:increment' });
    expect(fake.seen[4].json).toEqual({ amount: 5 });

    expect(errorOf(await runCloudTool({ action: 'ordered', op: 'set', store: 'Scores', key: 'u1', value: 1.5 }, ctx)).message).toContain('integer');
    expect(fake.seen).toHaveLength(5);
  });
});

describe('message requests', () => {
  it('publishes to universes/{id}:publishMessage, stringifying JSON and enforcing the 1 KB cap', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 200 }));
    const value = parse(await runCloudTool({ action: 'message', topic: 'Announce', message: { kind: 'reload', n: 1 } }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: '/cloud/v2/universes/111:publishMessage' });
    expect(fake.seen[0].json).toEqual({ topic: 'Announce', message: '{"kind":"reload","n":1}' });
    expect(value).toMatchObject({ published: true, topic: 'Announce', universe_id: 111 });

    await runCloudTool({ action: 'message', topic: 'Announce', message: 'plain', universe_id: 5 }, ctx);
    expect(fake.seen[1].path).toBe('/cloud/v2/universes/5:publishMessage');
    expect(fake.seen[1].json).toEqual({ topic: 'Announce', message: 'plain' });

    const err = errorOf(await runCloudTool({ action: 'message', topic: 'Announce', message: 'x'.repeat(1025) }, ctx));
    expect(err.message).toContain('1 KB');
    expect(fake.seen).toHaveLength(2);
  });
});

describe('asset_upload', () => {
  it('sends multipart request + fileContent and polls the operation until done', async () => {
    const file = path.join(home, 'decal.png');
    await fsp.writeFile(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    const { ctx } = makeCtx(home);
    let polls = 0;
    fake.respond((req) => {
      if (req.method === 'POST') return { body: { path: 'operations/op-123', operationId: 'op-123', done: false } };
      polls++;
      if (polls < 2) return { body: { path: 'operations/op-123', done: false } };
      return {
        body: {
          path: 'operations/op-123',
          done: true,
          // Assets v1 documents moderationState as Reviewing | Rejected | Approved.
          response: { assetId: '5551234', assetType: 'Decal', displayName: 'Logo', path: 'assets/5551234', revisionId: '1', moderationResult: { moderationState: 'Approved' } },
        },
      };
    });
    const value = parse(await runCloudTool({ action: 'asset_upload', file, asset_type: 'decal', name: 'Logo', description: 'd' }, ctx));

    const create = fake.seen[0];
    expect(create).toMatchObject({ method: 'POST', path: '/assets/v1/assets' });
    expect(create.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const form = await create.formData();
    expect(JSON.parse(form.get('request') as string)).toEqual({ assetType: 'Decal', displayName: 'Logo', description: 'd', creationContext: { creator: { groupId: '333' } } });
    const content = form.get('fileContent') as File;
    expect(content.type).toBe('image/png');
    expect(content.name).toBe('decal.png');
    expect(content.size).toBe(8);

    expect(fake.seen.slice(1).every((r) => r.method === 'GET' && r.path === '/assets/v1/operations/op-123')).toBe(true);
    expect(fake.seen).toHaveLength(3);
    expect(value).toMatchObject({ asset_id: 5551234, asset_type: 'Decal', moderation: 'approved', moderation_raw: 'Approved', operation_id: 'op-123', use: 'rbxassetid://5551234', creator: { type: 'Group', id: 333 } });
    expect(value.upload_timeout_ms).toBe(60_000);
  });

  it('normalises moderation spellings and asset types, and accepts Animation / Mesh', async () => {
    expect(normalizeModeration('Approved')).toBe('approved');
    expect(normalizeModeration('MODERATION_STATE_REVIEWING')).toBe('reviewing');
    expect(normalizeModeration('Rejected')).toBe('rejected');
    expect(normalizeModeration(undefined)).toBeNull();
    expect(ASSET_TYPES).toEqual(expect.arrayContaining(['Animation', 'Mesh', 'Model', 'Decal', 'Audio', 'Video', 'Image']));
    expect(cloudToolDescription).toContain('Animation');

    const file = path.join(home, 'anim.rbxm');
    await fsp.writeFile(file, 'rbxm');
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { path: 'operations/op-2', done: true, response: { assetId: '7', assetType: 'Animation', moderationResult: { moderationState: 'MODERATION_STATE_REVIEWING' } } } }));
    const value = parse(await runCloudTool({ action: 'asset_upload', file, asset_type: 'animation', name: 'Wave' }, ctx));
    const form = await fake.seen[0].formData();
    expect(JSON.parse(form.get('request') as string).assetType).toBe('Animation');
    expect(value).toMatchObject({ asset_id: 7, moderation: 'reviewing', moderation_raw: 'MODERATION_STATE_REVIEWING' });
  });

  it('scales the upload timeout with the file size, raised by timeout_ms and capped at 5 min', () => {
    expect(uploadTimeoutMs(8, 60_000)).toBe(60_000);
    expect(uploadTimeoutMs(5 * 1024 * 1024, 60_000)).toBe(30_000 + 52_000); // ceil(5 MiB / 100 KiB) = 52 s
    expect(uploadTimeoutMs(5 * 1024 * 1024, 120_000)).toBe(120_000);
    expect(uploadTimeoutMs(40 * 1024 * 1024, 60_000)).toBe(300_000);
  });

  it('honours a per-request timeout override in the http client and reports it as timeout', async () => {
    const http = createHttp({
      key: KEY,
      baseUrl: 'http://127.0.0.1:9',
      log: () => undefined,
      fetchImpl: ((_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error), { once: true });
        })) as unknown as typeof fetch,
    });
    const started = Date.now();
    await expect(http.request({ method: 'POST', path: '/assets/v1/assets', json: {}, timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout', details: { attempts: 1 } });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('uses an explicit creator, rejects relative paths and unknown extensions, and reports operation errors', async () => {
    const file = path.join(home, 'sound.mp3');
    await fsp.writeFile(file, 'abc');
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { path: 'operations/op-9', done: true, error: { code: 3, message: 'moderation rejected' } } }));
    const err = errorOf(await runCloudTool({ action: 'asset_upload', file, asset_type: 'Audio', name: 'Beep', creator: { type: 'User', id: 7 } }, ctx));
    expect(err.code).toBe('upload_failed');
    expect(err.message).toContain('moderation rejected');
    const form = await fake.seen[0].formData();
    expect(JSON.parse(form.get('request') as string).creationContext).toEqual({ creator: { userId: '7' } });
    expect((form.get('fileContent') as File).type).toBe('audio/mpeg');

    expect(errorOf(await runCloudTool({ action: 'asset_upload', file: 'relative.png', asset_type: 'Decal', name: 'x' }, ctx)).message).toContain('absolute');
    expect(errorOf(await runCloudTool({ action: 'asset_upload', file: path.join(home, 'x.exe'), asset_type: 'Model', name: 'x' }, ctx)).message).toContain('unsupported file extension');
    expect(fake.seen).toHaveLength(1);
  });
});

describe('luau execution', () => {
  const TASK = 'universes/111/places/222/luau-execution-sessions/s1/tasks/t1';

  it('creates a task with a duration timeout, polls until COMPLETE and returns results + logs', async () => {
    const { ctx } = makeCtx(home);
    let gets = 0;
    fake.respond((req) => {
      if (req.method === 'POST') return { body: { path: TASK, state: 'QUEUED' } };
      if (req.path.endsWith('/logs')) return { body: { luauExecutionSessionTaskLogs: [{ path: `${TASK}/logs/1`, messages: ['hello from cloud', 'second'] }] } };
      gets++;
      return { body: { path: TASK, state: gets < 2 ? 'PROCESSING' : 'COMPLETE', output: { results: [3, 'x'] } } };
    });
    const value = parse(await runCloudTool({ action: 'luau', script: 'print("hello from cloud") return 1 + 2, "x"', timeout_ms: 5000 }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: '/cloud/v2/universes/111/places/222/luau-execution-session-tasks' });
    expect(fake.seen[0].json).toEqual({ script: 'print("hello from cloud") return 1 + 2, "x"', timeout: '5s' });
    expect(fake.seen[1]).toMatchObject({ method: 'GET', path: `/cloud/v2/${TASK}` });
    expect(fake.seen[fake.seen.length - 1]).toMatchObject({ method: 'GET', path: `/cloud/v2/${TASK}/logs`, query: { view: 'FLAT' } });
    expect(value).toMatchObject({ state: 'COMPLETE', results: [3, 'x'], logs: ['hello from cloud', 'second'], task: TASK, universe_id: 111, place_id: 222 });
  });

  it('reports FAILED tasks as errors with the script error and logs, and re-polls a given task path', async () => {
    const { ctx } = makeCtx(home);
    fake.respond((req) => {
      if (req.path.endsWith('/logs')) return { body: { luauExecutionSessionTaskLogs: [{ messages: ['before crash'] }] } };
      return { body: { path: TASK, state: 'FAILED', error: { code: 'SCRIPT_ERROR', message: 'attempt to index nil' } } };
    });
    const err = errorOf(await runCloudTool({ action: 'luau', task: TASK }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: `/cloud/v2/${TASK}` });
    expect(err.code).toBe('task_failed');
    expect(err.message).toContain('SCRIPT_ERROR');
    expect(err.message).toContain('attempt to index nil');
    expect(err.logs).toEqual(['before crash']);
    expect(errorOf(await runCloudTool({ action: 'luau', task: 'garbage' }, ctx)).message).toContain('task path');
  });

  it('gives the task path back when the wait bound is hit', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { path: TASK, state: 'PROCESSING' } }));
    const value = parse(await runCloudTool({ action: 'luau', script: 'while true do end', timeout_ms: 1000 }, ctx));
    expect(value).toMatchObject({ pending: true, state: 'PROCESSING', task: TASK });
    expect(String(value.note)).toContain(TASK);
  });
});

describe('retries and error mapping', () => {
  it('retries 429 honouring Retry-After and then succeeds', async () => {
    const { ctx, logs } = makeCtx(home);
    fake.respond((req) => (req.n === 1 ? { status: 429, headers: { 'retry-after': '1' }, body: { message: 'slow down' } } : { body: { displayName: 'ok' } }));
    const started = Date.now();
    const value = parse(await runCloudTool({ action: 'info', what: 'universe' }, ctx));
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(fake.seen).toHaveLength(2);
    expect(value.displayName).toBe('ok');
    expect(logs.some((l) => l.msg === 'cloud request retried' && l.data?.status === 429)).toBe(true);
  });

  it('gives up after 3 retries on 5xx for an idempotent call and maps the status', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 503, headers: { 'retry-after': '0' }, body: 'unavailable' }));
    const err = errorOf(await runCloudTool({ action: 'datastore', op: 'list_stores' }, ctx));
    expect(fake.seen).toHaveLength(4);
    expect(err.code).toBe('server_error');
    expect(err.status).toBe(503);
    expect(err.attempts).toBe(4);
    expect(err.message).toContain('Retried 3 times');
  });

  it('never replays a non-idempotent call after a 5xx (the server may have applied it), but still retries its 429s', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 500, headers: { 'retry-after': '0' }, body: { message: 'boom' } }));
    let err = errorOf(await runCloudTool({ action: 'datastore', op: 'increment', store: 'S', key: 'visits', amount: 1 }, ctx));
    expect(fake.seen).toHaveLength(1);
    expect(err.code).toBe('server_error');
    expect(err.attempts).toBe(1);
    expect(err.message).toContain('not idempotent');
    expect(err.not_retried).toBeDefined();

    fake.reset();
    fake.respond(() => ({ status: 502, body: 'bad gateway' }));
    err = errorOf(await runCloudTool({ action: 'message', topic: 't', message: 'm' }, ctx));
    expect(fake.seen).toHaveLength(1);
    expect(err.attempts).toBe(1);

    fake.reset();
    fake.respond(() => ({ status: 503, body: 'no' }));
    err = errorOf(await runCloudTool({ action: 'luau', script: 'return 1' }, ctx));
    expect(fake.seen).toHaveLength(1);

    fake.reset();
    fake.respond((req) => (req.n === 1 ? { status: 429, headers: { 'retry-after': '0' } } : { body: { path: 'x', value: 2 } }));
    const ok = parse(await runCloudTool({ action: 'ordered', op: 'increment', store: 'S', key: 'k', amount: 1 }, ctx));
    expect(fake.seen).toHaveLength(2);
    expect(ok.value).toBe(2);
  });

  it('does not wait out a long Retry-After', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 429, headers: { 'retry-after': '3600' } }));
    const err = errorOf(await runCloudTool({ action: 'info', what: 'universe' }, ctx));
    expect(fake.seen).toHaveLength(1);
    expect(err.code).toBe('rate_limited');
    expect(err.retry_after_ms).toBe(3_600_000);
  });

  it('maps 401 / 403 / 404 / 400 to actionable messages', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 401, body: { message: 'Invalid API key' } }));
    let err = errorOf(await runCloudTool({ action: 'info', what: 'universe' }, ctx));
    expect(err.code).toBe('unauthorized');
    expect(err.message).toContain('ROBLOX_OPEN_CLOUD_KEY');
    expect(err.message).toContain('Invalid API key');

    fake.respond(() => ({ status: 403, body: { code: 'PERMISSION_DENIED', message: 'Insufficient scope' } }));
    err = errorOf(await runCloudTool({ action: 'ordered', op: 'set', store: 'S', key: 'k', value: 1 }, ctx));
    expect(err.code).toBe('forbidden');
    expect(err.message).toContain('universe.ordered-data-store.scope.entry:write');
    expect(err.message).toContain('universe 111');
    expect(err.message).toContain('create.roblox.com');
    expect(err.permissions).toEqual(['Ordered Data Stores → universe.ordered-data-store.scope.entry:write']);

    fake.respond(() => ({ status: 404, body: { code: 'NOT_FOUND', message: 'Entry not found' } }));
    err = errorOf(await runCloudTool({ action: 'datastore', op: 'get', store: 'Players', key: 'nobody' }, ctx));
    expect(err.code).toBe('not_found');
    expect(err.looked_up).toEqual({ universe_id: 111, store: 'Players', key: 'nobody' });

    fake.respond(() => ({ status: 400, body: { code: 'INVALID_ARGUMENT', message: 'filter is malformed' } }));
    err = errorOf(await runCloudTool({ action: 'datastore', op: 'list_entries', store: 'Players', filter: '???' }, ctx));
    expect(err.code).toBe('bad_request');
    expect(err.message).toContain('filter is malformed');

    fake.respond(() => ({ status: 412, body: { message: 'etag mismatch' } }));
    err = errorOf(await runCloudTool({ action: 'datastore', op: 'set', store: 'Players', key: 'k', value: 1, etag: 'old' }, ctx));
    expect(err.code).toBe('conflict');
  });

  it('reports network failures without retrying non-idempotent calls', async () => {
    const { ctx } = makeCtx(home);
    const closed = await startFakeCloud();
    await closed.close();
    process.env.ROBLOX_OPEN_CLOUD_BASE_URL = closed.url;
    try {
      const err = errorOf(await runCloudTool({ action: 'message', topic: 't', message: 'm' }, ctx));
      expect(err.code).toBe('network');
      expect(err.attempts).toBe(1);
    } finally {
      process.env.ROBLOX_OPEN_CLOUD_BASE_URL = fake.url;
    }
  });
});

describe('secrecy', () => {
  it('never lets the key reach results or logs, even when the server echoes it', async () => {
    const { ctx, logs } = makeCtx(home);
    fake.respond((req) => ({ body: { echoed: req.headers['x-api-key'], nested: { again: `key=${req.headers['x-api-key']}` } } }));
    const ok = await runCloudTool({ action: 'info', what: 'universe' }, ctx);
    expect(ok.content[0].text).not.toContain(KEY);
    expect(ok.content[0].text).toContain('sk…');

    fake.respond((req) => ({ status: 403, body: { message: `denied for ${req.headers['x-api-key']}` } }));
    const denied = await runCloudTool({ action: 'info', what: 'universe' }, ctx);
    expect(denied.content[0].text).not.toContain(KEY);
    expect(denied.content[0].text).toContain('sk…');

    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(KEY);
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe('result size', () => {
  it('caps results at 20 KB with a truncated flag', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { dataStoreEntries: Array.from({ length: 3000 }, (_, i) => ({ path: `universes/111/data-stores/Players/entries/player_${i}`, id: `player_${i}` })) } }));
    const result = await runCloudTool({ action: 'datastore', op: 'list_entries', store: 'Players' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(20 * 1024);
    const value = parse(result);
    expect(value.truncated).toBe(true);
    const entries = value.dataStoreEntries as unknown[];
    expect(entries.length).toBeLessThan(3000);
    expect(entries[entries.length - 1]).toMatch(/^…\[\+\d+ more\]$/);
  });

  it('cuts wide objects (a map keyed by item id) by key count and still returns parseable JSON', async () => {
    const { ctx } = makeCtx(home);
    const inventory: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) inventory[`item_${i}`] = i;
    fake.respond(() => ({ body: { value: inventory, etag: 'e1' } }));
    const result = await runCloudTool({ action: 'datastore', op: 'get', store: 'Inventory', key: 'p_1' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(20 * 1024);
    const value = parse(result);
    expect(value.truncated).toBe(true);
    expect(value.etag).toBe('e1');
    const kept = value.value as Record<string, unknown>;
    expect(kept.item_0).toBe(0);
    expect(Object.keys(kept).length).toBeLessThan(5000);
    expect(kept[MORE_KEYS_MARKER]).toMatch(/^\+\d+ more keys$/);
  });

  it('falls back to a JSON envelope with a text preview when even the tightest cut does not fit', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 12; i++) wide[`k${i}`] = 'x'.repeat(300);
    const { text, truncated } = renderResult(wide, 300);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.preview).toBe('string');
    expect(String(parsed.preview).length).toBeGreaterThan(0);
    expect(String(parsed.note)).toContain('preview');
  });
});
