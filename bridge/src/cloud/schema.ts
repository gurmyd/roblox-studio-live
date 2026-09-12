import { z } from 'zod';

export const cloudToolName: 'cloud' = 'cloud';

export const CLOUD_ACTIONS = ['datastore', 'ordered', 'message', 'info', 'asset_upload', 'luau'] as const;
export const DATASTORE_OPS = ['list_stores', 'list_entries', 'get', 'set', 'delete', 'increment'] as const;
export const ORDERED_OPS = ['list', 'get', 'set', 'delete', 'increment'] as const;
export const INFO_WHAT = ['universe', 'place', 'group', 'user', 'me'] as const;
export const MAX_WAIT_MS = 300_000;

const idArg = z.number().int().positive();

/** Zod raw shape (same style as the other bridge tools: flat, action-discriminated). */
export const cloudToolShape = {
  action: z.enum(CLOUD_ACTIONS),
  op: z
    .enum([...DATASTORE_OPS, 'list'] as [string, ...string[]])
    .optional()
    .describe('datastore: list_stores|list_entries|get|set|delete|increment; ordered: list|get|set|delete|increment'),
  store: z.string().min(1).optional().describe('datastore/ordered: data store name'),
  scope: z.string().min(1).optional().describe('datastore: scope (omit = global); ordered: scope (default global)'),
  key: z.string().min(1).optional().describe('datastore/ordered: entry key'),
  value: z.unknown().optional().describe('set: JSON value (ordered: integer)'),
  etag: z.string().min(1).optional().describe('datastore set: write only if the entry still has this etag (from get)'),
  users: z.array(z.number().int().positive()).max(100).optional().describe('datastore set/increment: user ids the value belongs to'),
  attributes: z.record(z.unknown()).optional().describe('datastore set/increment: metadata object'),
  amount: z.number().optional().describe('increment: integer amount to add (negative allowed)'),
  filter: z.string().optional().describe('list_entries: id.startsWith("prefix"); ordered list: entry >= 10 && entry <= 30'),
  order_by: z.string().optional().describe('ordered list: "value desc" (default ascending)'),
  page_size: z.number().int().min(1).max(256).optional().describe('list ops: page size'),
  page_token: z.string().optional().describe('list ops: nextPageToken from the previous page'),
  show_deleted: z.boolean().optional().describe('datastore list ops: include deleted'),
  topic: z.string().min(1).max(80).optional().describe('message: MessagingService topic (≤ 80 chars)'),
  message: z.unknown().optional().describe('message: string or JSON (≤ 1 KB)'),
  what: z.enum(INFO_WHAT).optional().describe('info: universe | place | group | user | me (me = owner of the open place)'),
  id: idArg.optional().describe('info group/user: explicit id (default: the owner of the open place)'),
  file: z.string().min(1).optional().describe('asset_upload: absolute path of the file'),
  asset_type: z.string().min(1).optional().describe('asset_upload: Model | Decal | Audio | Video | Animation | Mesh (also Image)'),
  name: z.string().min(1).max(50).optional().describe('asset_upload: display name'),
  description: z.string().max(1000).optional().describe('asset_upload: description'),
  creator: z.object({ type: z.enum(['User', 'Group']), id: idArg }).optional().describe('asset_upload: owner (default: owner of the open place)'),
  operation_id: z.string().min(1).optional().describe('asset_upload: re-poll an earlier upload operation instead of uploading'),
  script: z.string().min(1).optional().describe('luau: Luau source run server-side in a fresh copy of the published place'),
  task: z.string().min(1).optional().describe('luau: re-poll an earlier task path instead of creating one'),
  universe_id: idArg.optional().describe('override: universe (default game.GameId of the open place)'),
  place_id: idArg.optional().describe('override: place (default game.PlaceId of the open place)'),
  timeout_ms: z.number().int().min(1000).max(MAX_WAIT_MS).optional().describe('luau/asset_upload: how long to wait (default 60000, max 300000)'),
} satisfies Record<string, z.ZodTypeAny>;

export const cloudArgsSchema = z.object(cloudToolShape);
export type CloudArgs = z.infer<typeof cloudArgsSchema>;

export const cloudToolDescription: string = [
  'Roblox Open Cloud for the place open in Studio. IDs default to the connected session (universe = game.GameId, place = game.PlaceId, creator = the place owner); pass universe_id / place_id / id / creator only to override. Needs an API key: env ROBLOX_OPEN_CLOUD_KEY or <STUDIO_LIVE_HOME>/opencloud.json {"key":"…"} (re-read every call, never returned). A 403 result names the exact Creator Hub permission to add.',
  'action:',
  '- datastore: op list_stores | list_entries | get | set | delete | increment; store, key, scope?, value (set, JSON), etag? (set only if unchanged), users?/attributes?, amount (increment), filter/page_size/page_token.',
  '- ordered: op list | get | set | delete | increment; store, scope (default global), key, value (integer), order_by ("value desc"), filter ("entry >= 10 && entry <= 30").',
  '- message: topic (≤ 80 chars) + message (string or JSON, ≤ 1 KB) → MessagingService in live servers.',
  '- info: what universe | place | group | user | me; id? for group/user.',
  '- asset_upload: file (absolute path), asset_type (Model | Decal | Audio | Video | Animation | Mesh), name, description?, creator? → waits for the upload operation, returns asset_id + moderation (approved | reviewing | rejected).',
  '- luau: script runs server-side in a fresh copy of the PUBLISHED place (not the Studio session), up to timeout_ms (default 60 s, max 5 min); returns results (return values), logs (print/warn) and state. task re-polls a pending task.',
  'Results are JSON ≤ 20 KB (truncated: true when cut).',
].join('\n');
