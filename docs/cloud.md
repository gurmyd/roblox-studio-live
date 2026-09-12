# Studio Live — Roblox Open Cloud (`cloud` tool)

One MCP for everything Roblox: the `cloud` tool talks to [Open Cloud](https://create.roblox.com/docs/cloud) (`https://apis.roblox.com`) for the place that is open in Studio. Agents never ask for universe / place / group / user ids — they come from the connected Studio session. The API key is read from disk on every call, so it can be created, rotated or revoked without restarting the bridge.

Module: `bridge/src/cloud/` (public surface in `index.ts`). Tests: `tests/cloud/`.

## 1. Setup

### 1.1 Create an API key

1. Open [Creator Hub → Open Cloud → API Keys](https://create.roblox.com/dashboard/credentials) and **Create API Key**.
2. Under **Access Permissions** add the API systems you need (table below) and, for each, select the experience (universe) the open place belongs to — or the group/user for Assets.
3. Set the key's IP restriction to your machine (or none while developing) and an expiry, then copy the key. It is shown once.

### 1.2 Put the key where the bridge looks (checked in this order, on every call)

| Where | Format |
|---|---|
| env `ROBLOX_OPEN_CLOUD_KEY` | the key |
| `<STUDIO_LIVE_HOME>/opencloud.json` | `{"key":"…"}` |
| `<STUDIO_LIVE_HOME>/opencloud.key` | the key as plain text (whitespace trimmed) |

`STUDIO_LIVE_HOME` defaults to `~/.studio-live` (Windows: `C:\Users\<you>\.studio-live`). Both files may carry a UTF-8 byte-order mark and CRLF line endings (what PowerShell's `Out-File` / `Set-Content -Encoding utf8` and Notepad write by default). The key is **never cached, logged, or echoed**; if any server response happens to contain it, the result shows `sk…` instead. When no key is found the tool answers `error.code = "no_api_key"` with these three locations and the permissions the call would have needed.

Optional: `ROBLOX_OPEN_CLOUD_BASE_URL` overrides the API host (tests / proxies). Default `https://apis.roblox.com`.

### 1.3 Permissions per action

Scope names are the ones printed in the official reference for each operation; the first column is the API system in Creator Hub. A `403` result repeats the exact line for the call that failed.

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
| `message` | Messaging Service → `universe-messaging-service:publish` |
| `info` `universe` / `place` | the experience must be on the key; the reference lists no extra scope for Get Universe / Get Place |
| `info` `group` | Groups → Read (`group:read`) |
| `info` `user` | Users → Read (`user.advanced:read`; `user.social:read` for social profiles) |
| `info` `me` | the group or user line above, depending on who owns the place |
| `asset_upload` | Assets → Read + Write (`asset:read`, `asset:write`) for the creator (user or group) that will own the asset |
| `luau` | Luau Execution Sessions → Write (`universe.place.luau-execution-session:write`) for the experience |

## 2. How ids are inferred

Every call needs some ids. They default from the active Studio session (`hello` / `hb` frames of the hub), and explicit arguments always win:

| Id | Default (from Studio) | Override argument |
|---|---|---|
| universe | `game.GameId` | `universe_id` |
| place | `game.PlaceId` | `place_id` |
| creator (owner) | `game.CreatorType` / `game.CreatorId` | `creator {type:"User"|"Group", id}` (asset_upload), `id` (info group/user) |

Results echo what was used: `universe_id`, `place_id`, `ids_from: "studio" | "args" | "mixed"`.

If no Studio is connected and no id was passed → `error.code = "no_ids"` ("Open the place in Roblox Studio … or pass universe_id"). If the open place is unpublished (`GameId` 0) the message says to publish it first. `universeId`, `creatorType` and `creatorId` travel only in the hub's `hb` frames (protocol §2.7), so for up to one heartbeat interval after Studio connects they are still unknown; a call in that window gets a distinct `no_ids` message ("not known yet … arrives with the next heartbeat; retry in a few seconds, or pass universe_id") rather than the publish hint, so an agent never publishes a place that is already published. `info what:"me"` is the owner of the open place (the key itself has no identity endpoint).

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

### 3.3 `message` — MessagingService publish

```json
{"action":"message","topic":"Announce","message":{"kind":"reload","reason":"agent patched Main"}}
```

JSON is sent stringified; the payload must be ≤ 1 KB and the topic ≤ 80 chars (checked before sending). The message reaches `MessagingService:SubscribeAsync("Announce")` in **live servers** of the universe — not in Studio playtests.

### 3.4 `info` — who/what is this place

```json
{"action":"info","what":"universe"}
{"action":"info","what":"place"}
{"action":"info","what":"me"}
{"action":"info","what":"user","id":100000001}
```

`universe` returns `displayName`, `description`, `visibility`, `rootPlace`, `ageRating`, device flags, `user` or `group` owner path; `place` returns `displayName`, `description`, `serverSize`, `root`; `group` / `user` return the Open Cloud v2 resources.

### 3.5 `asset_upload` — Assets API (v1)

```json
{"action":"asset_upload","file":"C:\\art\\logo.png","asset_type":"Decal","name":"Logo","description":"HUD logo"}
{"action":"asset_upload","file":"C:\\audio\\beep.mp3","asset_type":"Audio","name":"Beep","creator":{"type":"Group","id":1234567}}
```

- `file` must be an absolute path. Content type comes from the extension: `.mp3 .ogg .wav .flac` (Audio), `.png .jpg .jpeg .bmp .tga` (Decal/Image), `.fbx .gltf .glb .rbxm .rbxmx` (Model / Animation / Mesh), `.mp4 .mov` (Video). `asset_type` is one of `Audio | Decal | Image | Model | Video | Animation | Mesh` (case-insensitive here; the server is case-sensitive, so `"animation"` is sent as `Animation`).
- `creator` defaults to the owner of the open place. The upload is a long-running operation; the tool polls `GET /assets/v1/operations/{id}` until `done` (bounded by `timeout_ms`, default 60 s). If the bound is hit you get `pending: true` and an `operation_id` to pass back (`{"action":"asset_upload","operation_id":"…"}`).
- The multipart POST itself is not idempotent (a replay would create a second asset), so instead of being retried it gets a timeout that scales with the file: `max(timeout_ms, 30 s + 1 s per 100 KB)`, capped at 5 min (`upload_timeout_ms` in the result). A 40 MB file therefore has 5 min to leave the machine; raise `timeout_ms` for a slow uplink on mid-sized files.
- Result: `asset_id`, `asset_type`, `moderation` normalised to `approved | reviewing | rejected` (the Assets v1 reference documents `moderationState` as `Reviewing | Rejected | Approved`; older examples show `MODERATION_STATE_APPROVED` — both spellings fold to the lower-case word, and the untouched value is in `moderation_raw`), `revision_id`, `use: "rbxassetid://<id>"`. Insert it in the place with the `run` tool once `moderation` is `approved`.

### 3.6 `luau` — Luau Execution Sessions

```json
{"action":"luau","script":"local n = 0\nfor _, d in workspace:GetDescendants() do if d:IsA('BasePart') then n += 1 end end\nprint('parts', n)\nreturn n","timeout_ms":60000}
```

- Runs server-side in a **fresh copy of the published place** (its latest published version), not in the Studio session — so publish first, and read the results here rather than expecting changes in Studio. Use `run` for the open Studio DataModel.
- The tool creates the task with `timeout = "<ceil(timeout_ms/1000)>s"`, polls until `COMPLETE` / `FAILED` / `CANCELLED`, then fetches the logs. Result: `state`, `results` (the script's return values, JSON), `logs` (print/warn lines), `task` (the task path), `elapsed_ms`. A `FAILED` task is an error result with `task_error {code, message}` and the logs.
- If `timeout_ms` (default 60 s, max 5 min) passes while the task is still `QUEUED`/`PROCESSING` you get `pending: true` and `task`; call `{"action":"luau","task":"<path>"}` to keep waiting.
- Limits from the reference: script ≤ 4 MB, task ≤ 5 min, ≤ 10 incomplete tasks per place, 450 KB of logs retained.

## 4. Errors, retries, limits

| `error.code` | Meaning / what the message tells the agent |
|---|---|
| `no_api_key` | where to put the key + permissions needed for this call |
| `no_ids` | open a place in Studio (published) or pass `universe_id` / `place_id` / `id` / `creator` |
| `bad_request` | argument validation (before any request) or a 400 from Roblox (server message included) |
| `unauthorized` | 401 — the key was rejected; message names where the key came from |
| `forbidden` | 403 — names the exact Creator Hub permission(s) and the universe to add |
| `not_found` | 404 — `looked_up` lists the ids/names used |
| `conflict` | 409/412 — etag mismatch or the resource already exists |
| `rate_limited` | 429 after 3 retries, or a `Retry-After` longer than 20 s (`retry_after_ms` given) |
| `server_error` / `http_error` | 5xx after 3 retries for idempotent calls; for a non-idempotent call (`increment`, `message`, `luau` create, `asset_upload` create) the first 5xx is reported at once with `attempts: 1` and `not_retried`, because the server may already have applied it — check before repeating / other statuses |
| `network` / `timeout` | connection failure / no answer within the request timeout (30 s; the asset upload POST scales with the file). Only idempotent calls are retried |
| `task_failed` / `upload_failed` | the Luau task or asset operation ended in failure (details attached) |

- Every request has a 30 s per-attempt timeout (the create-asset POST: see §3.5). A 429 is retried up to 3 times for every call (it was never processed); 5xx, network errors and timeouts are retried up to 3 times **only for idempotent calls** (GET, DELETE, full-value PATCH). `Retry-After` is honoured (else 0.5 s → 1 s → 2 s).
- Logs (bridge stderr, `debug` level) contain method, path, status and duration only — never headers or bodies.

## 5. Endpoints used (verified against the reference)

| Action | Method + path | Reference |
|---|---|---|
| datastore list_stores | `GET /cloud/v2/universes/{u}/data-stores` | [DataStore](https://create.roblox.com/docs/cloud/reference/DataStore) |
| datastore list_entries / get / set / delete / increment | `GET|POST …/data-stores/{store}[/scopes/{scope}]/entries`, `GET|PATCH?allowMissing=true|DELETE …/entries/{key}`, `POST …/entries/{key}:increment` | [DataStoreEntry](https://create.roblox.com/docs/cloud/reference/DataStoreEntry) |
| ordered * | `…/ordered-data-stores/{store}/scopes/{scope}/entries[/{key}]`, `:increment` | [OrderedDataStoreEntry](https://create.roblox.com/docs/cloud/reference/OrderedDataStoreEntry) |
| message | `POST /cloud/v2/universes/{u}:publishMessage` `{topic, message}` | [Universe](https://create.roblox.com/docs/cloud/reference/Universe), [usage guide](https://create.roblox.com/docs/cloud/guides/usage-messaging) |
| info universe / place | `GET /cloud/v2/universes/{u}`, `GET /cloud/v2/universes/{u}/places/{p}` | [Universe](https://create.roblox.com/docs/cloud/reference/Universe), [Place](https://create.roblox.com/docs/cloud/reference/Place) |
| info group / user / me | `GET /cloud/v2/groups/{g}`, `GET /cloud/v2/users/{id}` | [Group](https://create.roblox.com/docs/cloud/reference/Group), [User](https://create.roblox.com/docs/cloud/reference/User) |
| asset_upload | `POST /assets/v1/assets` (multipart `request` + `fileContent`), `GET /assets/v1/operations/{id}` | [Assets](https://create.roblox.com/docs/cloud/reference/features/assets), [usage guide](https://create.roblox.com/docs/cloud/guides/usage-assets) |
| luau | `POST /cloud/v2/universes/{u}/places/{p}/luau-execution-session-tasks` `{script, timeout}`, `GET /cloud/v2/{task path}`, `GET /cloud/v2/{task path}/logs?view=FLAT` | [LuauExecutionSessionTask](https://create.roblox.com/docs/cloud/reference/LuauExecutionSessionTask), […TaskLog](https://create.roblox.com/docs/cloud/reference/LuauExecutionSessionTaskLog) |

All requests send `x-api-key` and `accept: application/json`; JSON bodies send `content-type: application/json`; the asset upload is `multipart/form-data`.

## 6. Wiring (for the bridge)

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

A key created under a **group** works for everything universe-scoped — datastores, ordered datastores, messaging, asset upload, Luau execution, universe/place info — but Roblox's Groups and Users endpoints answer `401 "Only OAuth tokens and User API keys are supported"` for it. The `cloud` tool reports this as `unauthorized` with `key_type_limit: true` and a message naming the cause; it is not a bad key. Create a user-owned key in Creator Hub if you need `info group` / `info user`.
