import { CLOUD_V2, enc } from './shared.js';

/**
 * One table describing what every `cloud` call needs from the API key.
 *
 * It has two readers:
 *   - `permissionsFor` (run.ts) — names the exact Creator Hub permission in a 403 / no_api_key result;
 *   - the capability probe (`info what:"key"`, probe.ts) — answers "what can this key actually do?"
 *     before an agent commits to a multi-step plan.
 *
 * Open Cloud has no key-introspection endpoint, so the probe has to *ask*: it fires the read
 * below and reads the status. Roblox checks authorization before resource existence, so a 403
 * means the scope is missing while a 404 means the scope is present and the resource simply is
 * not there. Writes have no such harmless equivalent — a probe `set` would create real data — so
 * they are `unprobeable` unless a DELETE against a reserved name settles them (`reversible`).
 */
export type ProbeKind = 'read' | 'reversible' | 'none';

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
  /** Stable id used in the probe result. */
  id: string;
  /** The calls this capability covers, as an agent would write them. */
  calls: string;
  /** Creator Hub "API System → scope" lines, exactly as `permissionsFor` reports them. */
  permissions: string[];
  /**
   * `read` — a harmless GET settles it and runs by default.
   * `reversible` — only a write settles it, but a DELETE against a reserved name is harmless; runs with deep:true.
   * `none` — cannot be settled without a real side effect; always reported `unknown`.
   */
  kind: ProbeKind;
  /** Builds the probe request, or null when the ids it needs are unknown. */
  request?(ids: ProbeIds): ProbeRequest | null;
  /** Why this capability cannot be probed (kind 'none'), shown in the result. */
  because?: string;
}

/**
 * Names reserved for probing. A DELETE against them is a no-op on any real data: the probe
 * only ever asks "would this have been allowed?", and a 404 answers that as well as a 204.
 */
export const PROBE_NAME = '__studio_live_probe__';

const ds = (scope: string): string => `Data Stores → ${scope}`;
const ordered = (scope: string): string => `Ordered Data Stores → ${scope}`;

function universePath(ids: ProbeIds, suffix: string): string | null {
  return ids.universeId ? `${CLOUD_V2}/universes/${ids.universeId}${suffix}` : null;
}

/**
 * Capabilities in the order the probe reports them. Scope strings are the ones printed in the
 * official reference for each operation (docs/cloud.md §1.3 carries the same table).
 */
export const CAPABILITIES: Capability[] = [
  {
    id: 'datastore.list',
    calls: 'datastore list_stores',
    permissions: [ds('universe-datastores.control:list')],
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
    kind: 'none',
    because: 'a probe write would create a real data store entry',
  },
  {
    id: 'datastore.increment',
    calls: 'datastore increment',
    permissions: [ds('universe-datastores.objects:create'), ds('universe-datastores.objects:update')],
    kind: 'none',
    because: 'a probe increment would create or change a real data store entry',
  },
  {
    id: 'datastore.delete',
    calls: 'datastore delete',
    permissions: [ds('universe-datastores.objects:delete')],
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
    kind: 'reversible',
    request: (ids) => {
      const path = universePath(ids, `/ordered-data-stores/${enc(PROBE_NAME)}/scopes/global/entries/${enc(PROBE_NAME)}`);
      return path ? { method: 'DELETE', path } : null;
    },
  },
  {
    id: 'message.publish',
    calls: 'message',
    permissions: ['Messaging Service → universe-messaging-service:publish'],
    kind: 'none',
    because: 'a probe publish would reach live servers of the experience',
  },
  {
    id: 'info.universe',
    calls: 'info universe',
    permissions: ['the experience added to the key (Get Universe lists no extra scope in the reference)'],
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
    kind: 'read',
    request: (ids) => (ids.universeId && ids.placeId ? { method: 'GET', path: `${CLOUD_V2}/universes/${ids.universeId}/places/${ids.placeId}` } : null),
  },
  {
    id: 'info.group',
    calls: 'info group, info me (group-owned place)',
    permissions: ['Groups → Read (group:read)'],
    kind: 'read',
    request: (ids) => (ids.creatorType === 'Group' && ids.creatorId ? { method: 'GET', path: `${CLOUD_V2}/groups/${ids.creatorId}` } : null),
  },
  {
    id: 'info.user',
    calls: 'info user, info me (user-owned place)',
    permissions: ['Users → Read (user.advanced:read; user.social:read for social profiles)'],
    kind: 'read',
    request: (ids) => (ids.creatorType === 'User' && ids.creatorId ? { method: 'GET', path: `${CLOUD_V2}/users/${ids.creatorId}` } : null),
  },
  {
    id: 'asset.upload',
    calls: 'asset_upload, asset update/rollback/archive/restore',
    permissions: ['Assets → Read + Write (asset:read, asset:write) for the creator that will own the asset'],
    kind: 'none',
    // A GET on some other creator's asset can 403 on ownership rather than on scope, so a read
    // probe here would report "denied" for a key that is in fact fine. Better unknown than wrong.
    because: 'Assets permissions are scoped to a creator, so a probe read cannot tell a missing scope from someone else’s asset',
  },
  {
    id: 'luau.execute',
    calls: 'luau',
    permissions: ['Luau Execution Sessions → Write (universe.place.luau-execution-session:write) for this experience'],
    kind: 'none',
    because: 'creating a task runs a script against the published place and counts against a 5-per-minute quota',
  },
];

/** Every capability by id, for `permissionsFor` and the probe result. */
export const CAPABILITY_BY_ID: ReadonlyMap<string, Capability> = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function permissionsOf(...ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const found = CAPABILITY_BY_ID.get(id);
    if (found) for (const line of found.permissions) if (!out.includes(line)) out.push(line);
  }
  return out;
}
