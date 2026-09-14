import { CLOUD_V2, enc } from './shared.js';

/**
 * One table describing what every `cloud` call needs from the API key.
 *
 * It has two readers:
 *   - `permissionsFor` (run.ts) — names the exact Creator Hub permission in a 403 / no_api_key result;
 *   - the capability report (`info what:"key"`, probe.ts) — answers "what can this key actually do?"
 *     before an agent commits to a multi-step plan.
 *
 * The report reads the key's scopes from Roblox's key introspection endpoint
 * (POST /api-keys/v1/introspect) and judges each capability with `requires` and `binding` below —
 * writes included, since nothing has to be called to find out. When introspection is unavailable
 * it falls back to trial requests (`kind` / `request`): Roblox authorizes a leaf resource before
 * resolving it, so a probe aimed at a reserved name that cannot exist reads 403 as "scope missing"
 * and 404 as "scope present". That fallback is weaker — a universe the key is not bound to answers
 * 403 everywhere, and several reads need no scope at all — which is why introspection comes first.
 */
export type ProbeKind = 'read' | 'reversible' | 'none';
/** Which resource a held scope must name for it to count: this universe, the place owner, or nothing. */
export type Binding = 'universe' | 'creator' | 'none';

export interface ProbeIds {
  universeId?: number | undefined;
  placeId?: number | undefined;
  creatorType?: 'User' | 'Group' | undefined;
  creatorId?: number | undefined;
}

export interface ProbeRequest {
  method: 'GET' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface Capability {
  /** Stable id used in the report. */
  id: string;
  /** The calls this capability covers, as an agent would write them. */
  calls: string;
  /** Creator Hub "API System → scope" lines, exactly as `permissionsFor` reports them. */
  permissions: string[];
  /**
   * Scopes the call needs, as an AND of alternatives: every inner list must have one member held.
   * Alternatives exist because Roblox has shipped more than one spelling for some families (memory
   * stores most of all). An empty list means the call needs no scope.
   */
  requires: string[][];
  binding: Binding;
  /** Substrings naming this capability's scope family, to flag a spelling the table does not know. */
  family?: string[];
  /**
   * Roblox's Groups and Users endpoints answer 401 to a group-owned key whatever its scopes (measured
   * 2026-09-11), and introspection does not say who owns a key — so these stay `unknown` there.
   */
  userKeyOnly?: boolean;
  /**
   * Fallback probing only. `read` — a harmless GET settles it and runs by default.
   * `reversible` — only a write settles it, but a DELETE (or a read of an empty reserved queue)
   * against a reserved name is harmless; runs with deep:true. `none` — no harmless request exists.
   */
  kind: ProbeKind;
  /** Builds the fallback probe request, or null when the ids it needs are unknown. */
  request?(ids: ProbeIds): ProbeRequest | null;
  /** Why this capability cannot be probed by request (kind 'none'). */
  because?: string;
}

/**
 * Names reserved for probing. A DELETE against them is a no-op on any real data: the probe only
 * ever asks "would this have been allowed?", and a 404 answers that as well as a 204.
 */
export const PROBE_NAME = '__studio_live_probe__';

const ds = (scope: string): string => `Data Stores → ${scope}`;
const ordered = (scope: string): string => `Ordered Data Stores → ${scope}`;
const memoryStores = (scope: string): string => `Memory Stores → ${scope}`;

/**
 * Memory store scope spellings, per operation. First is the bare OpenAPI name — what a real key's
 * introspection returned (2026-09-14), so it is the one shown to users. The rest are on record and
 * still accepted: the same name with the `universe.` target prefix, the launch announcement's
 * camelCase scheme, and a hyphenated item form a working key was reported to carry (2026-05-14).
 */
const MEMORY_FAMILY = ['memory-store', 'memoryStores'];
const mapRead = ['memory-store.sorted-map:read', 'universe.memory-store.sorted-map:read', 'memoryStores:sortedMap:read', 'universe.memory-store-sorted-map-item:read'];
const mapWrite = ['memory-store.sorted-map:write', 'universe.memory-store.sorted-map:write', 'memoryStores:sortedMap:write', 'universe.memory-store-sorted-map-item:write'];
const queueDequeue = ['memory-store.queue:dequeue', 'universe.memory-store.queue:dequeue', 'memoryStores:queue:readQueueItem', 'universe.memory-store-queue-item:read'];
const queueAdd = ['memory-store.queue:add', 'universe.memory-store.queue:add', 'memoryStores:queue:createQueueItem', 'universe.memory-store-queue-item:write'];
const queueDiscard = ['memory-store.queue:discard', 'universe.memory-store.queue:discard', 'memoryStores:queue:discardQueueItem', 'universe.memory-store-queue-item:delete'];

function universePath(ids: ProbeIds, suffix: string): string | null {
  return ids.universeId ? `${CLOUD_V2}/universes/${ids.universeId}${suffix}` : null;
}

/**
 * Capabilities in the order the report lists them. Scope strings are the ones printed in the
 * official reference for each operation (docs/cloud.md §1.3 carries the same table).
 */
export const CAPABILITIES: Capability[] = [
  {
    id: 'datastore.list',
    calls: 'datastore list_stores',
    permissions: [ds('universe-datastores.control:list')],
    requires: [['universe-datastores.control:list']],
    binding: 'universe',
    kind: 'read',
    request: (ids) => {
      const path = universePath(ids, '/data-stores');
      return path ? { method: 'GET', path, query: { maxPageSize: 1 } } : null;
    },
  },
  {
    id: 'datastore.listEntries',
    calls: 'datastore list_entries',
    permissions: [ds('universe-datastores.objects:list')],
    requires: [['universe-datastores.objects:list']],
    binding: 'universe',
    kind: 'read',
    request: (ids) => {
      const path = universePath(ids, `/data-stores/${enc(PROBE_NAME)}/entries`);
      return path ? { method: 'GET', path, query: { maxPageSize: 1 } } : null;
    },
  },
  {
    id: 'datastore.read',
    calls: 'datastore get',
    permissions: [ds('universe-datastores.objects:read')],
    requires: [['universe-datastores.objects:read']],
    binding: 'universe',
    kind: 'read',
    request: (ids) => {
      const path = universePath(ids, `/data-stores/${enc(PROBE_NAME)}/entries/${enc(PROBE_NAME)}`);
      return path ? { method: 'GET', path } : null;
    },
  },
  {
    id: 'datastore.set',
    calls: 'datastore set',
    permissions: [ds('universe-datastores.objects:update'), ds('universe-datastores.objects:create (for keys that do not exist yet)')],
    // update is what every set needs; create is needed only for a key that does not exist yet.
    requires: [['universe-datastores.objects:update']],
    binding: 'universe',
    kind: 'none',
    because: 'a probe write would create a real data store entry',
  },
  {
    id: 'datastore.increment',
    calls: 'datastore increment',
    permissions: [ds('universe-datastores.objects:create'), ds('universe-datastores.objects:update')],
    requires: [['universe-datastores.objects:create'], ['universe-datastores.objects:update']],
    binding: 'universe',
    kind: 'none',
    because: 'a probe increment would create or change a real data store entry',
  },
  {
    id: 'datastore.delete',
    calls: 'datastore delete',
    permissions: [ds('universe-datastores.objects:delete')],
    requires: [['universe-datastores.objects:delete']],
    binding: 'universe',
    kind: 'reversible',
    request: (ids) => {
      const path = universePath(ids, `/data-stores/${enc(PROBE_NAME)}/entries/${enc(PROBE_NAME)}`);
      return path ? { method: 'DELETE', path } : null;
    },
  },
  {
    id: 'ordered.read',
    calls: 'ordered list, ordered get',
    permissions: [ordered('universe.ordered-data-store.scope.entry:read')],
    requires: [['universe.ordered-data-store.scope.entry:read']],
    binding: 'universe',
    kind: 'read',
    request: (ids) => {
      const path = universePath(ids, `/ordered-data-stores/${enc(PROBE_NAME)}/scopes/global/entries`);
      return path ? { method: 'GET', path, query: { maxPageSize: 1 } } : null;
    },
  },
  {
    id: 'ordered.write',
    calls: 'ordered set, ordered delete, ordered increment',
    permissions: [ordered('universe.ordered-data-store.scope.entry:write')],
    requires: [['universe.ordered-data-store.scope.entry:write']],
    binding: 'universe',
    kind: 'reversible',
    request: (ids) => {
      const path = universePath(ids, `/ordered-data-stores/${enc(PROBE_NAME)}/scopes/global/entries/${enc(PROBE_NAME)}`);
      return path ? { method: 'DELETE', path } : null;
    },
  },
  {
    id: 'memory.mapRead',
    calls: 'memory map_list, memory map_get',
    permissions: [memoryStores('memory-store.sorted-map:read')],
    requires: [mapRead],
    binding: 'universe',
    family: MEMORY_FAMILY,
    kind: 'read',
    request: (ids) => {
      const path = universePath(ids, `/memory-store/sorted-maps/${enc(PROBE_NAME)}/items`);
      return path ? { method: 'GET', path, query: { maxPageSize: 1 } } : null;
    },
  },
  {
    id: 'memory.mapWrite',
    calls: 'memory map_set, memory map_delete',
    permissions: [memoryStores('memory-store.sorted-map:write')],
    requires: [mapWrite],
    binding: 'universe',
    family: MEMORY_FAMILY,
    kind: 'reversible',
    request: (ids) => {
      const path = universePath(ids, `/memory-store/sorted-maps/${enc(PROBE_NAME)}/items/${enc(PROBE_NAME)}`);
      return path ? { method: 'DELETE', path } : null;
    },
  },
  {
    id: 'memory.queueRead',
    calls: 'memory queue_read',
    permissions: [memoryStores('memory-store.queue:dequeue')],
    requires: [queueDequeue],
    binding: 'universe',
    family: MEMORY_FAMILY,
    // A queue read is a GET, but reading hides items for the invisibility window, so it is not
    // side-effect-free the way the other reads are. Held back to deep even against a reserved name.
    kind: 'reversible',
    request: (ids) => {
      const path = universePath(ids, `/memory-store/queues/${enc(PROBE_NAME)}/items:read`);
      return path ? { method: 'GET', path, query: { count: 1 } } : null;
    },
  },
  {
    id: 'memory.queueWrite',
    calls: 'memory queue_add, memory queue_discard',
    permissions: [memoryStores('memory-store.queue:add'), memoryStores('memory-store.queue:discard')],
    requires: [queueAdd, queueDiscard],
    binding: 'universe',
    family: MEMORY_FAMILY,
    kind: 'none',
    because: 'adding a probe item would put real data on a queue a live server may read',
  },
  {
    id: 'message.publish',
    calls: 'message',
    permissions: ['Messaging Service → universe-messaging-service:publish'],
    requires: [['universe-messaging-service:publish']],
    binding: 'universe',
    kind: 'none',
    because: 'a probe publish would reach live servers of the experience',
  },
  {
    id: 'info.universe',
    calls: 'info universe',
    permissions: ['the experience added to the key (Get Universe lists no extra scope in the reference)'],
    requires: [],
    binding: 'none',
    kind: 'read',
    request: (ids) => {
      const path = universePath(ids, '');
      return path ? { method: 'GET', path } : null;
    },
  },
  {
    id: 'info.place',
    calls: 'info place',
    permissions: ['the experience added to the key (Get Place lists no extra scope in the reference)'],
    requires: [],
    binding: 'none',
    kind: 'read',
    request: (ids) => (ids.universeId && ids.placeId ? { method: 'GET', path: `${CLOUD_V2}/universes/${ids.universeId}/places/${ids.placeId}` } : null),
  },
  {
    id: 'info.group',
    calls: 'info group, info me (group-owned place)',
    permissions: ['Groups → Read (group:read)'],
    // Get Group declares no scope; what stops it is the key type, not a permission.
    requires: [],
    binding: 'none',
    userKeyOnly: true,
    kind: 'read',
    request: (ids) => (ids.creatorType === 'Group' && ids.creatorId ? { method: 'GET', path: `${CLOUD_V2}/groups/${ids.creatorId}` } : null),
  },
  {
    id: 'info.user',
    calls: 'info user, info me (user-owned place)',
    permissions: ['Users → Read (user.advanced:read; user.social:read for social profiles)'],
    // Both scopes are optional per the reference: without them the call still succeeds, with fewer fields.
    requires: [],
    binding: 'none',
    userKeyOnly: true,
    kind: 'read',
    request: (ids) => (ids.creatorType === 'User' && ids.creatorId ? { method: 'GET', path: `${CLOUD_V2}/users/${ids.creatorId}` } : null),
  },
  {
    id: 'group.read',
    calls: 'info memberships, info roles',
    permissions: ['Groups → group:read (only to see the permissions of non-guest roles; memberships need no scope)'],
    requires: [],
    binding: 'none',
    userKeyOnly: true,
    kind: 'read',
    request: (ids) => (ids.creatorType === 'Group' && ids.creatorId ? { method: 'GET', path: `${CLOUD_V2}/groups/${ids.creatorId}/memberships`, query: { maxPageSize: 1 } } : null),
  },
  {
    id: 'inventory.read',
    calls: 'info inventory',
    permissions: ['Inventory → user.inventory-item:read'],
    requires: [['user.inventory-item:read']],
    binding: 'none',
    kind: 'read',
    request: (ids) => (ids.creatorType === 'User' && ids.creatorId ? { method: 'GET', path: `${CLOUD_V2}/users/${ids.creatorId}/inventory-items`, query: { maxPageSize: 1 } } : null),
  },
  {
    id: 'subscription.read',
    calls: 'info subscription',
    permissions: ['Subscriptions → universe.subscription-product.subscription:read'],
    requires: [['universe.subscription-product.subscription:read']],
    binding: 'universe',
    kind: 'none',
    because: 'it needs a subscription product id, and there is no endpoint that lists them',
  },
  {
    id: 'place.publish',
    calls: 'publish',
    permissions: ['Place Publishing (API system "universe-places") → universe-places:write'],
    requires: [['universe-places:write']],
    binding: 'universe',
    kind: 'none',
    because: 'the only way to test it is to publish a place version',
  },
  {
    id: 'instance.read',
    calls: 'instance get, instance children',
    permissions: ['Instances (API system "universe-place-instances") → universe.place.instance:read'],
    requires: [['universe.place.instance:read']],
    binding: 'universe',
    kind: 'read',
    request: (ids) => (ids.universeId && ids.placeId ? { method: 'GET', path: `${CLOUD_V2}/universes/${ids.universeId}/places/${ids.placeId}/instances/root` } : null),
  },
  {
    id: 'instance.write',
    calls: 'instance update',
    permissions: ['Instances (API system "universe-place-instances") → universe.place.instance:write'],
    requires: [['universe.place.instance:write']],
    binding: 'universe',
    kind: 'none',
    because: 'a probe update would edit the published place',
  },
  {
    id: 'restriction.read',
    calls: 'restriction list, restriction get, restriction logs',
    permissions: ['User Restrictions → universe.user-restriction:read'],
    requires: [['universe.user-restriction:read']],
    binding: 'universe',
    kind: 'read',
    request: (ids) => {
      const path = universePath(ids, '/user-restrictions');
      return path ? { method: 'GET', path, query: { maxPageSize: 1 } } : null;
    },
  },
  {
    id: 'restriction.write',
    calls: 'restriction ban, restriction unban',
    permissions: ['User Restrictions → universe.user-restriction:write'],
    requires: [['universe.user-restriction:write']],
    binding: 'universe',
    kind: 'none',
    because: 'the only write this API has is banning a real player',
  },
  {
    id: 'notify.send',
    calls: 'notify',
    permissions: ['Notifications → user.user-notification:write'],
    requires: [['user.user-notification:write']],
    // The scope is keyed by the recipient, but a real key reports it bound to universes (2026-09-14)
    // and the call names its universe in `source`, so it is judged like any universe-scoped call.
    binding: 'universe',
    kind: 'none',
    because: 'a probe send would push a real notification to a real player',
  },
  {
    id: 'asset.read',
    calls: 'asset get, asset versions',
    permissions: ['Assets → Read (asset:read) for the creator that owns the asset'],
    requires: [['asset:read']],
    binding: 'creator',
    kind: 'none',
    because: 'Assets permissions are scoped to a creator, so a probe read cannot tell a missing scope from someone else’s asset',
  },
  {
    id: 'asset.upload',
    calls: 'asset_upload, asset update/rollback/archive/restore',
    permissions: ['Assets → Read + Write (asset:read, asset:write) for the creator that will own the asset'],
    requires: [['asset:read'], ['asset:write']],
    binding: 'creator',
    kind: 'none',
    because: 'Assets permissions are scoped to a creator, so a probe read cannot tell a missing scope from someone else’s asset',
  },
  {
    id: 'luau.execute',
    calls: 'luau',
    permissions: ['Luau Execution Sessions → Write (universe.place.luau-execution-session:write) for this experience'],
    requires: [['universe.place.luau-execution-session:write']],
    binding: 'universe',
    kind: 'none',
    because: 'creating a task runs a script against the published place and counts against a 5-per-minute quota',
  },
];

/** Every capability by id, for `permissionsFor` and the report. */
export const CAPABILITY_BY_ID: ReadonlyMap<string, Capability> = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function permissionsOf(...ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const found = CAPABILITY_BY_ID.get(id);
    if (found) for (const line of found.permissions) if (!out.includes(line)) out.push(line);
  }
  return out;
}
