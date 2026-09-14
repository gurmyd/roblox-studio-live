import { z } from 'zod';

export const cloudToolName: 'cloud' = 'cloud';

export const CLOUD_ACTIONS = ['datastore', 'ordered', 'memory', 'message', 'info', 'publish', 'asset_upload', 'asset', 'luau', 'instance', 'restriction', 'notify'] as const;
export const DATASTORE_OPS = ['list_stores', 'list_entries', 'get', 'set', 'delete', 'increment'] as const;
export const ORDERED_OPS = ['list', 'get', 'set', 'delete', 'increment'] as const;
export const MEMORY_OPS = ['map_list', 'map_get', 'map_set', 'map_delete', 'queue_add', 'queue_read', 'queue_discard'] as const;
export const ASSET_OPS = ['get', 'update', 'versions', 'rollback', 'archive', 'restore'] as const;
export const RESTRICTION_OPS = ['list', 'get', 'ban', 'unban', 'logs'] as const;
export const INSTANCE_OPS = ['get', 'update', 'children'] as const;
export const INFO_WHAT = ['universe', 'place', 'group', 'user', 'me', 'key', 'memberships', 'roles', 'inventory', 'subscription'] as const;
export const VERSION_TYPES = ['Published', 'Saved'] as const;
export const RESTRICTION_LEVELS = ['universe', 'place'] as const;
export const MAX_WAIT_MS = 300_000;

/** Every op name any action accepts; which ones are legal is checked per action. */
const ALL_OPS = [...new Set<string>([...DATASTORE_OPS, ...ORDERED_OPS, ...MEMORY_OPS, ...ASSET_OPS, ...RESTRICTION_OPS, ...INSTANCE_OPS])] as [string, ...string[]];

const idArg = z.number().int().positive();

/** Zod raw shape (same style as the other bridge tools: flat, action-discriminated). */
export const cloudToolShape = {
  action: z.enum(CLOUD_ACTIONS),
  op: z
    .enum(ALL_OPS)
    .optional()
    .describe(
      'datastore: list_stores|list_entries|get|set|delete|increment; ordered: list|get|set|delete|increment; memory: map_list|map_get|map_set|map_delete|queue_add|queue_read|queue_discard; asset: get|update|versions|rollback|archive|restore; restriction: list|get|ban|unban|logs; instance: get|update|children',
    ),
  store: z.string().min(1).optional().describe('datastore/ordered: data store name; memory: the sorted map or queue name (created by its first write)'),
  scope: z.string().min(1).optional().describe('datastore: scope (omit = global); ordered: scope (default global)'),
  key: z.string().min(1).optional().describe('datastore/ordered/memory map: entry or item key'),
  value: z.unknown().optional().describe('set ops: JSON value (ordered: integer; memory queue_add: the item payload)'),
  etag: z.string().min(1).optional().describe('datastore set: write only if the entry still has this etag (from get)'),
  users: z.array(z.number().int().positive()).max(100).optional().describe('datastore set/increment: user ids the value belongs to'),
  attributes: z.record(z.unknown()).optional().describe('datastore set/increment: metadata object'),
  amount: z.number().optional().describe('increment: integer amount to add (negative allowed)'),
  filter: z
    .string()
    .optional()
    .describe('list_entries: id.startsWith("prefix"); ordered list: entry >= 10 && entry <= 30; memory map_list: sortKey > 100 (NOT numericSortKey); restriction logs: user == "users/156"; info memberships/inventory: see the reference'),
  order_by: z.string().optional().describe('ordered list: "value desc" (default ascending); memory map_list: only "id" / "id desc"'),
  page_size: z.number().int().min(1).max(256).optional().describe('list ops: page size (memory and restrictions cap at 100, asset versions at 50)'),
  page_token: z.string().optional().describe('list ops: nextPageToken from the previous page'),
  show_deleted: z.boolean().optional().describe('datastore list ops: include deleted'),

  // memory store
  ttl_s: z.number().positive().optional().describe('memory map_set / queue_add: how long the item lives, in seconds'),
  sort_key: z.union([z.string(), z.number()]).optional().describe('memory map_set: sort key — a number sorts numerically, a string alphabetically'),
  priority: z.number().optional().describe('memory queue_add: higher runs closer to the front (equal priorities keep insertion order)'),
  count: z.number().int().min(1).max(200).optional().describe('memory queue_read: how many items to read (default 1, max 200)'),
  all_or_nothing: z.boolean().optional().describe('memory queue_read: return nothing (404) unless the full count is available'),
  invisibility_s: z.number().positive().optional().describe('memory queue_read: seconds the read items stay hidden from other readers before reappearing'),
  read_id: z.string().min(1).optional().describe('memory queue_discard: the read_id from queue_read — a whole read batch is acknowledged at once'),

  // messaging
  topic: z.string().min(1).max(80).optional().describe('message: MessagingService topic (≤ 80 chars)'),
  message: z.unknown().optional().describe('message: string or JSON (≤ 1 KB)'),

  // info
  what: z.enum(INFO_WHAT).optional().describe('info: universe | place | group | user | me (owner of the open place) | key (what this API key may do) | memberships | roles | inventory | subscription'),
  id: idArg.optional().describe('info group/user/inventory/subscription: id; restriction: the player’s user id; notify: the user to notify'),
  deep: z.boolean().optional().describe('info key: also probe writes that a delete against a reserved name can settle (nothing real is deleted)'),
  product_id: idArg.optional().describe('info subscription: the subscription product id'),

  // place publishing
  version_type: z.enum(VERSION_TYPES).optional().describe('publish: "Published" (default, goes live) or "Saved" (stored as a version without publishing)'),

  // assets
  file: z.string().min(1).optional().describe('asset_upload / asset update (.fbx Models only) / publish: absolute path of the file'),
  asset_type: z.string().min(1).optional().describe('asset_upload: Model | Decal | Audio | Video | Animation | Mesh (also Image)'),
  name: z.string().min(1).max(50).optional().describe('asset_upload / asset update: display name'),
  description: z.string().max(1000).optional().describe('asset_upload / asset update: description'),
  creator: z.object({ type: z.enum(['User', 'Group']), id: idArg }).optional().describe('asset_upload: owner (default: owner of the open place)'),
  operation_id: z.string().min(1).optional().describe('asset_upload: re-poll an earlier upload operation instead of uploading'),
  asset_id: idArg.optional().describe('asset ops: the asset to act on'),
  version: z.number().int().positive().optional().describe('asset rollback: the version number to restore (from asset versions)'),
  read_mask: z.string().optional().describe('asset get: comma-separated extra metadata fields to return'),

  // luau execution
  script: z.string().min(1).optional().describe('luau: Luau source run server-side in a fresh copy of the published place'),
  task: z.string().min(1).optional().describe('luau: re-poll an earlier task path instead of creating one'),

  // instance api
  instance_id: z.string().min(1).optional().describe('instance: the instance to act on; "root" (default) is the DataModel'),
  class_name: z.string().min(1).optional().describe('instance update: Folder | Script | LocalScript | ModuleScript — the only classes this API can write'),
  properties: z.record(z.unknown()).optional().describe('instance update: PascalCase properties, e.g. {"Source":"print(1)"} or {"Enabled":false}'),

  // user restrictions
  level: z.enum(RESTRICTION_LEVELS).optional().describe('restriction: "universe" (default, the whole experience) or "place" (one place only)'),
  duration_s: z.number().positive().optional().describe('restriction ban: length in seconds; omit entirely for a permanent ban'),
  reason: z.string().min(1).optional().describe('restriction ban: the private moderation note (not shown to the player)'),
  display_reason: z.string().min(1).optional().describe('restriction ban: the message the banned player sees'),
  exclude_alts: z.boolean().optional().describe('restriction ban: do not extend the ban to detected alt accounts'),

  // notifications
  message_id: z.string().min(1).optional().describe('notify: the notification string id from Creator Hub'),
  parameters: z.record(z.unknown()).optional().describe('notify: values for the {placeholders} in the notification string (string or integer each)'),
  launch_data: z.string().optional().describe('notify: launch data carried into the experience when the player taps (≤ 200 bytes)'),
  analytics_category: z.string().optional().describe('notify: analytics category for this notification'),

  // shared overrides
  universe_id: idArg.optional().describe('override: universe (default game.GameId of the open place)'),
  place_id: idArg.optional().describe('override: place (default game.PlaceId of the open place)'),
  timeout_ms: z.number().int().min(1000).max(MAX_WAIT_MS).optional().describe('long calls: how long to wait (default 60000, max 300000)'),
} satisfies Record<string, z.ZodTypeAny>;

export const cloudArgsSchema = z.object(cloudToolShape);
export type CloudArgs = z.infer<typeof cloudArgsSchema>;

export const cloudToolDescription: string = [
  'Roblox Open Cloud for the place open in Studio. IDs default to the connected session (universe = game.GameId, place = game.PlaceId, creator = the place owner); pass universe_id / place_id / id / creator only to override. Needs an API key: env ROBLOX_OPEN_CLOUD_KEY or <STUDIO_LIVE_HOME>/opencloud.json {"key":"…"}, re-read every call and never returned. A 403 names the exact Creator Hub permission to add — or call info what:"key" first: it probes the key and reports allowed | denied | unknown per action.',
  'action (ops in parens; arg help is on each field):',
  '- datastore (list_stores|list_entries|get|set|delete|increment), ordered (list|get|set|delete|increment): persistent entries; etag makes a set conditional.',
  '- memory (map_list|map_get|map_set|map_delete|queue_add|queue_read|queue_discard): MemoryStore sorted maps + queues, fast cross-server state with a ttl.',
  '- message: topic + message (≤1 KB) → MessagingService in live servers, not playtests.',
  '- info (universe|place|group|user|me|key|memberships|roles|inventory|subscription): reads. key = the capability probe.',
  "- publish: uploads a local .rbxl/.rbxlx as the place's new live version. Do this before luau / instance, which read the PUBLISHED place, never the Studio session.",
  '- asset_upload: file + asset_type (Model|Decal|Audio|Video|Animation|Mesh|Image) → asset_id + moderation. asset (get|update|versions|rollback|archive|restore): the rest of the lifecycle; update puts a new .fbx behind an existing Model asset_id.',
  '- luau: runs a script in a fresh server copy of the published place; returns results + logs.',
  '- instance (get|update|children): read/edit instances of the published place ("root" = the DataModel). For the OPEN place use the run tool.',
  '- restriction (list|get|ban|unban|logs): ban a user from the experience or one place.',
  '- notify: send an experience notification to a user (message_id = a Creator Hub template).',
  'Results are JSON ≤ 20 KB; long calls return pending: true + a re-poll handle after timeout_ms.',
].join('\n');
