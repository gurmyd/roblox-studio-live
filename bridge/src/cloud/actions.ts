import fsp from 'node:fs/promises';
import path from 'node:path';
import { CloudError, badRequest } from './errors.js';
import { REQUEST_TIMEOUT_MS, type HttpClient } from './http.js';
import { creatorFrom, ownerIdOfType, placeFrom, universeFrom, type Creator } from './ids.js';
import { probeKey } from './probe.js';
import { MAX_WAIT_MS, type CloudArgs } from './schema.js';
import { ASSETS_V1, CLOUD_V2, DEFAULT_WAIT_MS, asObject, enc, need, stringField } from './shared.js';
import type { ActionDeps, ActionOutcome, CloudContext } from './types.js';

/**
 * The core actions (datastore, ordered, message, info, asset_upload, luau). Every endpoint
 * below is taken from the official reference (URL cited above each call); all paths are
 * relative to https://apis.roblox.com. Later surfaces live in their own modules and are
 * wired into `dispatch` at the bottom of this file.
 */
/** publishMessage: message ≤ 1 KB (https://create.roblox.com/docs/cloud/guides/usage-messaging). */
const MESSAGE_MAX_BYTES = 1024;
const MAX_LOG_PAGES = 5;
const LUAU_PENDING_STATES = new Set(['QUEUED', 'PROCESSING']);

function userPaths(users: number[] | undefined): { users: string[] } | Record<string, never> {
  // DataStoreEntry.users holds resource paths "users/{id}" (https://create.roblox.com/docs/cloud/reference/DataStoreEntry).
  return users ? { users: users.map((id) => `users/${id}`) } : {};
}

// ---------------------------------------------------------------------------
// datastore
// ---------------------------------------------------------------------------

async function datastore(a: CloudArgs, ctx: CloudContext, http: HttpClient): Promise<ActionOutcome> {
  const op = need(a.op, 'op', 'for datastore: list_stores | list_entries | get | set | delete | increment');
  const u = universeFrom(a, ctx);
  const universe = `${CLOUD_V2}/universes/${u.universeId}`;
  const context = { universe_id: u.universeId, ids_from: u.from };

  if (op === 'list_stores') {
    // https://create.roblox.com/docs/cloud/reference/DataStore — List Data Stores:
    // GET /cloud/v2/universes/{universe_id}/data-stores?maxPageSize&pageToken&filter&showDeleted → { dataStores: [...], nextPageToken }
    const res = await http.request({
      method: 'GET',
      path: `${universe}/data-stores`,
      query: { maxPageSize: a.page_size, pageToken: a.page_token, filter: a.filter, showDeleted: a.show_deleted },
      idempotent: true,
    });
    return { value: { ...context, ...asObject(res.body) } };
  }

  const store = need(a.store, 'store', 'for datastore ops');
  // Scoped entries live under /scopes/{scope_id}; without a scope Roblox uses the default "global" scope
  // (https://create.roblox.com/docs/cloud/reference/DataStoreEntry).
  const entries = `${universe}/data-stores/${enc(store)}${a.scope ? `/scopes/${enc(a.scope)}` : ''}/entries`;
  const entryContext = { ...context, store, scope: a.scope ?? 'global' };

  switch (op) {
    case 'list_entries': {
      // https://create.roblox.com/docs/cloud/reference/DataStoreEntry — List Data Store Entries:
      // GET …/entries?maxPageSize(≤256)&pageToken&filter=id.startsWith("x")&showDeleted → { dataStoreEntries: [{path,id}], nextPageToken }
      const res = await http.request({
        method: 'GET',
        path: entries,
        query: { maxPageSize: a.page_size, pageToken: a.page_token, filter: a.filter, showDeleted: a.show_deleted },
        idempotent: true,
      });
      return { value: { ...entryContext, ...asObject(res.body) } };
    }
    case 'get': {
      const key = need(a.key, 'key', 'for datastore get');
      // https://create.roblox.com/docs/cloud/reference/DataStoreEntry — Get Data Store Entry:
      // GET …/entries/{entry_id} → DataStoreEntry { path, id, value, etag, revisionId, revisionCreateTime, createTime, state, users, attributes }
      const res = await http.request({ method: 'GET', path: `${entries}/${enc(key)}`, idempotent: true });
      return { value: { ...entryContext, key, ...asObject(res.body) } };
    }
    case 'set': {
      const key = need(a.key, 'key', 'for datastore set');
      if (a.value === undefined) throw badRequest('value is required for datastore set (any JSON value)');
      // https://create.roblox.com/docs/cloud/reference/DataStoreEntry — Update Data Store Entry (upsert):
      // PATCH …/entries/{entry_id}?allowMissing=true  body DataStoreEntry { value, etag?, users?, attributes? } → DataStoreEntry.
      // The reference notes partial updates are unsupported: omitted users/attributes are cleared; `etag` makes the write conditional.
      const res = await http.request({
        method: 'PATCH',
        path: `${entries}/${enc(key)}`,
        query: { allowMissing: true },
        json: { value: a.value, ...(a.etag ? { etag: a.etag } : {}), ...userPaths(a.users), ...(a.attributes ? { attributes: a.attributes } : {}) },
        idempotent: true,
      });
      return { value: { ...entryContext, key, ...asObject(res.body) } };
    }
    case 'delete': {
      const key = need(a.key, 'key', 'for datastore delete');
      // https://create.roblox.com/docs/cloud/reference/DataStoreEntry — Delete Data Store Entry:
      // DELETE …/entries/{entry_id} → 200 (entry state becomes DELETED; purged after 30 days)
      await http.request({ method: 'DELETE', path: `${entries}/${enc(key)}`, idempotent: true });
      return { value: { ...entryContext, key, deleted: true } };
    }
    case 'increment': {
      const key = need(a.key, 'key', 'for datastore increment');
      // The reference: "Both the existing value and the increment amount must be integers."
      if (typeof a.amount !== 'number' || !Number.isInteger(a.amount)) throw badRequest('amount must be an integer for datastore increment (the entry value must be an integer too)');
      // https://create.roblox.com/docs/cloud/reference/DataStoreEntry — Increment Data Store Entry:
      // POST …/entries/{entry_id}:increment  body { amount, users?, attributes? } → DataStoreEntry
      const res = await http.request({
        method: 'POST',
        path: `${entries}/${enc(key)}:increment`,
        json: { amount: a.amount, ...userPaths(a.users), ...(a.attributes ? { attributes: a.attributes } : {}) },
      });
      return { value: { ...entryContext, key, ...asObject(res.body) } };
    }
    default:
      throw badRequest(`op "${op}" is not a datastore op (use list_stores | list_entries | get | set | delete | increment)`);
  }
}

// ---------------------------------------------------------------------------
// ordered data store
// ---------------------------------------------------------------------------

async function ordered(a: CloudArgs, ctx: CloudContext, http: HttpClient): Promise<ActionOutcome> {
  const op = need(a.op, 'op', 'for ordered: list | get | set | delete | increment');
  const u = universeFrom(a, ctx);
  const store = need(a.store, 'store', 'for ordered ops');
  const scope = a.scope ?? 'global';
  // https://create.roblox.com/docs/cloud/reference/OrderedDataStoreEntry — entries live at
  // /cloud/v2/universes/{universe_id}/ordered-data-stores/{ordered_data_store_id}/scopes/{scope_id}/entries[/{entry_id}]
  const entries = `${CLOUD_V2}/universes/${u.universeId}/ordered-data-stores/${enc(store)}/scopes/${enc(scope)}/entries`;
  const context = { universe_id: u.universeId, ids_from: u.from, store, scope };

  switch (op) {
    case 'list': {
      // List Ordered Data Store Entries: GET …/entries?maxPageSize(≤100)&pageToken&orderBy="value desc"&filter="entry >= 10 && entry <= 30"
      // → { orderedDataStoreEntries: [{ path, value, id }], nextPageToken }
      const res = await http.request({
        method: 'GET',
        path: entries,
        query: { maxPageSize: a.page_size, pageToken: a.page_token, orderBy: a.order_by, filter: a.filter },
        idempotent: true,
      });
      return { value: { ...context, ...asObject(res.body) } };
    }
    case 'get': {
      const key = need(a.key, 'key', 'for ordered get');
      // Get Ordered Data Store Entry: GET …/entries/{entry_id} → { path, value, id }
      const res = await http.request({ method: 'GET', path: `${entries}/${enc(key)}`, idempotent: true });
      return { value: { ...context, key, ...asObject(res.body) } };
    }
    case 'set': {
      const key = need(a.key, 'key', 'for ordered set');
      if (typeof a.value !== 'number' || !Number.isInteger(a.value)) throw badRequest('value must be an integer for ordered set');
      // Update Ordered Data Store Entry (upsert): PATCH …/entries/{entry_id}?allowMissing=true  body { value } → entry
      const res = await http.request({ method: 'PATCH', path: `${entries}/${enc(key)}`, query: { allowMissing: true }, json: { value: a.value }, idempotent: true });
      return { value: { ...context, key, ...asObject(res.body) } };
    }
    case 'delete': {
      const key = need(a.key, 'key', 'for ordered delete');
      // Delete Ordered Data Store Entry: DELETE …/entries/{entry_id} → 200
      await http.request({ method: 'DELETE', path: `${entries}/${enc(key)}`, idempotent: true });
      return { value: { ...context, key, deleted: true } };
    }
    case 'increment': {
      const key = need(a.key, 'key', 'for ordered increment');
      if (typeof a.amount !== 'number' || !Number.isInteger(a.amount)) throw badRequest('amount must be an integer for ordered increment');
      // Increment Ordered Data Store Entry: POST …/entries/{entry_id}:increment  body { amount } → entry
      const res = await http.request({ method: 'POST', path: `${entries}/${enc(key)}:increment`, json: { amount: a.amount } });
      return { value: { ...context, key, ...asObject(res.body) } };
    }
    default:
      throw badRequest(`op "${op}" is not an ordered op (use list | get | set | delete | increment)`);
  }
}

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------

async function message(a: CloudArgs, ctx: CloudContext, http: HttpClient): Promise<ActionOutcome> {
  const topic = need(a.topic, 'topic', 'for message (≤ 80 chars)');
  if (a.message === undefined) throw badRequest('message is required (a string, or JSON which is sent stringified)');
  const text = typeof a.message === 'string' ? a.message : JSON.stringify(a.message);
  const bytes = Buffer.byteLength(text);
  if (bytes > MESSAGE_MAX_BYTES) throw badRequest(`message is ${bytes} bytes; Open Cloud publishMessage allows at most 1 KB (${MESSAGE_MAX_BYTES} bytes)`);
  const u = universeFrom(a, ctx);
  // https://create.roblox.com/docs/cloud/reference/Universe — Publish Universe Message:
  // POST /cloud/v2/universes/{universe_id}:publishMessage  body { topic, message } → 200 with an empty body
  await http.request({ method: 'POST', path: `${CLOUD_V2}/universes/${u.universeId}:publishMessage`, json: { topic, message: text } });
  return {
    value: {
      universe_id: u.universeId,
      ids_from: u.from,
      published: true,
      topic,
      bytes,
      note: 'Delivered to MessagingService:SubscribeAsync(topic) in live servers of this universe; Studio playtests do not receive it.',
    },
  };
}

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

async function info(a: CloudArgs, ctx: CloudContext, http: HttpClient, deps: ActionDeps): Promise<ActionOutcome> {
  const what = need(a.what, 'what', 'for info: universe | place | group | user | me | key');
  const get = async (p: string): Promise<Record<string, unknown>> => asObject((await http.request({ method: 'GET', path: p, idempotent: true })).body);
  switch (what) {
    case 'key':
      // No Open Cloud endpoint describes a key, so this one is measured by probing (probe.ts).
      return probeKey(a, ctx, http, deps.keySource);
    case 'universe': {
      const u = universeFrom(a, ctx);
      // https://create.roblox.com/docs/cloud/reference/Universe — Get Universe: GET /cloud/v2/universes/{universe_id}
      // → { path, createTime, updateTime, displayName, description, user|group, visibility, rootPlace, ageRating, … }
      return { value: { what, universe_id: u.universeId, ids_from: u.from, ...(await get(`${CLOUD_V2}/universes/${u.universeId}`)) } };
    }
    case 'place': {
      const p = placeFrom(a, ctx);
      // https://create.roblox.com/docs/cloud/reference/Place — Get Place: GET /cloud/v2/universes/{universe_id}/places/{place_id}
      // → { path, createTime, updateTime, displayName, description, serverSize, root, … }
      return { value: { what, universe_id: p.universeId, place_id: p.placeId, ids_from: p.from, ...(await get(`${CLOUD_V2}/universes/${p.universeId}/places/${p.placeId}`)) } };
    }
    case 'group': {
      const id = ownerIdOfType('Group', a.id, ctx);
      // https://create.roblox.com/docs/cloud/reference/Group — Get Group: GET /cloud/v2/groups/{group_id}
      // → { path, createTime, updateTime, id, displayName, description, owner, memberCount, publicEntryAllowed, locked, verified }
      return { value: { what, group_id: id, ids_from: a.id ? 'args' : 'studio', ...(await get(`${CLOUD_V2}/groups/${id}`)) } };
    }
    case 'user': {
      const id = ownerIdOfType('User', a.id, ctx);
      // https://create.roblox.com/docs/cloud/reference/User — Get User: GET /cloud/v2/users/{user_id}
      // → { path, createTime, id, name, displayName, about, locale, premium, idVerified, socialNetworkProfiles }
      return { value: { what, user_id: id, ids_from: a.id ? 'args' : 'studio', ...(await get(`${CLOUD_V2}/users/${id}`)) } };
    }
    case 'me': {
      // "me" = the owner of the open place (the API key itself has no identity endpoint).
      const creator = creatorFrom(undefined, ctx);
      const p = creator.type === 'Group' ? `${CLOUD_V2}/groups/${creator.id}` : `${CLOUD_V2}/users/${creator.id}`;
      return { value: { what, creator, ids_from: 'studio', ...(await get(p)) } };
    }
    default:
      throw badRequest(`what "${String(what)}" is not supported (use universe | place | group | user | me)`);
  }
}

// ---------------------------------------------------------------------------
// asset upload
// ---------------------------------------------------------------------------

/** File formats accepted by Create Asset (https://create.roblox.com/docs/cloud/guides/usage-assets, "Supported asset types"). */
const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.tga': 'image/tga',
  '.fbx': 'model/fbx',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.rbxm': 'model/x-rbxm',
  '.rbxmx': 'model/x-rbxm',
  '.mp4': 'video/mp4',
  '.mov': 'video/mov',
};
/**
 * assetType values documented for Create Asset (Audio, Decal, Model, Video in the v1 reference;
 * Image in the feature page; Animation and Mesh in the usage guide's supported types). The value
 * is case-sensitive on the server, so lower-case spellings are normalised to these.
 */
export const ASSET_TYPES = ['Audio', 'Decal', 'Image', 'Model', 'Video', 'Animation', 'Mesh'];
/** Upload budget: 30 s base + 1 s per 100 KB (≈ 0.8 Mbit/s floor), raised by timeout_ms, capped at MAX_WAIT_MS. */
const UPLOAD_BYTES_PER_SECOND = 100 * 1024;

function normalizeAssetType(raw: string): string {
  const match = ASSET_TYPES.find((t) => t.toLowerCase() === raw.trim().toLowerCase());
  return match ?? raw.trim();
}

/** Per-attempt timeout for the multipart create-asset POST, so a large file on a slow uplink can finish. */
export function uploadTimeoutMs(bytes: number, waitMs: number): number {
  const scaled = REQUEST_TIMEOUT_MS + Math.ceil(bytes / UPLOAD_BYTES_PER_SECOND) * 1000;
  return Math.min(MAX_WAIT_MS, Math.max(waitMs, scaled));
}

/**
 * Assets v1 documents `moderationState` as `Reviewing | Rejected | Approved`; older examples show
 * `MODERATION_STATE_APPROVED`. Both are folded to `approved | reviewing | rejected` so an agent can
 * gate on one spelling; anything else is passed through lower-cased.
 */
export function normalizeModeration(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return raw.replace(/^MODERATION_STATE_/i, '').toLowerCase();
}

function creatorBody(creator: Creator): { userId: string } | { groupId: string } {
  return creator.type === 'User' ? { userId: String(creator.id) } : { groupId: String(creator.id) };
}

function operationIdOf(op: Record<string, unknown>): string | undefined {
  const explicit = stringField(op, 'operationId');
  if (explicit) return explicit;
  const p = stringField(op, 'path');
  if (!p) return undefined;
  const last = p.split('/').pop();
  return last && last !== '' ? last : undefined;
}

async function assetUpload(a: CloudArgs, ctx: CloudContext, http: HttpClient, deps: ActionDeps): Promise<ActionOutcome> {
  const started = deps.now();
  const deadline = started + (a.timeout_ms ?? DEFAULT_WAIT_MS);
  let op: Record<string, unknown>;
  let operationId: string | undefined;
  let upload: Record<string, unknown> = {};

  if (a.operation_id) {
    operationId = a.operation_id;
    op = { done: false };
  } else {
    const file = need(a.file, 'file', 'for asset_upload (absolute path)');
    if (!path.isAbsolute(file)) throw badRequest(`file must be an absolute path (got "${file}")`);
    const assetType = normalizeAssetType(need(a.asset_type, 'asset_type', `for asset_upload: ${ASSET_TYPES.join(' | ')}`));
    const name = need(a.name, 'name', 'for asset_upload (display name)');
    const ext = path.extname(file).toLowerCase();
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) throw badRequest(`unsupported file extension "${ext}"; supported: ${Object.keys(CONTENT_TYPES).join(' ')}`);
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(file);
    } catch (err) {
      throw badRequest(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const creator = creatorFrom(a.creator, ctx);
    const request = { assetType, displayName: name, description: a.description ?? '', creationContext: { creator: creatorBody(creator) } };
    const form = new FormData();
    form.append('request', JSON.stringify(request));
    form.append('fileContent', new Blob([bytes], { type: contentType }), path.basename(file));
    // https://create.roblox.com/docs/cloud/reference/features/assets + https://create.roblox.com/docs/cloud/guides/usage-assets — Create Asset:
    // POST /assets/v1/assets  multipart/form-data: request = JSON { assetType, displayName, description, creationContext: { creator: { userId | groupId } } },
    // fileContent = the file with its content type → Operation { path: "operations/{id}", operationId?, done, error?, response? }
    // Not idempotent (a replay would create a second asset), so the per-attempt timeout scales with the body instead.
    const timeoutMs = uploadTimeoutMs(bytes.length, a.timeout_ms ?? DEFAULT_WAIT_MS);
    op = asObject((await http.request({ method: 'POST', path: `${ASSETS_V1}/assets`, form, timeoutMs })).body);
    operationId = operationIdOf(op);
    upload = { file, bytes: bytes.length, content_type: contentType, asset_type: assetType, creator, upload_timeout_ms: timeoutMs };
  }

  let interval = 1000;
  while (op.done !== true) {
    if (!operationId) throw new CloudError('upload_failed', 'Open Cloud accepted the upload but returned no operation id to poll', { details: { response: op } });
    const now = deps.now();
    if (now >= deadline) {
      return {
        value: {
          ...upload,
          pending: true,
          operation_id: operationId,
          elapsed_ms: now - started,
          note: `Upload accepted but not finished within ${a.timeout_ms ?? DEFAULT_WAIT_MS} ms. Call cloud {action:"asset_upload", operation_id:"${operationId}"} to keep waiting.`,
        },
      };
    }
    await deps.sleep(Math.min(interval, deadline - now));
    interval = Math.min(interval + 500, 3000);
    // https://create.roblox.com/docs/cloud/reference/features/assets — Get Operation:
    // GET /assets/v1/operations/{operationId} → { path, done, error?: { code, message }, response?: Asset }
    op = asObject((await http.request({ method: 'GET', path: `${ASSETS_V1}/operations/${enc(operationId)}`, idempotent: true })).body);
  }

  const elapsed_ms = deps.now() - started;
  if (op.error !== undefined && op.error !== null) {
    const err = asObject(op.error);
    const reason = stringField(err, 'message') ?? JSON.stringify(op.error);
    return { isError: true, value: { error: { code: 'upload_failed', message: `Asset upload failed: ${reason}`, operation_error: op.error, operation_id: operationId, ...upload, elapsed_ms } } };
  }
  // Asset (response): { assetId, assetType, displayName, description, path, revisionId, revisionCreateTime, creationContext, moderationResult: { moderationState } }
  const asset = asObject(op.response);
  const rawId = asset.assetId;
  const assetId = typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : rawId;
  const moderationRaw = asObject(asset.moderationResult).moderationState;
  return {
    value: {
      asset_id: assetId ?? null,
      asset_type: asset.assetType ?? upload.asset_type ?? null,
      display_name: asset.displayName ?? null,
      moderation: normalizeModeration(moderationRaw),
      ...(typeof moderationRaw === 'string' ? { moderation_raw: moderationRaw } : {}),
      revision_id: asset.revisionId ?? null,
      path: asset.path ?? null,
      operation_id: operationId ?? null,
      ...upload,
      elapsed_ms,
      ...(assetId !== undefined && assetId !== null ? { use: `rbxassetid://${assetId}` } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// luau execution
// ---------------------------------------------------------------------------

async function fetchLogs(http: HttpClient, taskPath: string): Promise<{ messages: string[]; truncated: boolean; error?: string }> {
  const messages: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  try {
    do {
      // https://create.roblox.com/docs/cloud/reference/LuauExecutionSessionTaskLog — List Luau Execution Session Task Logs:
      // GET /cloud/v2/{task path}/logs?view=FLAT&maxPageSize&pageToken → { luauExecutionSessionTaskLogs: [{ path, messages: [...] }], nextPageToken }
      const res = await http.request({ method: 'GET', path: `${CLOUD_V2}/${taskPath}/logs`, query: { view: 'FLAT', pageToken }, idempotent: true });
      const body = asObject(res.body);
      const items = Array.isArray(body.luauExecutionSessionTaskLogs) ? (body.luauExecutionSessionTaskLogs as unknown[]) : [];
      for (const item of items) {
        const lines = asObject(item).messages;
        if (Array.isArray(lines)) for (const line of lines) messages.push(typeof line === 'string' ? line : JSON.stringify(line));
      }
      pageToken = stringField(body, 'nextPageToken');
      pages++;
    } while (pageToken && pages < MAX_LOG_PAGES);
    return { messages, truncated: pageToken !== undefined };
  } catch (err) {
    return { messages, truncated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function luau(a: CloudArgs, ctx: CloudContext, http: HttpClient, deps: ActionDeps): Promise<ActionOutcome> {
  const timeoutMs = a.timeout_ms ?? DEFAULT_WAIT_MS;
  const started = deps.now();
  let task: Record<string, unknown>;
  let taskPath: string;
  let place: Record<string, unknown> = {};

  const getTask = async (p: string): Promise<Record<string, unknown>> =>
    // https://create.roblox.com/docs/cloud/reference/LuauExecutionSessionTask — Get Luau Execution Session Task:
    // GET /cloud/v2/{task path} → { path, state: QUEUED | PROCESSING | CANCELLED | COMPLETE | FAILED, output?: { results }, error?: { code, message } }
    asObject((await http.request({ method: 'GET', path: `${CLOUD_V2}/${p}`, idempotent: true })).body);

  if (a.task) {
    if (!/^universes\/\d+\/places\/\d+\/.*luau-execution-session/.test(a.task)) {
      throw badRequest('task must be a task path returned by an earlier luau call (universes/…/places/…/luau-execution-sessions/…/tasks/…)');
    }
    taskPath = a.task;
    task = await getTask(taskPath);
  } else {
    const script = need(a.script, 'script', 'for luau (Luau source)');
    const p = placeFrom(a, ctx);
    place = { universe_id: p.universeId, place_id: p.placeId, ids_from: p.from };
    const seconds = Math.ceil(timeoutMs / 1000);
    // https://create.roblox.com/docs/cloud/reference/LuauExecutionSessionTask — Create Luau Execution Session Task:
    // POST /cloud/v2/universes/{universe_id}/places/{place_id}/luau-execution-session-tasks  body { script, timeout }
    // (`timeout` is a duration string such as "60s"; default and maximum 5 minutes; script ≤ 4 MB; ≤ 10 incomplete tasks per place)
    // → LuauExecutionSessionTask { path, state, createTime, … }
    const res = await http.request({
      method: 'POST',
      path: `${CLOUD_V2}/universes/${p.universeId}/places/${p.placeId}/luau-execution-session-tasks`,
      json: { script, timeout: `${seconds}s` },
    });
    task = asObject(res.body);
    const created = stringField(task, 'path');
    if (!created) throw new CloudError('internal', 'Open Cloud created the Luau task but returned no task path', { details: { response: task } });
    taskPath = created;
  }

  const deadline = started + timeoutMs + Math.min(10_000, timeoutMs);
  let interval = 500;
  while (typeof task.state === 'string' && LUAU_PENDING_STATES.has(task.state)) {
    const now = deps.now();
    if (now >= deadline) {
      return {
        value: {
          ...place,
          state: task.state,
          task: taskPath,
          pending: true,
          elapsed_ms: now - started,
          note: `Task still ${task.state} after ${now - started} ms. Call cloud {action:"luau", task:"${taskPath}"} to keep waiting (the server stops it after ${Math.ceil(timeoutMs / 1000)} s).`,
        },
      };
    }
    await deps.sleep(Math.min(interval, deadline - now));
    interval = Math.min(interval + 500, 2000);
    task = await getTask(taskPath);
  }

  const logs = await fetchLogs(http, taskPath);
  const elapsed_ms = deps.now() - started;
  const state = typeof task.state === 'string' ? task.state : 'UNKNOWN';
  const logFields = { logs: logs.messages, ...(logs.truncated ? { logs_truncated: true } : {}), ...(logs.error ? { logs_error: logs.error } : {}) };
  if (state === 'COMPLETE') {
    const output = asObject(task.output);
    return { value: { ...place, state, results: Array.isArray(output.results) ? output.results : [], ...logFields, task: taskPath, elapsed_ms } };
  }
  const err = asObject(task.error);
  const code = stringField(err, 'code');
  const reason = stringField(err, 'message');
  return {
    isError: true,
    value: {
      error: {
        code: 'task_failed',
        message: `Luau task ended ${state}${code ? ` (${code})` : ''}${reason ? `: ${reason}` : ''}`,
        state,
        task_error: task.error ?? null,
        ...logFields,
        task: taskPath,
        ...place,
        elapsed_ms,
      },
    },
  };
}

// ---------------------------------------------------------------------------

export async function dispatch(a: CloudArgs, ctx: CloudContext, http: HttpClient, deps: ActionDeps): Promise<ActionOutcome> {
  switch (a.action) {
    case 'datastore':
      return datastore(a, ctx, http);
    case 'ordered':
      return ordered(a, ctx, http);
    case 'message':
      return message(a, ctx, http);
    case 'info':
      return info(a, ctx, http, deps);
    case 'asset_upload':
      return assetUpload(a, ctx, http, deps);
    case 'luau':
      return luau(a, ctx, http, deps);
    default:
      throw badRequest(`unknown action ${String((a as { action: unknown }).action)}`);
  }
}
