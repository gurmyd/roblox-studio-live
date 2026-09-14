# Studio Live — Roblox Open Cloud (`cloud` tool)

One MCP for everything Roblox: the `cloud` tool talks to [Open Cloud](https://create.roblox.com/docs/cloud) (`https://apis.roblox.com`) for the place that is open in Studio — data stores, memory stores, messaging, place publishing, the asset lifecycle, server-side Luau, the Instance API, bans, notifications and reads about the experience, its owner and the API key itself. Agents never ask for universe / place / group / user ids — they come from the connected Studio session. The API key is read from disk on every call, so it can be created, rotated or revoked without restarting the bridge.

Module: `bridge/src/cloud/` (public surface in `index.ts`; one file per surface, and `capabilities.ts` holds the single table of what each call needs from the key). Tests: `tests/cloud/`. Every path, verb and body field below was checked against Roblox's own OpenAPI spec and guides (2026-09-14).

## 1. Setup

### 1.1 Create an API key

1. Open [Creator Hub → Open Cloud → API Keys](https://create.roblox.com/dashboard/credentials) and **Create API Key**.
2. Under **Access Permissions** add the API systems you need (table in §1.4) and, for each, select the experience (universe) the open place belongs to — or the group/user for Assets. Some systems appear in that menu by their slug (`universe-places`, `universe-place-instances`); the scope string is the authoritative part of each line.
3. Set the key's IP restriction to your machine (or none while developing) and an expiry, then copy the key. It is shown once.

Give an agent's key only what its work needs: `publish` makes a place file the live version and `restriction ban` bans real players.

### 1.2 Put the key where the bridge looks (checked in this order, on every call)

| Where | Format |
|---|---|
| env `ROBLOX_OPEN_CLOUD_KEY` | the key |
| `<STUDIO_LIVE_HOME>/opencloud.json` | `{"key":"…"}` |
| `<STUDIO_LIVE_HOME>/opencloud.key` | the key as plain text (whitespace trimmed) |

`STUDIO_LIVE_HOME` defaults to `~/.studio-live` (Windows: `C:\Users\<you>\.studio-live`). Both files may carry a UTF-8 byte-order mark and CRLF line endings (what PowerShell's `Out-File` / `Set-Content -Encoding utf8` and Notepad write by default). The key is **never cached, logged, or echoed**; if any server response happens to contain it, the result shows `sk…` instead. When no key is found the tool answers `error.code = "no_api_key"` with these three locations and the permissions the call would have needed.

Optional: `ROBLOX_OPEN_CLOUD_BASE_URL` overrides the API host (tests / proxies). Default `https://apis.roblox.com`.

### 1.3 What can this key do? `info what:"key"`

```json
{"action":"info","what":"key"}
```

Ask before planning multi-step work. The report lists every capability (`datastore.read`, `place.publish`, `memory.queueWrite`, …) as `allowed`, `denied` or `unknown`, each with the calls it covers and the permission line to add.

- **Introspection first** (`method: "introspect"`). Roblox's key introspection endpoint returns the key's own scope list, with the universes and creators each scope is bound to (verified against a real key, 2026-09-14). The report judges every capability against it — writes included — without calling anything else. It also returns `key` (`name`, `owner_user_id`, `enabled`, `expired`, `expires`), `scopes_held`, and `bound_to_this_universe`: `false` means the key was never given this experience, one fix in Creator Hub rather than a dozen missing scopes. A data store scope narrowed to named stores is `allowed` with a note naming them.
- **Trial reads as a fallback** (`method: "probe"`, with `introspect_error` saying why). Harmless reads against the reserved name `__studio_live_probe__`: Roblox authorizes a resource inside a universe before resolving it, so `403` means the scope is missing and `404` means it is present. Writes cannot be tried harmlessly and stay `unknown`; `deep: true` adds the ones a request against the reserved name can settle (a delete, or a read of the empty reserved queue — nothing real changes). A `403` on every universe-scoped probe is reported as an unbound universe. Probes are never retried, so a rate-limited probe costs one request per capability, not four.
- **Expected `unknown`s.** `info group` / `info user` / `info memberships` / `info roles` need no scope and `info inventory` needs only its own, but Roblox answers `401` to a group-owned key on all five (see the end of this page), and introspection does not say who owns a key. Memory store scopes have shipped under three spellings (below); a spelling the tool does not know is `unknown` with the held names listed, not `denied`.

### 1.4 Permissions per action

Scope names are the ones printed in the official reference for each operation; the first part is the API system in Creator Hub. A `403` result repeats the exact line for the call that failed, and `info what:"key"` reports the same lines.

| Action | Creator Hub API system → scope |
|---|---|
| `datastore` `list_stores` | Data Stores → `universe-datastores.control:list` |
| `datastore` `list_entries` | Data Stores → `universe-datastores.objects:list` |
| `datastore` `get` | Data Stores → `universe-datastores.objects:read` |
| `datastore` `set` | Data Stores → `universe-datastores.objects:update` (+ `objects:create` for keys that do not exist yet) |
| `datastore` `delete` | Data Stores → `universe-datastores.objects:delete` |
| `datastore` `increment` | Data Stores → `universe-datastores.objects:create` + `universe-datastores.objects:update` |
| `ordered` `list` / `get` | Ordered Data Stores → `universe.ordered-data-store.scope.entry:read` |
| `ordered` `set` / `delete` / `increment` | Ordered Data Stores → `universe.ordered-data-store.scope.entry:write` |
| `memory` `map_list` / `map_get` | Memory Stores → `memory-store.sorted-map:read` |
| `memory` `map_set` / `map_delete` | Memory Stores → `memory-store.sorted-map:write` |
| `memory` `queue_read` | Memory Stores → `memory-store.queue:dequeue` (the verb is `dequeue`, not `read`) |
| `memory` `queue_add` / `queue_discard` | Memory Stores → `memory-store.queue:add` / `memory-store.queue:discard` |
| `message` | Messaging Service → `universe-messaging-service:publish` |
| `publish` | `universe-places` → `universe-places:write` (hyphenated and plural — not the dotted `universe.place:write` of the v2 place endpoints) |
| `info` `universe` / `place` | none: Get Universe and Get Place declare no scope |
| `info` `group` / `memberships` / `roles` | none for group info and memberships; Groups → `group:read` only to see the permissions of non-guest roles |
| `info` `user` | none required; `user.advanced:read` / `user.social:read` only add fields |
| `info` `me` | the group or user line above, depending on who owns the place |
| `info` `inventory` | Inventory → `user.inventory-item:read` |
| `info` `subscription` | Subscriptions → `universe.subscription-product.subscription:read` |
| `info` `key` | none — the report's job is to say which of these the key holds |
| `asset_upload`, `asset` `update` / `rollback` / `archive` / `restore` | Assets → `asset:read` + `asset:write` for the creator (user or group) that owns the asset |
| `asset` `get` / `versions` | Assets → `asset:read` for the owning creator |
| `luau` | Luau Execution Sessions → `universe.place.luau-execution-session:write` for the experience |
| `instance` `get` / `children` | `universe-place-instances` (read, under Experience Operations) → `universe.place.instance:read` |
| `instance` `update` | `universe-place-instances` (write) → `universe.place.instance:write` |
| `restriction` `list` / `get` / `logs` | User Restrictions → `universe.user-restriction:read` |
| `restriction` `ban` / `unban` | User Restrictions → `universe.user-restriction:write` |
| `notify` | Notifications → `user.user-notification:write` |

**Memory store scope spelling.** A real key's introspection (2026-09-14) reports the bare OpenAPI names shown above — `memory-store.sorted-map:read`, `memory-store.queue:dequeue`, … — so that is what the table and every `403` name. Three other spellings are on record and the capability report accepts them too: the same names with a `universe.` target prefix, the launch announcement's `memoryStores:sortedMap:read` / `memoryStores:queue:…`, and a hyphenated item form (`universe.memory-store-sorted-map-item:read`) one working key was reported to carry.

## 2. How ids are inferred

Every call needs some ids. They default from the active Studio session (`hello` / `hb` frames of the hub), and explicit arguments always win:

| Id | Default (from Studio) | Override argument |
|---|---|---|
| universe | `game.GameId` | `universe_id` |
| place | `game.PlaceId` | `place_id` |
| creator (owner) | `game.CreatorType` / `game.CreatorId` | `creator {type:"User"|"Group", id}` (asset_upload), `id` (info group / user / memberships / roles) |
| user | — | `id` (restriction, notify, info inventory / subscription) |
| asset | — | `asset_id` (asset) |

Results echo what was used: `universe_id`, `place_id`, `ids_from: "studio" | "args" | "mixed"`.

If no Studio is connected and no id was passed → `error.code = "no_ids"` ("Open the place in Roblox Studio … or pass universe_id"). If the open place is unpublished (`GameId` 0) the message says to publish it first. `universeId`, `creatorType` and `creatorId` travel only in the hub's `hb` frames (protocol §2.7), so for up to one heartbeat interval after Studio connects they are still unknown; a call in that window gets a distinct `no_ids` message ("not known yet … arrives with the next heartbeat; retry in a few seconds, or pass universe_id") rather than the publish hint, so an agent never publishes a place that is already published. `info what:"me"` is the owner of the open place; the key's own creator is in `info what:"key"` → `key.owner_user_id`.

`restriction` never narrows to a place from the session: it bans from the whole experience unless the call says `level: "place"`.

## 3. Actions and examples

All results are JSON text, at most 20 KB and always parseable. When a result is too large, arrays, long strings and wide objects are cut progressively (`"truncated": true` at the top level; arrays end in `"…[+N more]"`, strings in `"…[+N chars]"`, objects gain `"…": "+N more keys"`). If even the tightest cut does not fit, the result is `{"truncated": true, "note": "…", "preview": "<head of the JSON text>"}` — still JSON, never a document sliced mid-structure. Errors are `{ "error": { code, message, status?, permissions?, … } }` with `isError: true`.

### 3.1 `datastore` — standard data stores (v2)

```json
{"action":"datastore","op":"list_stores"}
{"action":"datastore","op":"list_entries","store":"PlayerData","filter":"id.startsWith(\"p_\")","page_size":100}
{"action":"datastore","op":"get","store":"PlayerData","key":"p_100000001"}
{"action":"datastore","op":"set","store":"PlayerData","key":"p_100000001","value":{"coins":120},"etag":"<etag from get>","users":[100000001]}
{"action":"datastore","op":"increment","store":"PlayerData","key":"visits","amount":1}
{"action":"datastore","op":"delete","store":"PlayerData","key":"p_100000001"}
```

- `scope` is optional (omit = Roblox's default `global` scope). `get` returns the full entry: `value`, `etag`, `revisionId`, `revisionCreateTime`, `createTime`, `state`, `users`, `attributes`.
- `set` is an upsert (`PATCH …?allowMissing=true`). Pass `etag` to write only if the entry is unchanged since you read it (a mismatch → `error.code = "conflict"`). Per the reference, omitted `users`/`attributes` are cleared on update.
- `increment` needs an integer `amount` (the reference: both the stored value and the amount must be integers); a non-integer is rejected locally as `bad_request`.
- List results carry `nextPageToken`; pass it back as `page_token`.

### 3.2 `ordered` — ordered data stores (v2)

```json
{"action":"ordered","op":"list","store":"Leaderboard","order_by":"value desc","page_size":10}
{"action":"ordered","op":"list","store":"Leaderboard","filter":"entry >= 10 && entry <= 30"}
{"action":"ordered","op":"set","store":"Leaderboard","key":"100000001","value":9001}
{"action":"ordered","op":"increment","store":"Leaderboard","key":"100000001","amount":5}
{"action":"ordered","op":"get","store":"Leaderboard","scope":"season2","key":"100000001"}
```

`scope` defaults to `global`. Values and increments must be integers.

### 3.3 `memory` — memory store sorted maps and queues

```json
{"action":"memory","op":"map_set","store":"Lobby","key":"p_1","value":{"mmr":1500},"sort_key":1500,"ttl_s":300}
{"action":"memory","op":"map_list","store":"Lobby","filter":"sortKey > 1000","page_size":50}
{"action":"memory","op":"map_get","store":"Lobby","key":"p_1"}
{"action":"memory","op":"map_delete","store":"Lobby","key":"p_1"}
{"action":"memory","op":"queue_add","store":"Matchmaking","value":{"party":[1,2]},"priority":5,"ttl_s":60}
{"action":"memory","op":"queue_read","store":"Matchmaking","count":10,"invisibility_s":30}
{"action":"memory","op":"queue_discard","store":"Matchmaking","read_id":"<read_id from queue_read>"}
```

Fast, short-lived cross-server state — matchmaking queues, live leaderboards, locks. `store` is the map or queue name; it comes into existence with its first write, exactly as `MemoryStoreService:GetSortedMap` / `GetQueue` do in-engine.

- `ttl_s` and `invisibility_s` are whole seconds; the tool sends them as the protobuf duration strings Open Cloud requires (`"300s"`).
- `sort_key` is a number or a string; the tool sends `numericSortKey` or `stringSortKey` accordingly. `map_list` filters address it as `sortKey` (`sortKey > 100`, `id > "k-001"`), and `order_by` can only order by `id`.
- `map_list` always sends `maxPageSize` (default 100, the maximum): left unset, the service returns **one** item, which looks like an empty map. The last page carries `nextPageToken: null`.
- `map_set` replaces the whole item — the endpoint has no update mask — so a `value`, `ttl_s` or `sort_key` you do not pass is unset. There is no increment on sorted maps in Open Cloud.
- A queue item's payload is `data` on the wire (a sorted map's is `value`); the tool takes `value` for both.
- `queue_read` does **not** remove items: they are hidden from other readers for the invisibility window, then reappear. `queue_discard` with the returned `read_id` removes the whole batch; there is no per-item acknowledgement. `all_or_nothing: true` returns 404 unless `count` items are available. The live service answers a read with `queueItems` and puts the read id in `id` — not the spec's `items` / `readId` (measured 2026-09-14). The tool reads either, returns `read_id`, and `queue_discard` sends it back as `readId`, which the service accepts; `raw_keys` shows what arrived.

### 3.4 `message` — MessagingService publish

```json
{"action":"message","topic":"Announce","message":{"kind":"reload","reason":"agent patched Main"}}
```

JSON is sent stringified; the payload must be ≤ 1 KB and the topic ≤ 80 chars (checked before sending). The message reaches `MessagingService:SubscribeAsync("Announce")` in **live servers** of the universe — not in Studio playtests.

### 3.5 `info` — the place, its owner, and the key

```json
{"action":"info","what":"key"}
{"action":"info","what":"universe"}
{"action":"info","what":"place"}
{"action":"info","what":"me"}
{"action":"info","what":"user","id":100000001}
{"action":"info","what":"memberships","filter":"role == 'groups/333/roles/1'"}
{"action":"info","what":"roles"}
{"action":"info","what":"inventory","id":100000001,"filter":"gamePasses=true"}
{"action":"info","what":"subscription","product_id":9001,"id":100000001}
```

`key` is the capability report of §1.3. `universe` returns `displayName`, `description`, `visibility`, `rootPlace`, `ageRating`, device flags, `user` or `group` owner path; `place` returns `displayName`, `description`, `serverSize`, `root`; `group` / `user` return the Open Cloud v2 resources. `memberships` and `roles` default to the group that owns the place (a membership's `role` is the member's highest-ranked role, `roles` all of them); roles page at most 20. `inventory` takes Roblox's own `key=value` filter grammar, not CEL (`inventoryItemAssetTypes=HAT,CLASSIC_PANTS`, `gamePasses=true`, `badges=true`), and type fields cannot be combined with id fields. It needs a user-owned key: a group-owned one gets `401 Authentication type provided was invalid!` even when it holds the scope (measured). `subscription` requests the `FULL` view — the default `BASIC` omits most fields — and the subscription id is the subscriber's user id.

### 3.6 `publish` — make a place file the live version

```json
{"action":"publish","file":"C:\\places\\game.rbxl"}
{"action":"publish","file":"C:\\places\\game.rbxlx","version_type":"Saved"}
```

The step that connects the place open in Studio to everything that reads the **published** place (`luau`, `instance`, live servers). Save the place to a file first (File → Save to File As…), then publish it. That save is a human step: no Studio API saves a place. A plugin's only save calls are `PromptSaveSelection` (a save dialog for selected instances) and `SaveSelectedToRoblox`, `game:SavePlace` answers "can only be called from a server script", and `SerializationService` serializes the contents of services but refuses the services themselves (all measured 2026-09-14).

- Uploads the raw file bytes to an existing place as a new version. `version_type` is `Published` (default: goes live) or `Saved` (stored as a version without publishing). Result: `version_number`, `published`, `format`, `bytes`.
- The format comes from the file's **bytes**, not its name: a binary place starts `<roblox!` + `89 FF 0D 0A 1A 0A` and is sent as `application/octet-stream`; an XML place starts `<roblox ` or `<?xml` and is sent as `application/xml`. A file that is neither is refused before upload; a mislabelled one is sent by its contents with a warning.
- Never retried: each accepted call is a new place version, so a 5xx is reported rather than replayed.
- **Not everything is carried.** The publish API silently does not update `EditableImage`, `EditableMesh`, `PartOperation` (every union and negation), `SurfaceAppearance` and `BaseWrap` instances. Every result lists them in `not_updated_by_this_api`; if the place uses them, publish from Studio.
- **Size.** The OpenAPI spec declares a 10 MiB request limit on this operation while Roblox's general place-file limit is 100 MB. Files over 100 MB are refused; between the two the tool publishes and warns.
- **A `409`** is documented as "place not part of the universe", but its usual cause is a busy place — an active Team Create session, or the place open in Studio. The error says so (`likely_cause`); close or stop editing it and retry in a minute.
- Rate limit: 30 publishes per minute per key owner. There is no Open Cloud endpoint that creates a place; the place must already exist.

### 3.7 `asset_upload` — create an asset (Assets API v1)

```json
{"action":"asset_upload","file":"C:\\art\\logo.png","asset_type":"Decal","name":"Logo","description":"HUD logo"}
{"action":"asset_upload","file":"C:\\audio\\beep.mp3","asset_type":"Audio","name":"Beep","creator":{"type":"Group","id":1234567}}
```

- `file` must be an absolute path. Content type comes from the extension: `.mp3 .ogg .wav .flac` (Audio), `.png .jpg .jpeg .bmp .tga` (Decal/Image), `.fbx .gltf .glb .rbxm .rbxmx` (Model / Animation / Mesh), `.mp4 .mov` (Video). `asset_type` is one of `Audio | Decal | Image | Model | Video | Animation | Mesh` (case-insensitive here; the server is case-sensitive, so `"animation"` is sent as `Animation`).
- `creator` defaults to the owner of the open place. The upload is a long-running operation; the tool polls `GET /assets/v1/operations/{id}` until `done` (bounded by `timeout_ms`, default 60 s). If the bound is hit you get `pending: true` and an `operation_id` to pass back (`{"action":"asset_upload","operation_id":"…"}`).
- The multipart POST itself is not idempotent (a replay would create a second asset), so instead of being retried it gets a timeout that scales with the file: `max(timeout_ms, 30 s + 1 s per 100 KB)`, capped at 5 min (`upload_timeout_ms` in the result). A 40 MB file therefore has 5 min to leave the machine; raise `timeout_ms` for a slow uplink on mid-sized files.
- Result: `asset_id`, `asset_type`, `moderation` normalised to `approved | reviewing | rejected` (the Assets v1 reference documents `moderationState` as `Reviewing | Rejected | Approved`; older examples show `MODERATION_STATE_APPROVED` — both spellings fold to the lower-case word, and the untouched value is in `moderation_raw`), `revision_id`, `use: "rbxassetid://<id>"`. Insert it in the place with the `run` tool once `moderation` is `approved`.

### 3.8 `asset` — the rest of the asset lifecycle

```json
{"action":"asset","op":"get","asset_id":5551234,"read_mask":"description,previews"}
{"action":"asset","op":"update","asset_id":5551234,"file":"C:\\art\\logo_v2.png"}
{"action":"asset","op":"update","asset_id":5551234,"name":"Logo","description":"HUD logo, v2"}
{"action":"asset","op":"versions","asset_id":5551234,"page_size":20}
{"action":"asset","op":"rollback","asset_id":5551234,"version":2}
{"action":"asset","op":"archive","asset_id":5551234}
{"action":"asset","op":"restore","asset_id":5551234}
```

- `update` with a `file` puts a **new version behind the same asset id** — for **FBX-based Model assets only**. Roblox answers `Updating Decal is not supported yet` for images (measured) and its guide says the same for audio, meshes and video, so the tool refuses any other file before uploading. Every `rbxassetid://` reference already placed in the game resolves to the new content once moderation approves it; `asset_upload` would have minted a new id instead. A content update is a long-running operation polled like an upload (`pending: true` + `operation_id` when `timeout_ms` passes; re-poll with `asset_upload` `operation_id`). `name` / `description` alone update metadata with an `updateMask`; the version stays the same.
- `versions` pages at most 50 (default 8), newest first. `rollback` restores a version number from that list by creating a **new** version with its content (measured: rolling back from v2 to v1 produced v3). The spec's schema says the body is multipart while its runnable sample sends JSON; Roblox accepts JSON (measured, `sent_as: "json"` in the result), and the tool keeps a one-time multipart retry on a `400` in case that changes.
- `archive` stops the asset resolving in experiences; `restore` brings it back. Not every type can be archived: a Model answered `400 … is not an archivable asset type`, while a Decal archived and restored fine (measured). Open Cloud has no asset delete.

### 3.9 `luau` — Luau Execution Sessions

```json
{"action":"luau","script":"local n = 0\nfor _, d in workspace:GetDescendants() do if d:IsA('BasePart') then n += 1 end end\nprint('parts', n)\nreturn n","timeout_ms":60000}
```

- Runs server-side in a **fresh copy of the published place** (its latest published version), not in the Studio session — so `publish` first, and read the results here rather than expecting changes in Studio. Use `run` for the open Studio DataModel.
- The tool creates the task with `timeout = "<ceil(timeout_ms/1000)>s"`, polls until `COMPLETE` / `FAILED` / `CANCELLED`, then fetches the logs. Result: `state`, `results` (the script's return values, JSON), `logs` (print/warn lines), `task` (the task path), `elapsed_ms`. A `FAILED` task is an error result with `task_error {code, message}` and the logs.
- If `timeout_ms` (default 60 s, max 5 min) passes while the task is still `QUEUED`/`PROCESSING` you get `pending: true` and `task`; call `{"action":"luau","task":"<path>"}` to keep waiting.
- Limits from the reference: script ≤ 4 MB, task ≤ 5 min, ≤ 10 incomplete tasks per place, 450 KB of logs retained.

### 3.10 `instance` — the Instance API (published place)

```json
{"action":"instance","op":"children"}
{"action":"instance","op":"get","instance_id":"<id from children>"}
{"action":"instance","op":"update","instance_id":"<id>","class_name":"ModuleScript","properties":{"Source":"return { speed = 24 }"}}
{"action":"instance","op":"update","instance_id":"<id>","class_name":"Script","properties":{"Enabled":false}}
```

- Reads and edits instances of the **published** place without opening it. `instance_id` defaults to `root` (the DataModel); walk down with `children`.
- Every call is long-running — the reads too. The tool polls the returned operation (`GET /cloud/v2/{operation path}`) until done or `timeout_ms`, then returns the instance or its children; a slow one comes back `pending: true` with `operation`.
- `children` lists compact entries — `id`, `name`, `class` and `has_children` — because the API's full resource per child put the root's ~90 services past the result cap (measured: 50 shown, 41 cut; the compact form lists them all in about 11 KB). `class` is present only for the four writable classes; the API sends every other instance with empty details. Walk down by `id`.
- Only four classes can be written, each with a fixed property set: `Script` / `LocalScript` (`Enabled`, `RunContext` = `Legacy | Server | Client | Plugin`, `Source`), `ModuleScript` (`Source`), `Folder` (none). Anything else is refused before sending — change it with `run` in Studio and `publish`. The API cannot create, delete or reparent instances. An update aimed at an instance of another class fails inside the operation with Roblox's `Incorrect Class Type: Instance is of type Part` (measured).
- `page_size` is accepted on `children`, but Roblox has not implemented `maxPageSize` there yet: the service returns as many children as it can regardless, and the result says so.

### 3.11 `restriction` — bans

```json
{"action":"restriction","op":"ban","id":100000001,"reason":"speed hack, log #4411","display_reason":"Banned for exploiting.","duration_s":604800}
{"action":"restriction","op":"ban","id":100000001,"reason":"…","display_reason":"…","level":"place"}
{"action":"restriction","op":"unban","id":100000001}
{"action":"restriction","op":"get","id":100000001}
{"action":"restriction","op":"list","page_size":50}
{"action":"restriction","op":"logs","filter":"user == \"users/100000001\""}
```

- `id` is the player's user id — it doubles as the restriction id.
- `level` is `universe` (default: every place in the experience) or `place` (the open place only, or `place_id`). It is never inferred from the session's place id, which would silently narrow every ban.
- `ban` needs both `reason` (the private moderation note) and `display_reason` (what the player sees). Omit `duration_s` for a permanent ban; `-1` is not how Open Cloud expresses that. `exclude_alts: true` keeps the ban off detected alt accounts. Open Cloud has no create or delete here: a ban is an upsert and `unban` is the same call with the ban lifted, which clears its reasons and duration.
- `logs` is universe-level only; its `filter` supports `user` and `place`. Log entries carry `active` / `duration` / `privateReason` at the top level, unlike a restriction, which nests them under `gameJoinRestriction`.
- Roblox rate-limits changes per user ("too many requests for user N in a short period"); user id 1 was throttled on the very first call. `ban` / `unban` are therefore never retried — wait a minute or use another account. Banning the owner's own account is allowed (measured with a 60 s ban, lifted at once).

### 3.12 `notify` — experience notifications

```json
{"action":"notify","id":100000001,"message_id":"5dd7024b-68e3-ac4d-8232-4217f86ca244","parameters":{"points":"50","userId-friend":3702832553},"launch_data":"room=7","analytics_category":"Bronze egg"}
```

- `message_id` is a notification string made in Creator Hub (Open Cloud cannot create one); `parameters` fill its `{placeholders}` — each a string or an integer, keyed exactly as in the string (hyphens included). `launch_data` (≤ 200 bytes) reaches the experience when the player taps the notification.
- Roblox checks opt-in on send: a recipient who has not opted in gets `400 FAILED_PRECONDITION` naming them (`not_opted_in: true`, measured). Players opt in from inside the experience (`ExperienceNotificationService:PromptOptIn`); Open Cloud cannot do it for them. An accepted send is delivered only if the player is otherwise eligible. Never retried, so a 5xx cannot send twice.

## 4. Errors, retries, limits

| `error.code` | Meaning / what the message tells the agent |
|---|---|
| `no_api_key` | where to put the key + permissions needed for this call |
| `no_ids` | open a place in Studio (published) or pass `universe_id` / `place_id` / `id` / `creator` |
| `bad_request` | argument validation (before any request) or a 400 from Roblox (server message included) |
| `unauthorized` | 401 — the key was rejected; message names where the key came from |
| `forbidden` | 403 — names the exact Creator Hub permission(s) and the universe to add |
| `not_found` | 404 — `looked_up` lists the ids/names used |
| `conflict` | 409/412 — etag mismatch or the resource already exists; for `publish`, usually a busy place (`likely_cause`) |
| `rate_limited` | 429 after 3 retries, or a `Retry-After` longer than 20 s (`retry_after_ms` given); restriction changes are not retried, since Roblox limits those per user |
| `server_error` / `http_error` | 5xx after 3 retries for idempotent calls; for a non-idempotent call the first 5xx is reported at once with `attempts: 1` and `not_retried`, because the server may already have applied it — check before repeating / other statuses |
| `network` / `timeout` | connection failure / no answer within the request timeout (30 s; file uploads scale with the file). Only idempotent calls are retried |
| `task_failed` / `upload_failed` | the Luau task, Instance API operation or asset operation ended in failure (details attached) |

- Every request has a 30 s per-attempt timeout (file uploads: see §3.6–3.7). A 429 is retried up to 3 times for every call (it was never processed); 5xx, network errors and timeouts are retried up to 3 times **only for idempotent calls** (GET, DELETE, full-value PATCH).
- Not idempotent, so never replayed after a 5xx: `datastore increment`, `ordered increment`, `message`, `memory queue_add` / `queue_discard`, `publish`, `asset_upload`, `asset update` / `rollback` / `archive` / `restore`, `luau` (create), `instance update`, `notify`.
- `Retry-After` is honoured (else 0.5 s → 1 s → 2 s). The capability report's probes are never retried at all.
- Logs (bridge stderr, `debug` level) contain method, path, status and duration only — never headers or bodies. That matters for key introspection, the one call that sends the key in the body.

## 5. Endpoints used (verified against the reference)

| Action | Method + path | Reference |
|---|---|---|
| datastore list_stores | `GET /cloud/v2/universes/{u}/data-stores` | [DataStore](https://create.roblox.com/docs/cloud/reference/DataStore) |
| datastore list_entries / get / set / delete / increment | `GET|POST …/data-stores/{store}[/scopes/{scope}]/entries`, `GET|PATCH?allowMissing=true|DELETE …/entries/{key}`, `POST …/entries/{key}:increment` | [DataStoreEntry](https://create.roblox.com/docs/cloud/reference/DataStoreEntry) |
| ordered * | `…/ordered-data-stores/{store}/scopes/{scope}/entries[/{key}]`, `:increment` | [OrderedDataStoreEntry](https://create.roblox.com/docs/cloud/reference/OrderedDataStoreEntry) |
| memory map_* | `GET …/memory-store/sorted-maps/{map}/items`, `GET|PATCH?allowMissing=true|DELETE …/items/{item}` | [Open Cloud reference](https://create.roblox.com/docs/cloud/reference) (MemoryStoreSortedMapItem) |
| memory queue_* | `POST …/memory-store/queues/{queue}/items`, `GET …/items:read`, `POST …/items:discard` | [Open Cloud reference](https://create.roblox.com/docs/cloud/reference) (MemoryStoreQueueItem) |
| message | `POST /cloud/v2/universes/{u}:publishMessage` `{topic, message}` | [Universe](https://create.roblox.com/docs/cloud/reference/Universe), [usage guide](https://create.roblox.com/docs/cloud/guides/usage-messaging) |
| info universe / place | `GET /cloud/v2/universes/{u}`, `GET /cloud/v2/universes/{u}/places/{p}` | [Universe](https://create.roblox.com/docs/cloud/reference/Universe), [Place](https://create.roblox.com/docs/cloud/reference/features/places) |
| info group / user / me | `GET /cloud/v2/groups/{g}`, `GET /cloud/v2/users/{id}` | [Group](https://create.roblox.com/docs/cloud/reference/Group), [User](https://create.roblox.com/docs/cloud/reference/User) |
| info memberships / roles | `GET /cloud/v2/groups/{g}/memberships`, `GET /cloud/v2/groups/{g}/roles` | [Open Cloud reference](https://create.roblox.com/docs/cloud/reference) (GroupMembership, GroupRole) |
| info inventory | `GET /cloud/v2/users/{id}/inventory-items` | [Inventories](https://create.roblox.com/docs/cloud/reference/features/inventories) |
| info subscription | `GET /cloud/v2/universes/{u}/subscription-products/{p}/subscriptions/{userId}?view=FULL` | [Users](https://create.roblox.com/docs/cloud/reference/features/users) |
| info key | `POST /api-keys/v1/introspect` `{"apiKey": …}` (key in the body, no `x-api-key` header; not in the OpenAPI spec) | [API keys](https://create.roblox.com/docs/cloud/auth/api-keys) |
| publish | `POST /universes/v1/{u}/places/{p}/versions?versionType=Published|Saved`, raw body as `application/octet-stream` or `application/xml` | [Place publishing](https://create.roblox.com/docs/cloud/guides/usage-place-publishing) |
| asset_upload | `POST /assets/v1/assets` (multipart `request` + `fileContent`), `GET /assets/v1/operations/{id}` | [Assets](https://create.roblox.com/docs/cloud/reference/features/assets), [usage guide](https://create.roblox.com/docs/cloud/guides/usage-assets) |
| asset get / update / versions / rollback / archive / restore | `GET|PATCH /assets/v1/assets/{id}`, `GET …/versions`, `POST …/versions:rollback`, `POST …:archive`, `POST …:restore` | [Assets](https://create.roblox.com/docs/cloud/reference/features/assets) |
| luau | `POST /cloud/v2/universes/{u}/places/{p}/luau-execution-session-tasks` `{script, timeout}`, `GET /cloud/v2/{task path}`, `GET /cloud/v2/{task path}/logs?view=FLAT` | [LuauExecutionSessionTask](https://create.roblox.com/docs/cloud/reference/LuauExecutionSessionTask), […TaskLog](https://create.roblox.com/docs/cloud/reference/LuauExecutionSessionTaskLog) |
| instance get / update / children | `GET|PATCH /cloud/v2/universes/{u}/places/{p}/instances/{id}`, `GET …/instances/{id}:listChildren`, then `GET /cloud/v2/{operation path}` | [Instance guide](https://create.roblox.com/docs/cloud/guides/instance) |
| restriction list / get / ban / unban | `GET …/user-restrictions`, `GET|PATCH …/user-restrictions/{userId}` under `/cloud/v2/universes/{u}` or `…/places/{p}` | [Open Cloud reference](https://create.roblox.com/docs/cloud/reference) (UserRestriction) |
| restriction logs | `GET /cloud/v2/universes/{u}/user-restrictions:listLogs` | [Open Cloud reference](https://create.roblox.com/docs/cloud/reference) (UserRestrictionLog) |
| notify | `POST /cloud/v2/users/{userId}/notifications` `{source: {universe: "universes/{u}"}, payload}` | [Notifications](https://create.roblox.com/docs/cloud/reference/features/notifications) |

All requests send `x-api-key` (except key introspection) and `accept: application/json`; JSON bodies send `content-type: application/json`; the asset upload and update are `multipart/form-data`; place publishing sends the raw file. Custom verbs (`:read`, `:discard`, `:listChildren`, `:rollback`, `:archive`, `:restore`, `:listLogs`) are sent with a literal colon.

## 6. Deliberately not exposed

- **Memory store `flush`** — wipes every sorted map and queue in the universe at once, with no per-structure form. No agent should be one argument away from it; run it from Creator Hub.
- **Group writes** (role assignment, join requests) and **place metadata / version notes** — not needed for building a game from Studio. The group membership PATCH is deprecated in favour of the assign/unassign verbs if they are ever added.
- **Not in Open Cloud at all**: memory store hash maps, a sorted-map increment, listing a universe's places, creating a place, deleting an asset, and creating / deleting / reparenting instances through the Instance API.

## 7. Wiring (for the bridge)

```ts
import { cloudToolName, cloudToolDescription, cloudToolShape, runCloudTool, type CloudContext } from './cloud/index.js';

const ctx: CloudContext = {
  home: config.home,                                   // STUDIO_LIVE_HOME
  log: (level, msg, data) => logger[level](msg, data), // bridge stderr logger
  ids: () => {                                         // from the active hub session, or null
    const s = registry.active();
    return s ? { universeId: s.studio.gameId, placeId: s.studio.placeId, creatorType: s.studio.creatorType, creatorId: s.studio.creatorId, placeName: s.studio.placeName } : null;
  },
};
server.tool(cloudToolName, cloudToolDescription, cloudToolShape, (args) => runCloudTool(args, ctx));
```

The hub must include `gameId` (`game.GameId`), `creatorType` (`game.CreatorType.Name`) and `creatorId` (`game.CreatorId`) next to `placeId` in its `hello` / `hb` `studio` block for the defaults to work; without them `cloud` still works with explicit ids.

## Group-owned keys (measured 2026-09-11)

A key created under a **group** works for everything universe-scoped — datastores, ordered datastores, messaging, asset upload, Luau execution, universe/place info — but Roblox's Groups and Users endpoints answer `401 "Only OAuth tokens and User API keys are supported"` for it. The `cloud` tool reports this as `unauthorized` with `key_type_limit: true` and a message naming the cause; it is not a bad key. Create a user-owned key in Creator Hub if you need `info group` / `info user` / `info memberships` / `info roles` / `info inventory` (inventory words its refusal as `401 Authentication type provided was invalid!`, measured 2026-09-14; the tool reports both wordings as `key_type_limit`). Introspection cannot tell a group-owned key from a user-owned one, which is why the capability report leaves those five `unknown` when their scope is held.
