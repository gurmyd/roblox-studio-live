import { badRequest } from './errors.js';
import type { HttpClient } from './http.js';
import { universeFrom } from './ids.js';
import type { CloudArgs } from './schema.js';
import { CLOUD_V2, asObject, enc, need, stringField } from './shared.js';
import type { ActionOutcome, CloudContext } from './types.js';

/**
 * Memory stores — sorted maps and queues (https://create.roblox.com/docs/cloud/reference,
 * MemoryStoreSortedMapItem / MemoryStoreQueueItem). This is the fast, short-lived cross-server
 * state that datastores are the wrong tool for: matchmaking queues, live leaderboards, locks.
 *
 * Two shapes that are easy to get wrong and are handled here so an agent cannot:
 *   - a sorted map item's payload field is `value`, a queue item's is `data`;
 *   - `ttl` and `invisibilityWindow` are protobuf duration STRINGS ("300s"), never numbers,
 *     so the tool takes plain seconds and formats them.
 *
 * Deliberately not exposed: POST …/memory-store:flush. It wipes every sorted map AND every queue
 * in the universe at once, has no per-structure form, and no agent should be one argument away
 * from it. Run it from Creator Hub if you really mean it.
 */
const MEMORY = 'memory-store';
/** Sorted map list caps at 100 and, left unset, returns exactly ONE item — which reads like an empty map. */
const MAP_PAGE_MAX = 100;
const MAP_PAGE_DEFAULT = 100;
/** Queue read caps at 200 items; unspecified means 1. */
const QUEUE_COUNT_MAX = 200;

export const MEMORY_OPS = ['map_list', 'map_get', 'map_set', 'map_delete', 'queue_add', 'queue_read', 'queue_discard'] as const;

/** Open Cloud wants a protobuf duration; agents pass whole seconds. */
function duration(seconds: number, name: string): string {
  if (!Number.isFinite(seconds) || seconds <= 0) throw badRequest(`${name} must be a positive number of seconds`);
  return `${Math.ceil(seconds)}s`;
}

function clampPageSize(requested: number | undefined, max: number, fallback: number): { value: number; note?: string } {
  if (requested === undefined) return { value: fallback };
  if (requested > max) return { value: max, note: `page_size ${requested} lowered to the ${max} this endpoint allows` };
  return { value: requested };
}

/** `sort_key` is a number or a string; Open Cloud has a separate field for each. */
function sortKeyFields(sortKey: string | number | undefined): Record<string, unknown> {
  if (sortKey === undefined) return {};
  return typeof sortKey === 'number' ? { numericSortKey: sortKey } : { stringSortKey: sortKey };
}

export async function memory(a: CloudArgs, ctx: CloudContext, http: HttpClient): Promise<ActionOutcome> {
  const op = need(a.op, 'op', `for memory: ${MEMORY_OPS.join(' | ')}`);
  const u = universeFrom(a, ctx);
  const store = need(a.store, 'store', 'for memory ops (the sorted map or queue name — it is created by its first write, exactly like MemoryStoreService:GetSortedMap/GetQueue)');
  const base = `${CLOUD_V2}/universes/${u.universeId}/${MEMORY}`;
  const context = { universe_id: u.universeId, ids_from: u.from, store };

  switch (op) {
    // ---- sorted maps -----------------------------------------------------
    case 'map_list': {
      // GET …/memory-store/sorted-maps/{id}/items?maxPageSize&pageToken&filter&orderBy
      // maxPageSize is sent explicitly on every call: the service default is 1, which looks like
      // an almost-empty map to anything that does not read nextPageToken.
      const page = clampPageSize(a.page_size, MAP_PAGE_MAX, MAP_PAGE_DEFAULT);
      const res = await http.request({
        method: 'GET',
        path: `${base}/sorted-maps/${enc(store)}/items`,
        query: { maxPageSize: page.value, pageToken: a.page_token, filter: a.filter, orderBy: a.order_by },
        idempotent: true,
      });
      return {
        value: {
          ...context,
          page_size: page.value,
          ...(page.note ? { page_size_note: page.note } : {}),
          ...asObject(res.body),
          ...(a.filter ? {} : { filter_hint: 'filter addresses the sort key as `sortKey` (e.g. `sortKey > 100`, `id > "k-001"`), not numericSortKey/stringSortKey; only < > && are supported.' }),
        },
      };
    }
    case 'map_get': {
      const key = need(a.key, 'key', 'for memory map_get');
      // GET …/sorted-maps/{id}/items/{item_id}
      const res = await http.request({ method: 'GET', path: `${base}/sorted-maps/${enc(store)}/items/${enc(key)}`, idempotent: true });
      return { value: { ...context, key, ...asObject(res.body) } };
    }
    case 'map_set': {
      const key = need(a.key, 'key', 'for memory map_set');
      if (a.value === undefined) throw badRequest('value is required for memory map_set (any JSON value)');
      // PATCH …/sorted-maps/{id}/items/{item_id}?allowMissing=true
      // The operation takes no updateMask, so it replaces the whole item: every field you want
      // kept has to be sent again. Said plainly in the result rather than left to surprise.
      const res = await http.request({
        method: 'PATCH',
        path: `${base}/sorted-maps/${enc(store)}/items/${enc(key)}`,
        query: { allowMissing: true },
        json: { value: a.value, ...(a.ttl_s !== undefined ? { ttl: duration(a.ttl_s, 'ttl_s') } : {}), ...sortKeyFields(a.sort_key) },
        idempotent: true,
      });
      return {
        value: {
          ...context,
          key,
          ...asObject(res.body),
          note: 'Sorted map writes replace the whole item (the endpoint has no update mask): a value, ttl_s or sort_key you did not pass is now unset.',
        },
      };
    }
    case 'map_delete': {
      const key = need(a.key, 'key', 'for memory map_delete');
      // DELETE …/sorted-maps/{id}/items/{item_id} → 200 with an empty body.
      await http.request({ method: 'DELETE', path: `${base}/sorted-maps/${enc(store)}/items/${enc(key)}`, idempotent: true });
      return { value: { ...context, key, deleted: true } };
    }

    // ---- queues ----------------------------------------------------------
    case 'queue_add': {
      if (a.value === undefined) throw badRequest('value is required for memory queue_add (any JSON value; it is sent as the queue item’s `data`)');
      // POST …/memory-store/queues/{id}/items   body { data, priority?, ttl? }
      // The payload field is `data` here and `value` on sorted maps; the tool takes `value` for
      // both so an agent never has to remember which side of the API it is on.
      const res = await http.request({
        method: 'POST',
        path: `${base}/queues/${enc(store)}/items`,
        json: { data: a.value, ...(a.priority !== undefined ? { priority: a.priority } : {}), ...(a.ttl_s !== undefined ? { ttl: duration(a.ttl_s, 'ttl_s') } : {}) },
      });
      return { value: { ...context, added: true, ...asObject(res.body) } };
    }
    case 'queue_read': {
      if (a.count !== undefined && a.count > QUEUE_COUNT_MAX) throw badRequest(`count is ${a.count}; memory store queue reads return at most ${QUEUE_COUNT_MAX} items`);
      // GET …/queues/{id}/items:read?count&allOrNothing&invisibilityWindow  — a GET despite the verb.
      const res = await http.request({
        method: 'GET',
        path: `${base}/queues/${enc(store)}/items:read`,
        query: {
          count: a.count,
          allOrNothing: a.all_or_nothing,
          invisibilityWindow: a.invisibility_s !== undefined ? duration(a.invisibility_s, 'invisibility_s') : undefined,
        },
        idempotent: true,
      });
      const body = asObject(res.body);
      // The spec says `items` / `readId`; community reports of the live service answering
      // `queueItems` are on record, so read either rather than silently returning nothing.
      const items = Array.isArray(body.items) ? body.items : Array.isArray(body.queueItems) ? body.queueItems : [];
      const readId = stringField(body, 'readId') ?? stringField(body, 'id');
      return {
        value: {
          ...context,
          items,
          count: items.length,
          ...(readId ? { read_id: readId } : {}),
          ...(readId ? {} : { read_id_missing: 'the service returned no readId, so these items cannot be discarded; they reappear when the invisibility window ends' }),
          note: readId
            ? `Reading does not remove items: they are invisible to other readers for the invisibility window (default applies when invisibility_s is unset), then come back. Call memory queue_discard with read_id "${readId}" once you have processed them.`
            : 'Reading does not remove items; they reappear when the invisibility window ends.',
          raw_keys: Object.keys(body),
        },
      };
    }
    case 'queue_discard': {
      const readId = need(a.read_id, 'read_id', 'for memory queue_discard (the read_id returned by queue_read — there is no per-item acknowledgement)');
      // POST …/queues/{id}/items:discard   body { readId } → 200 with an empty body.
      await http.request({ method: 'POST', path: `${base}/queues/${enc(store)}/items:discard`, json: { readId } });
      return { value: { ...context, discarded: true, read_id: readId } };
    }
    default:
      throw badRequest(`op "${op}" is not a memory op (use ${MEMORY_OPS.join(' | ')})`);
  }
}
