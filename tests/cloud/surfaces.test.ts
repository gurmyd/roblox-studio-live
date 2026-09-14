import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCloudTool } from '../../bridge/src/cloud/index.js';
import { WRITABLE_CLASSES } from '../../bridge/src/cloud/instances.js';
import { parameterValues } from '../../bridge/src/cloud/notify.js';
import { NOT_PUBLISHED_BY_API, detectPlaceFormat, versionNumberOf } from '../../bridge/src/cloud/publish.js';
import { cloudToolDescription } from '../../bridge/src/cloud/schema.js';
import { startFakeCloud, type FakeCloud } from './fake-cloud.js';
import { KEY, errorOf, makeCtx, parse } from './harness.js';

/**
 * Request-shape tests for the Open Cloud surfaces added after v1.1: place publishing, memory
 * stores, the asset lifecycle, user restrictions, the Instance API, notifications and the extra
 * info reads. Every path, verb and body field asserted here was checked against Roblox's own
 * OpenAPI spec (creator-docs content/en-us/reference/cloud) — these tests pin that shape so a
 * refactor cannot quietly drift from it.
 */
const BINARY_PLACE = Buffer.concat([Buffer.from('<roblox!', 'binary'), Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('chunks…')]);
const XML_PLACE = Buffer.from('<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" version="4"></roblox>');

let fake: FakeCloud;
let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  fake = await startFakeCloud();
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-surfaces-test-'));
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
  for (const name of await fsp.readdir(home)) await fsp.rm(path.join(home, name), { force: true, recursive: true });
});

async function placeFile(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(home, name);
  await fsp.writeFile(file, bytes);
  return file;
}

describe('tool description', () => {
  it('names every action and stays inside the 2 KB tool budget', () => {
    expect(Buffer.byteLength(cloudToolDescription)).toBeLessThan(2000);
    for (const action of ['datastore', 'ordered', 'memory', 'message', 'info', 'publish', 'asset_upload', 'asset', 'luau', 'instance', 'restriction', 'notify']) {
      expect(cloudToolDescription, action).toContain(action);
    }
    // The single most important sequencing fact for an agent: publish before reading the published place.
    expect(cloudToolDescription).toMatch(/publish[\s\S]*before luau \/ instance/);
  });
});

// ---------------------------------------------------------------------------
describe('publish', () => {
  it('uploads the raw bytes (not multipart) to the v1 versions endpoint and goes live by default', async () => {
    const file = await placeFile('game.rbxl', BINARY_PLACE);
    const { ctx } = makeCtx(home);
    // The endpoint serves JSON as text/plain; the tool must read the version from it anyway.
    fake.respond(() => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: '{"versionNumber":7}' }));

    const value = parse(await runCloudTool({ action: 'publish', file }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: '/universes/v1/111/places/222/versions', query: { versionType: 'Published' } });
    expect(fake.seen[0].headers['content-type']).toBe('application/octet-stream');
    expect(fake.seen[0].raw.equals(BINARY_PLACE)).toBe(true);
    expect(value).toMatchObject({ universe_id: 111, place_id: 222, published: true, version_type: 'Published', version_number: 7, format: 'binary', bytes: BINARY_PLACE.length });
    // The silent-non-update trap is surfaced on every publish, not left to be found in-game.
    expect(value.not_updated_by_this_api).toEqual(NOT_PUBLISHED_BY_API);
    expect(String(value.note)).toContain('not_updated_by_this_api');
  });

  it('sends XML place files as application/xml and can save a version without publishing it', async () => {
    const file = await placeFile('game.rbxlx', XML_PLACE);
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { versionNumber: 8 } }));
    const value = parse(await runCloudTool({ action: 'publish', file, version_type: 'Saved' }, ctx));
    expect(fake.seen[0].headers['content-type']).toBe('application/xml');
    expect(fake.seen[0].query.versionType).toBe('Saved');
    expect(value).toMatchObject({ published: false, version_type: 'Saved', version_number: 8, format: 'xml' });
    expect(String(value.note)).toMatch(/WITHOUT publishing/);
  });

  it('trusts the bytes over the extension, because a mislabelled file earns a 400', async () => {
    // Both formats begin "<roblox", so a naive check misreads binary as XML.
    const file = await placeFile('mislabelled.rbxlx', BINARY_PLACE);
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { versionNumber: 1 } }));
    const value = parse(await runCloudTool({ action: 'publish', file }, ctx));
    expect(fake.seen[0].headers['content-type']).toBe('application/octet-stream');
    expect((value.warnings as string[]).join(' ')).toContain('contents are binary');

    expect(detectPlaceFormat('x.rbxl', BINARY_PLACE).format).toBe('binary');
    expect(detectPlaceFormat('x.rbxlx', XML_PLACE).format).toBe('xml');
    expect(detectPlaceFormat('x.rbxlx', Buffer.from('<?xml version="1.0"?><roblox/>')).format).toBe('xml');
  });

  it('refuses files that are not places, relative paths and missing files before sending anything', async () => {
    const { ctx } = makeCtx(home);
    const notAPlace = await placeFile('notes.rbxl', Buffer.from('hello world'));
    expect(errorOf(await runCloudTool({ action: 'publish', file: notAPlace }, ctx)).message).toMatch(/does not look like a Roblox place file/);
    expect(errorOf(await runCloudTool({ action: 'publish', file: 'relative/game.rbxl' }, ctx)).message).toContain('absolute');
    expect(errorOf(await runCloudTool({ action: 'publish', file: path.join(home, 'missing.rbxl') }, ctx)).message).toContain('Save the place in Studio first');
    const empty = await placeFile('empty.rbxl', Buffer.alloc(0));
    expect(errorOf(await runCloudTool({ action: 'publish', file: empty }, ctx)).message).toContain('empty');
    expect(fake.seen).toHaveLength(0);
  });

  it('never replays a publish after a 5xx — each accepted call is a new place version', async () => {
    const file = await placeFile('game.rbxl', BINARY_PLACE);
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 503, headers: { 'retry-after': '0' }, body: 'unavailable' }));
    const err = errorOf(await runCloudTool({ action: 'publish', file }, ctx));
    expect(fake.seen).toHaveLength(1);
    expect(err.code).toBe('server_error');
    expect(err.message).toContain('not idempotent');
  });

  it('explains a 409 as a busy place (Studio / Team Create), the case this tool actually runs into', async () => {
    const file = await placeFile('game.rbxl', BINARY_PLACE);
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 409, body: { code: 'Conflict', message: 'Save failed. Server is busy and unable to process your upload request.' } }));
    const err = errorOf(await runCloudTool({ action: 'publish', file }, ctx));
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/Team Create/);
    expect(err.message).toContain('Server is busy');
    expect(err.likely_cause).toMatch(/open in Studio/);
  });

  it('names universe-places:write — hyphenated, not the dotted v2 spelling — on a 403', async () => {
    const file = await placeFile('game.rbxl', BINARY_PLACE);
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 403, body: { message: 'Forbidden' } }));
    const err = errorOf(await runCloudTool({ action: 'publish', file }, ctx));
    expect(err.message).toContain('universe-places:write');
    expect(err.message).not.toContain('universe.place:write');
  });

  it('warns rather than refuses between the 10 MiB spec limit and the 100 MB place ceiling', async () => {
    const big = Buffer.concat([BINARY_PLACE, Buffer.alloc(11 * 1024 * 1024)]);
    const file = await placeFile('big.rbxl', big);
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { versionNumber: 3 } }));
    const value = parse(await runCloudTool({ action: 'publish', file }, ctx));
    expect(value.version_number).toBe(3);
    expect((value.warnings as string[]).join(' ')).toContain('10 MiB');
  });

  it('reads the version number whether the body arrives parsed or as text', () => {
    expect(versionNumberOf({ versionNumber: 7 })).toBe(7);
    expect(versionNumberOf('{"versionNumber":12}')).toBe(12);
    expect(versionNumberOf({ versionNumber: '9' })).toBe(9);
    expect(versionNumberOf('not json')).toBeNull();
    expect(versionNumberOf(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('memory', () => {
  it('always sends maxPageSize on map_list, because the service default of 1 looks like an empty map', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { items: [{ id: 'a', value: 1 }], nextPageToken: 't2' } }));
    const value = parse(await runCloudTool({ action: 'memory', op: 'map_list', store: 'Lobby' }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/memory-store/sorted-maps/Lobby/items', query: { maxPageSize: '100' } });
    expect(value).toMatchObject({ store: 'Lobby', page_size: 100, items: [{ id: 'a', value: 1 }], nextPageToken: 't2' });
    expect(String(value.filter_hint)).toContain('sortKey');

    await runCloudTool({ action: 'memory', op: 'map_list', store: 'Lobby', page_size: 250, filter: 'sortKey > 100', order_by: 'id desc', page_token: 't2' }, ctx);
    expect(fake.seen[1].query).toEqual({ maxPageSize: '100', filter: 'sortKey > 100', orderBy: 'id desc', pageToken: 't2' });
  });

  it('writes sorted map items as a whole-item PATCH with a duration ttl and the right sort key field', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { id: 'p1', value: { mmr: 1500 }, etag: 'e1' } }));

    const value = parse(await runCloudTool({ action: 'memory', op: 'map_set', store: 'Lobby', key: 'p/1', value: { mmr: 1500 }, ttl_s: 300, sort_key: 1500 }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'PATCH', path: '/cloud/v2/universes/111/memory-store/sorted-maps/Lobby/items/p%2F1', query: { allowMissing: 'true' } });
    // ttl is a protobuf duration STRING; a number or "PT5M" would be rejected.
    expect(fake.seen[0].json).toEqual({ value: { mmr: 1500 }, ttl: '300s', numericSortKey: 1500 });
    expect(String(value.note)).toMatch(/replace the whole item/);

    await runCloudTool({ action: 'memory', op: 'map_set', store: 'Lobby', key: 'p1', value: 1, sort_key: 'gold', ttl_s: 0.4 }, ctx);
    expect(fake.seen[1].json).toEqual({ value: 1, ttl: '1s', stringSortKey: 'gold' });

    await runCloudTool({ action: 'memory', op: 'map_get', store: 'Lobby', key: 'p1' }, ctx);
    expect(fake.seen[2]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/memory-store/sorted-maps/Lobby/items/p1' });

    fake.respond(() => ({ status: 200 }));
    const del = parse(await runCloudTool({ action: 'memory', op: 'map_delete', store: 'Lobby', key: 'p1' }, ctx));
    expect(fake.seen[3]).toMatchObject({ method: 'DELETE', path: '/cloud/v2/universes/111/memory-store/sorted-maps/Lobby/items/p1' });
    expect(del).toMatchObject({ deleted: true, key: 'p1' });
  });

  it('puts queue payloads in `data` (not `value`) and reads with a GET :read custom verb', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { id: 'item-1', data: { match: 7 }, priority: 5 } }));
    await runCloudTool({ action: 'memory', op: 'queue_add', store: 'Matchmaking', value: { match: 7 }, priority: 5, ttl_s: 60 }, ctx);
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: '/cloud/v2/universes/111/memory-store/queues/Matchmaking/items' });
    expect(fake.seen[0].json).toEqual({ data: { match: 7 }, priority: 5, ttl: '60s' });

    fake.respond(() => ({ body: { readId: 'r-9', items: [{ id: 'item-1', data: { match: 7 } }] } }));
    const read = parse(await runCloudTool({ action: 'memory', op: 'queue_read', store: 'Matchmaking', count: 5, all_or_nothing: true, invisibility_s: 30 }, ctx));
    // A literal ':' — %3A would miss the route.
    expect(fake.seen[1]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/memory-store/queues/Matchmaking/items:read' });
    expect(fake.seen[1].query).toEqual({ count: '5', allOrNothing: 'true', invisibilityWindow: '30s' });
    expect(read).toMatchObject({ read_id: 'r-9', count: 1, items: [{ id: 'item-1', data: { match: 7 } }] });
    expect(String(read.note)).toContain('queue_discard');

    fake.respond(() => ({ status: 200 }));
    const done = parse(await runCloudTool({ action: 'memory', op: 'queue_discard', store: 'Matchmaking', read_id: 'r-9' }, ctx));
    expect(fake.seen[2]).toMatchObject({ method: 'POST', path: '/cloud/v2/universes/111/memory-store/queues/Matchmaking/items:discard' });
    expect(fake.seen[2].json).toEqual({ readId: 'r-9' });
    expect(done).toMatchObject({ discarded: true, read_id: 'r-9' });
  });

  it('reads the reported live-service drift (queueItems) instead of silently returning nothing', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { id: 'r-drift', queueItems: [{ id: 'x' }, { id: 'y' }] } }));
    const read = parse(await runCloudTool({ action: 'memory', op: 'queue_read', store: 'Q' }, ctx));
    expect(read).toMatchObject({ count: 2, read_id: 'r-drift' });
    expect(read.raw_keys).toEqual(['id', 'queueItems']);
  });

  it('validates locally: payload, read_id, count and ttl', async () => {
    const { ctx } = makeCtx(home);
    expect(errorOf(await runCloudTool({ action: 'memory', op: 'map_set', store: 'S', key: 'k' }, ctx)).message).toContain('value');
    expect(errorOf(await runCloudTool({ action: 'memory', op: 'queue_add', store: 'S' }, ctx)).message).toContain('value');
    expect(errorOf(await runCloudTool({ action: 'memory', op: 'queue_discard', store: 'S' }, ctx)).message).toContain('read_id');
    expect(errorOf(await runCloudTool({ action: 'memory', op: 'queue_read', store: 'S', count: 500 }, ctx)).code).toBe('bad_request');
    expect(errorOf(await runCloudTool({ action: 'memory', op: 'map_set', store: 'S', key: 'k', value: 1, ttl_s: 0 }, ctx)).code).toBe('bad_request');
    expect(errorOf(await runCloudTool({ action: 'memory', op: 'map_list' }, ctx)).message).toContain('store');
    expect(errorOf(await runCloudTool({ action: 'memory', op: 'increment', store: 'S' }, ctx)).message).toContain('not a memory op');
    expect(fake.seen).toHaveLength(0);
  });

  it('names the queue:dequeue scope — not :read — on a 403, spelled the way a real key reports it', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 403, body: {} }));
    const err = errorOf(await runCloudTool({ action: 'memory', op: 'queue_read', store: 'Q' }, ctx));
    // Live introspection (2026-09-14) shows the bare OpenAPI name, without the `universe.` prefix.
    expect(err.message).toContain('memory-store.queue:dequeue');
    expect(err.message).not.toContain('universe.memory-store');
  });
});

// ---------------------------------------------------------------------------
describe('asset lifecycle', () => {
  it('gets an asset with an optional read mask', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { assetId: '555', assetType: 'Decal', displayName: 'Logo', moderationResult: { moderationState: 'Approved' } } }));
    const value = parse(await runCloudTool({ action: 'asset', op: 'get', asset_id: 555, read_mask: 'description,previews' }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/assets/v1/assets/555', query: { readMask: 'description,previews' } });
    expect(value).toMatchObject({ asset_id: 555, moderation: 'approved', use: 'rbxassetid://555' });
  });

  it('puts a new version behind the SAME asset id: multipart PATCH, then polls the operation', async () => {
    const file = path.join(home, 'cube.fbx');
    await fsp.writeFile(file, Buffer.from('; FBX 7.3.0 project file'));
    const { ctx } = makeCtx(home);
    fake.respond((req) => {
      if (req.method === 'PATCH') return { body: { path: 'operations/op-7', done: false } };
      return { body: { path: 'operations/op-7', done: true, response: { assetId: '555', revisionId: 'r2', moderationResult: { moderationState: 'MODERATION_STATE_REVIEWING' } } } };
    });

    const value = parse(await runCloudTool({ action: 'asset', op: 'update', asset_id: 555, file }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'PATCH', path: '/assets/v1/assets/555' });
    // A content-only update carries no updateMask.
    expect(fake.seen[0].query.updateMask).toBeUndefined();
    const form = await fake.seen[0].formData();
    expect(JSON.parse(String(form.get('request')))).toEqual({ assetId: 555 });
    const content = form.get('fileContent') as File;
    expect(content.type).toBe('model/fbx');
    // The poll must not double the "operations/" prefix the Operation path carries.
    expect(fake.seen[1]).toMatchObject({ method: 'GET', path: '/assets/v1/operations/op-7' });
    expect(value).toMatchObject({ asset_id: 555, updated: true, revision_id: 'r2', moderation: 'reviewing', operation_id: 'op-7' });
  });

  it('updates metadata only with an updateMask and takes the fields back inline', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { displayName: 'New name', description: 'd' } }));
    const value = parse(await runCloudTool({ action: 'asset', op: 'update', asset_id: 555, name: 'New name', description: 'd' }, ctx));
    expect(fake.seen[0].query.updateMask).toBe('displayName,description');
    const form = await fake.seen[0].formData();
    expect(JSON.parse(String(form.get('request')))).toEqual({ assetId: 555, displayName: 'New name', description: 'd' });
    expect(form.get('fileContent')).toBeNull();
    expect(value).toMatchObject({ updated: true, displayName: 'New name' });
    expect(fake.seen).toHaveLength(1);

    expect(errorOf(await runCloudTool({ action: 'asset', op: 'update', asset_id: 555 }, ctx)).message).toContain('needs something to change');
  });

  it('refuses to replace anything but an FBX, which is all Roblox can update', async () => {
    // Live, a Decal update answered 400 "Updating Decal is not supported yet".
    const file = path.join(home, 'decal.png');
    await fsp.writeFile(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    const { ctx } = makeCtx(home);
    const err = errorOf(await runCloudTool({ action: 'asset', op: 'update', asset_id: 555, file }, ctx));
    expect(err.code).toBe('bad_request');
    expect(err.message).toContain('FBX');
    expect(err.message).toContain('asset_upload');
    expect(fake.seen).toHaveLength(0);
  });

  it('does not claim a new version when only metadata changed, even when Roblox answers with an operation', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { path: 'operations/op-9', done: true, response: { assetId: '555', revisionId: '1', displayName: 'Renamed' } } }));
    const value = parse(await runCloudTool({ action: 'asset', op: 'update', asset_id: 555, name: 'Renamed' }, ctx));
    expect(value).toMatchObject({ updated: true, revision_id: '1', display_name: 'Renamed' });
    expect(String(value.note)).toContain('unchanged');
    expect(String(value.note)).not.toContain('new version');
  });

  it('lists versions, rolls back (JSON first, multipart on a 400), and archives / restores', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { assetVersions: [{ path: 'assets/555/versions/2' }] } }));
    await runCloudTool({ action: 'asset', op: 'versions', asset_id: 555, page_size: 10 }, ctx);
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/assets/v1/assets/555/versions', query: { maxPageSize: '10' } });
    expect(errorOf(await runCloudTool({ action: 'asset', op: 'versions', asset_id: 555, page_size: 51 }, ctx)).message).toContain('50');

    // The spec's schema says multipart and its runnable sample says JSON; the field name is certain.
    fake.reset();
    fake.respond((req) => ((req.headers['content-type'] ?? '').includes('json') ? { status: 400, body: { message: 'bad body' } } : { body: { path: 'assets/555/versions/2' } }));
    const rolled = parse(await runCloudTool({ action: 'asset', op: 'rollback', asset_id: 555, version: 2 }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: '/assets/v1/assets/555/versions:rollback' });
    expect(fake.seen[0].json).toEqual({ assetVersion: 'assets/555/versions/2' });
    expect(String(fake.seen[1].headers['content-type'])).toContain('multipart/form-data');
    expect((await fake.seen[1].formData()).get('assetVersion')).toBe('assets/555/versions/2');
    expect(rolled).toMatchObject({ rolled_back_to: 2, asset_version: 'assets/555/versions/2', sent_as: 'multipart' });

    fake.reset();
    fake.respond(() => ({ body: {} }));
    expect(parse(await runCloudTool({ action: 'asset', op: 'archive', asset_id: 555 }, ctx))).toMatchObject({ archived: true });
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: '/assets/v1/assets/555:archive' });
    expect(parse(await runCloudTool({ action: 'asset', op: 'restore', asset_id: 555 }, ctx))).toMatchObject({ restored: true });
    expect(fake.seen[1]).toMatchObject({ method: 'POST', path: '/assets/v1/assets/555:restore' });
  });

  it('does not fall back to multipart for errors other than a 400', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 404, body: { message: 'Asset Version not found' } }));
    const err = errorOf(await runCloudTool({ action: 'asset', op: 'rollback', asset_id: 555, version: 99 }, ctx));
    expect(err.code).toBe('not_found');
    expect(fake.seen).toHaveLength(1);
  });

  it('requires asset_id and a version before sending', async () => {
    const { ctx } = makeCtx(home);
    expect(errorOf(await runCloudTool({ action: 'asset', op: 'get' }, ctx)).message).toContain('asset_id');
    expect(errorOf(await runCloudTool({ action: 'asset', op: 'rollback', asset_id: 1 }, ctx)).message).toContain('version');
    expect(fake.seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('restriction', () => {
  it('bans from the whole experience by default, even though the session carries a place id', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { path: 'universes/111/user-restrictions/42', gameJoinRestriction: { active: true } } }));
    const value = parse(await runCloudTool({ action: 'restriction', op: 'ban', id: 42, reason: 'speed hack, logged', display_reason: 'Banned for exploiting.', duration_s: 3600, exclude_alts: false }, ctx));
    // STUDIO has placeId 222 — it must NOT narrow the ban to one place.
    expect(fake.seen[0]).toMatchObject({ method: 'PATCH', path: '/cloud/v2/universes/111/user-restrictions/42' });
    expect(fake.seen[0].query.updateMask).toBeUndefined();
    expect(fake.seen[0].json).toEqual({
      gameJoinRestriction: { active: true, duration: '3600s', privateReason: 'speed hack, logged', displayReason: 'Banned for exploiting.', excludeAltAccounts: false },
    });
    expect(value).toMatchObject({ user_id: 42, banned: true, permanent: false, duration_s: 3600, level: 'universe' });
  });

  it('makes a ban permanent by omitting duration, and scopes to one place only when asked', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: {} }));
    const value = parse(await runCloudTool({ action: 'restriction', op: 'ban', id: 42, reason: 'r', display_reason: 'd', level: 'place' }, ctx));
    expect(fake.seen[0].path).toBe('/cloud/v2/universes/111/places/222/user-restrictions/42');
    expect((fake.seen[0].json as { gameJoinRestriction: Record<string, unknown> }).gameJoinRestriction.duration).toBeUndefined();
    expect(value).toMatchObject({ permanent: true, level: 'place' });
    expect(String(value.note)).toContain('this place only');
  });

  it('unbans with the same PATCH and active:false (there is no DELETE)', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: {} }));
    const value = parse(await runCloudTool({ action: 'restriction', op: 'unban', id: 42 }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'PATCH', path: '/cloud/v2/universes/111/user-restrictions/42' });
    expect(fake.seen[0].json).toEqual({ gameJoinRestriction: { active: false } });
    expect(value).toMatchObject({ banned: false });
  });

  it('lists, gets and reads the universe-level logs', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { userRestrictions: [] } }));
    await runCloudTool({ action: 'restriction', op: 'list', page_size: 25 }, ctx);
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/user-restrictions', query: { maxPageSize: '25' } });
    await runCloudTool({ action: 'restriction', op: 'get', id: 42 }, ctx);
    expect(fake.seen[1].path).toBe('/cloud/v2/universes/111/user-restrictions/42');
    await runCloudTool({ action: 'restriction', op: 'logs', filter: 'user == "users/42"' }, ctx);
    expect(fake.seen[2]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/user-restrictions:listLogs', query: { filter: 'user == "users/42"' } });
  });

  it('refuses a ban without both reasons, a non-positive duration, and place-level logs', async () => {
    const { ctx } = makeCtx(home);
    expect(errorOf(await runCloudTool({ action: 'restriction', op: 'ban', id: 42, reason: 'r' }, ctx)).message).toContain('display_reason');
    expect(errorOf(await runCloudTool({ action: 'restriction', op: 'ban', id: 42, display_reason: 'd' }, ctx)).message).toContain('reason');
    expect(errorOf(await runCloudTool({ action: 'restriction', op: 'ban', id: 42, reason: 'r', display_reason: 'd', duration_s: -1 }, ctx)).code).toBe('bad_request');
    expect(errorOf(await runCloudTool({ action: 'restriction', op: 'logs', level: 'place' }, ctx)).message).toContain('universe-level only');
    expect(errorOf(await runCloudTool({ action: 'restriction', op: 'get' }, ctx)).message).toContain('id');
    expect(fake.seen).toHaveLength(0);
  });

  it('does not replay a restriction change into Roblox’s per-user rate limit', async () => {
    // Live, every attempt on user 1 answered this 429, retries included.
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 429, headers: { 'retry-after': '0' }, body: { code: 'RESOURCE_EXHAUSTED', message: 'You have made too many requests for user 1 in this universe or place in a short period. Please try again.' } }));
    const err = errorOf(await runCloudTool({ action: 'restriction', op: 'ban', id: 1, reason: 'r', display_reason: 'd' }, ctx));
    expect(fake.seen).toHaveLength(1);
    expect(err.code).toBe('rate_limited');
    expect(err.message).toContain('Not retried');
    expect(err.message).toContain('one user');

    fake.reset();
    fake.respond(() => ({ status: 429, headers: { 'retry-after': '0' }, body: { message: 'slow down' } }));
    await runCloudTool({ action: 'restriction', op: 'unban', id: 1 }, ctx);
    expect(fake.seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('instance', () => {
  const OP = 'universes/111/places/222/instances/root/operations/op-1';

  it('treats even a read as long-running: polls /cloud/v2/{operation path} and returns the response', async () => {
    const { ctx } = makeCtx(home);
    fake.respond((req) => {
      if (req.path === `/cloud/v2/${OP}`) return { body: { path: OP, done: true, response: { engineInstance: { Id: 'root', Name: 'Game' } } } };
      return { body: { path: OP, done: false } };
    });
    const value = parse(await runCloudTool({ action: 'instance', op: 'get' }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/places/222/instances/root' });
    expect(fake.seen[1]).toMatchObject({ method: 'GET', path: `/cloud/v2/${OP}` });
    expect(value).toMatchObject({ instance_id: 'root', engineInstance: { Id: 'root', Name: 'Game' }, operation: OP });
    expect(String(value.note)).toContain('PUBLISHED place');
  });

  it('lists children with the :listChildren GET, and answers at once when the operation is already done', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { path: OP, done: true, response: { instances: [{ hasChildren: false, engineInstance: { Id: 'a1', Name: 'Mod', Details: { ModuleScript: { Source: 'return 1' } } } }] } } }));
    const value = parse(await runCloudTool({ action: 'instance', op: 'children', instance_id: 'a0', page_size: 20 }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/places/222/instances/a0:listChildren', query: { maxPageSize: '20' } });
    expect(fake.seen).toHaveLength(1);
    expect(value.children).toEqual([{ id: 'a1', name: 'Mod', class: 'ModuleScript', has_children: false }]);
    expect(value.count).toBe(1);
    // maxPageSize is not implemented by Roblox on listChildren; the result says so when one is passed.
    expect(String(value.page_size_note)).toContain('not implemented');
  });

  it('lists a root with ~95 services in full, compactly, under the result cap', async () => {
    // Live, the verbose form of the root's ~90 children was cut to 50 by the 20 KB cap, and paging cannot recover the rest.
    const { ctx } = makeCtx(home);
    const id = (i: number): string => `4695731a-df11-071b-0ab9-f50c${String(i).padStart(8, '0')}`;
    const instances = Array.from({ length: 95 }, (_, i) => ({
      path: `universes/111/places/222/instances/${id(i)}`,
      hasChildren: i % 3 === 0,
      engineInstance: { Id: id(i), Parent: '5c434eab-e70c-2227-0ab9-f56e00000001', Name: `Service${i}`, Details: {} },
    }));
    fake.respond(() => ({ body: { path: OP, done: true, response: { '@type': 'type.googleapis.com/roblox.open_cloud.cloud.v2.ListInstanceChildrenResponse', instances, nextPageToken: '' } } }));
    const value = parse(await runCloudTool({ action: 'instance', op: 'children' }, ctx));
    expect(value.truncated).toBeUndefined();
    expect(value.count).toBe(95);
    const children = value.children as Array<Record<string, unknown>>;
    expect(children).toHaveLength(95);
    expect(children[0]).toEqual({ id: id(0), name: 'Service0', has_children: true });
    expect(children[94]).toEqual({ id: id(94), name: 'Service94', has_children: false });
    expect(value['@type']).toBeUndefined();
    expect(value.nextPageToken).toBeUndefined();
  });

  it('updates a script with camelCase engineInstance around PascalCase Details', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { path: OP, done: true, response: {} } }));
    await runCloudTool({ action: 'instance', op: 'update', instance_id: 'ms1', class_name: 'ModuleScript', properties: { Source: 'return {}' } }, ctx);
    expect(fake.seen[0]).toMatchObject({ method: 'PATCH', path: '/cloud/v2/universes/111/places/222/instances/ms1' });
    expect(fake.seen[0].json).toEqual({ engineInstance: { Details: { ModuleScript: { Source: 'return {}' } } } });

    await runCloudTool({ action: 'instance', op: 'update', instance_id: 's1', class_name: 'Script', properties: { Enabled: false, RunContext: 'Server' } }, ctx);
    expect(fake.seen[1].json).toEqual({ engineInstance: { Details: { Script: { Enabled: false, RunContext: 'Server' } } } });
  });

  it('refuses what the Instance API cannot write, before sending anything', async () => {
    const { ctx } = makeCtx(home);
    expect(Object.keys(WRITABLE_CLASSES).sort()).toEqual(['Folder', 'LocalScript', 'ModuleScript', 'Script']);
    let err = errorOf(await runCloudTool({ action: 'instance', op: 'update', instance_id: 'p1', class_name: 'Part', properties: { Anchored: true } }, ctx));
    expect(err.message).toContain('run tool');
    err = errorOf(await runCloudTool({ action: 'instance', op: 'update', instance_id: 'ms1', class_name: 'ModuleScript', properties: { Enabled: true } }, ctx));
    expect(err.message).toContain('"Enabled" is not a property');
    err = errorOf(await runCloudTool({ action: 'instance', op: 'update', instance_id: 's1', class_name: 'Script', properties: { RunContext: 'Everywhere' } }, ctx));
    expect(err.message).toContain('RunContext');
    err = errorOf(await runCloudTool({ action: 'instance', op: 'update', class_name: 'Script', properties: { Source: 'x' } }, ctx));
    expect(err.message).toContain('root');
    expect(errorOf(await runCloudTool({ action: 'instance', op: 'update', instance_id: 's1' }, ctx)).message).toContain('class_name');
    expect(fake.seen).toHaveLength(0);
  });

  it('reports a failed operation as task_failed and a slow one as pending', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { path: OP, done: true, error: { code: 3, message: 'Source too large' } } }));
    const err = errorOf(await runCloudTool({ action: 'instance', op: 'update', instance_id: 'ms1', class_name: 'ModuleScript', properties: { Source: 'x' } }, ctx));
    expect(err.code).toBe('task_failed');
    expect(err.message).toContain('Source too large');

    fake.reset();
    fake.respond(() => ({ body: { path: OP, done: false } }));
    const value = parse(await runCloudTool({ action: 'instance', op: 'get', timeout_ms: 1000 }, ctx));
    expect(value).toMatchObject({ pending: true, operation: OP });
  });
});

// ---------------------------------------------------------------------------
describe('notify', () => {
  it('posts to the RECIPIENT path with the universe as a resource path and tagged parameters', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { path: 'users/42/notifications/abc', id: 'abc' } }));
    const value = parse(
      await runCloudTool(
        { action: 'notify', id: 42, message_id: '5dd7024b-68e3', parameters: { points: '5', 'userId-friend': 3702832553 }, launch_data: 'room=7', analytics_category: 'Bronze egg' },
        ctx,
      ),
    );
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: '/cloud/v2/users/42/notifications' });
    expect(fake.seen[0].json).toEqual({
      source: { universe: 'universes/111' },
      payload: {
        type: 'MOMENT',
        messageId: '5dd7024b-68e3',
        parameters: { points: { stringValue: '5' }, 'userId-friend': { int64Value: 3702832553 } },
        joinExperience: { launchData: 'room=7' },
        analyticsData: { category: 'Bronze egg' },
      },
    });
    expect(value).toMatchObject({ sent: true, user_id: 42, id: 'abc' });
    expect(String(value.note)).toMatch(/not delivered/);
  });

  it('validates the recipient, template, parameter types and launch data size', async () => {
    const { ctx } = makeCtx(home);
    expect(errorOf(await runCloudTool({ action: 'notify', message_id: 'm' }, ctx)).message).toContain('id');
    expect(errorOf(await runCloudTool({ action: 'notify', id: 42 }, ctx)).message).toContain('message_id');
    expect(errorOf(await runCloudTool({ action: 'notify', id: 42, message_id: 'm', launch_data: 'x'.repeat(201) }, ctx)).message).toContain('200');
    expect(() => parameterValues({ n: 1.5 })).toThrow(/integer/);
    expect(() => parameterValues({ n: true })).toThrow(/string or an integer/);
    expect(fake.seen).toHaveLength(0);
  });

  it('explains a recipient who has not opted in, which Roblox checks on send', async () => {
    // The live answer, verbatim apart from the ids.
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 400, body: { code: 'FAILED_PRECONDITION', message: 'User 42 is not opted in to receive notifications for your experience 111.' } }));
    const err = errorOf(await runCloudTool({ action: 'notify', id: 42, message_id: 'm' }, ctx));
    expect(err.code).toBe('bad_request');
    expect(err.not_opted_in).toBe(true);
    expect(err.message).toContain('PromptOptIn');
    expect(fake.seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('info reads added with this surface', () => {
  it('lists memberships and roles of the owning group', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { groupMemberships: [] } }));
    await runCloudTool({ action: 'info', what: 'memberships', filter: "role == 'groups/333/roles/1'" }, ctx);
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/cloud/v2/groups/333/memberships', query: { filter: "role == 'groups/333/roles/1'" } });
    await runCloudTool({ action: 'info', what: 'roles', page_size: 20 }, ctx);
    expect(fake.seen[1]).toMatchObject({ method: 'GET', path: '/cloud/v2/groups/333/roles', query: { maxPageSize: '20' } });
    expect(errorOf(await runCloudTool({ action: 'info', what: 'roles', page_size: 21 }, ctx)).message).toContain('20');
  });

  it('reads a user inventory and a subscription (FULL view, subscription id = user id)', async () => {
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: { inventoryItems: [] } }));
    const inv = parse(await runCloudTool({ action: 'info', what: 'inventory', id: 42 }, ctx));
    expect(fake.seen[0]).toMatchObject({ method: 'GET', path: '/cloud/v2/users/42/inventory-items' });
    expect(String(inv.filter_hint)).toContain('inventoryItemAssetTypes');

    fake.respond(() => ({ body: { active: true, willRenew: true } }));
    const sub = parse(await runCloudTool({ action: 'info', what: 'subscription', product_id: 9, id: 42 }, ctx));
    expect(fake.seen[1]).toMatchObject({ method: 'GET', path: '/cloud/v2/universes/111/subscription-products/9/subscriptions/42', query: { view: 'FULL' } });
    expect(sub).toMatchObject({ product_id: 9, user_id: 42, active: true });

    expect(errorOf(await runCloudTool({ action: 'info', what: 'subscription', id: 42 }, ctx)).message).toContain('product_id');
    expect(errorOf(await runCloudTool({ action: 'info', what: 'inventory' }, ctx)).message).toContain('id');
  });

  it('names the key-type limit on Users endpoints in either of Roblox’s wordings, instead of blaming the key', async () => {
    // Live, a group-owned key holding user.inventory-item:read got exactly this 401 on inventory.
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ status: 401, body: { code: 'UNAUTHENTICATED', message: 'Authentication type provided was invalid!' } }));
    const err = errorOf(await runCloudTool({ action: 'info', what: 'inventory', id: 42 }, ctx));
    expect(err.code).toBe('unauthorized');
    expect(err.key_type_limit).toBe(true);
    expect(err.message).toContain('USER-owned');
    expect(err.message).not.toMatch(/mistyped|revoked/);
  });
});

// ---------------------------------------------------------------------------
describe('empty listings', () => {
  it('always returns the list field, so an empty universe reads as zero stores rather than a missing answer', async () => {
    // Live, List Data Stores on a universe with none answered {}: the result carried no dataStores field at all.
    const { ctx } = makeCtx(home);
    fake.respond(() => ({ body: {} }));
    expect(parse(await runCloudTool({ action: 'datastore', op: 'list_stores' }, ctx)).dataStores).toEqual([]);
    expect(parse(await runCloudTool({ action: 'datastore', op: 'list_entries', store: 'S' }, ctx)).dataStoreEntries).toEqual([]);
    expect(parse(await runCloudTool({ action: 'ordered', op: 'list', store: 'S' }, ctx)).orderedDataStoreEntries).toEqual([]);

    fake.respond(() => ({ body: { dataStores: [{ id: 'PlayerData' }], nextPageToken: 't' } }));
    expect(parse(await runCloudTool({ action: 'datastore', op: 'list_stores' }, ctx))).toMatchObject({ dataStores: [{ id: 'PlayerData' }], nextPageToken: 't' });
  });
});
