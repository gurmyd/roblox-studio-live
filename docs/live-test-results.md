# Live test results — v1 against Roblox Studio 0.738 (2026-09-11)

Place: PIRATES (Team Create), one Studio, installed plugin `StudioLive.rbxmx`, bridge `node dist/bridge/cli.js serve` on 47800, tools called via `POST /rpc`, push armed with Claude Code `Monitor(ws://127.0.0.1:47800/events)`.

## Install / lifecycle
- Studio start → plugin ran at +13.7 s → `[StudioLive] connected` at +14.1 s (0.35 s after the plugin ran). Session shows `bootstrap 1.0.0`, `bundle sha256-ec416…`.
- Bridge restart with a changed runtime: hub reconnected in 0.5 s, new bundle delivered to the hub **and both play DataModels in ~15 ms** while the playtest kept running (`agent runtime started (client:1, bundle sha256-1c44e…)`).
- Proactive 25-minute socket refresh observed twice (disconnect → reconnect in 130 ms, no lost requests).

## Acceptance tests
| Test | Result |
|---|---|
| **T4** 2000-part arena as one undo step | `run` built 2001 parts + model in **70 ms** (`changes.added: 2002`, `undo: committed`); one `Undo()` removed all of it (see below) |
| **T1** controller playing for 60 s with assertions | `playtest start` 1.9 s (server + client:1 peers); `install walker` 35 ms; assertions/milestones/telemetry arrived as pushed events for the whole run; `ctx.storage` survived reinstall (`runs` 1→2→3) |
| **T3** failing assertion reaches the agent unprompted | `reached_door ok:false` arrived via Monitor with no tool call |
| **T2** change behaviour without restarting | `run dm=server` created `DoorOpener` (ephemeral) with a bug; `playtest hotpatch` fixed it in **62 ms**; `run_until` saw the door open on the next frame; walker run 3 then passed `door_opens` |
| Stop → start cycle | `playtest stop` 0.97 s (server `EndTest`), `start` 1.44 s, persisted walker **re-installed automatically** |
| `input` | key hold/edge, jump, absolute mouse move, GUI-space click (`Activated` fired), `look` (after the in-frame fix: 34 ms, camera rotated) |
| `observe` | status/tree/props/find/logs/stats/player/screenshot (whole window, 1000 px JPEG, 227 ms) |
| Edit-side `run` | value/output capture, error → rollback verified, `dry_run` verified, skills save/run, job handles, `S.script.create/get/patch` |
| Hub `selftest` | 26/26 checks |

## Defects found live and fixed during the session
1. `run.changes` missed same-frame additions (deferred signals) → flush one frame before counting.
2. `skills run` ignored `dry_run` → forwards the full run body now.
3. `observe find` matched `Stats.*` internals → skip list when root is `game`.
4. `observe tree fields` emitted `<unreadable>` → omitted.
5. `placeName` was `game.Name` → `MarketplaceService:GetProductInfo` async, reported via hb.
6. `playtest start` timing out left a playtest the tool cannot stop → message says so.
7. Cold screenshot worker → pre-warmed at bridge start.
8. `S.moveTo` judged arrival by straight-line distance → horizontal distance (callers rarely know the root height).
9. `input look` sent the delta in the same frame as `LockCenter` → "cursor is not locked"; now waits for the lock to take effect.
10. Docs: `ctx.character()` returns the Character **model** (guide example corrected).

## Known gaps (not blocking)
- Persisted controllers survive playtest restarts but **not a hub runtime restart** (bundle update while a playtest runs): the persist list lives in hub memory. Planned: keep it in the bridge per session and re-issue installs on peer hello. *(v1.1 first attempt: `plugin:SetSetting` keyed by the session GUID — **dead on arrival**: `plugin:GetSetting` returns `nil` for every key in this build, see the v1.1 results below. Persistence now lives in the bridge, as originally planned — L1.)*
- `custom` events from busy controllers are pushed at up to 10 frames/s; use `ctx.log` or lower emit rates for telemetry (documented in the guide).
- The fan-out heartbeat's `playtest` flag lags the hub's last hb by up to 10 s. *(v1.1: the bridge follows `playtest` events between heartbeats and the hub sends an extra `hb` on every state change — offline-verified; live check pending.)*
- `SendPointerAction` (scroll) dictionary shape still unknown → `input` has no scroll action. *(v1.1: measured — it accepts any dictionary and produces no MouseWheel events; scroll stays unsupported by design.)*

## v1.1 — to verify live (offline-verified against `scripts/fake-hub.mjs`, `npm run selftest` 43/43)
30 concurrent edit-DM `run`s (all `ok`, none `busy`, one `queued behind N` progress note each); `playtest start mode=multiplayer` / `add_players` / `stop` through the tool; `push` into a running playtest (server → replicated, client → local); persisted controllers reappearing after a bridge restart with a changed runtime; `studio-live sync` push + pull + hotpatch against a scratch folder.

## Fix pass 2 — to verify live (runtime changes are offline-lintable only; bridge changes are unit-tested)
- `playtest stop` on a multiplayer test immediately followed by `playtest start mode=play`: the start must wait for the closing clients (≤ 5 s) and the new client must be `client:1` (not `client:3`); a persisted `client:1` controller must land in it.
- `playtest stop` when the server agent cannot end the test (e.g. hub runtime pushed while the server agent's bundle failed): the `timeout` message must name the cause, and a dead server peer must be dropped so the next `start` is not `busy`.
- `add_players {count:1}` on a running multiplayer test: `via: "edit"` expected (AddPlayers from the edit DM); if it throws synchronously there, `via: "server"`; `hb.playtest.players` rises at once; `joined`/`complete` follow the real client count.
- A `run` that waits > 5 s in the write queue but runs 1 ms: **no** `job` event; a program that runs > 5 s: one `job done` event.
- ~~`install persist=true` with a > 256 KB controller: response `persist: false` + `persist_note`, one `controller state=error` event; the entry is not stored.~~ *Superseded by L1 (fix pass 3): the hub no longer caps or stores anything; the bridge refuses an entry that would take the place past 8 MB with `persist: false` + `persist_note` and emits no event.*
- `playtest push` of two roots with the same name under different parents (`Workspace.Left.Door`, `Workspace.Right.Door`): each lands under its own parent, no `StudioLivePushIndex` attribute left on either side.
- `STUDIO_LIVE_DEV=1` bundle swap ×3 while a playtest runs: no stale `playtest` event / `hb` from the old runtime (watch `/events` for duplicate seqs), exactly one `Unloading` handler (persist key cleared once when the place closes).
- `skills run settle_physics {seconds: 30, dt: 0.02}` without `timeout_ms`: refused up front with the message naming the needed `timeout_ms`; with `timeout_ms: 40000` it completes.
- `look {question}` with a Claude credential in the bridge environment; `look {watch}` producing `vision` events on the default Monitor socket and `done` after `max_frames`; `cloud {action:"info", what:"universe"}` with a key file present → ids from the open place (`ids_from: "studio"`).

## v1.1 — live results (2026-09-11, Studio 0.738, place PIRATES)

Same setup as above with the v1.1 runtime and bridge; tools driven through `POST /rpc` and `studio-live call`. The "to verify live" items from the section above resolve as follows (the sync check and the fix-pass-2 list are still open).

| Item | Result |
|---|---|
| Edit-DM write queue | **30 concurrent `run`s**: all `ok`, zero `busy`. **100 concurrent `run`s**: all `ok`, zero `busy`. The FIFO serialised them; waiting requests got their one `queued behind N` progress note. Observed cost: the queue drained **one write per frame** (33 queued writes ≈ 530 ms) → L3 below. |
| Multiplayer | `playtest start mode=multiplayer`: **24 s** until server and both client Studios had said hello (the call returned a job handle first, `job wait` collected it). `add_players`: **11 s** until the new client peer connected. `stop`: **0.45 s**, every client window closed. |
| Push | `playtest push` of a probe model (`PushProbe`) to `server`: **72 ms** serialize, replicated to the client (visible in the client's tree) — and a second push added a **second** `PushProbe` next to the first → L2 below. |
| Persisted controllers | Could not be verified through plugin settings: **`plugin:GetSetting` returns `nil` for every key** in this build — immediately after `SetSetting`, after 1 s, and for keys the other installed plugin wrote. → L1 below. |
| Change counting | A `run` on `client:1` that created nothing reported `changes.added: 1` — the path was `VoiceChatInternal`, an engine-internal instance → L4 below. |
| Multi-agent build (Coin Rush) | Five builders + one tester/fixer, one Studio, ~22 min to PASS — summary below, full account in [multi-agent-build-report.md](multi-agent-build-report.md). |

### Findings measured live → fix pass 3 (implemented; live re-check pending)

1. **L1 — plugin settings are dead.** `plugin:GetSetting` never returns a stored value in Studio 0.738, so `hub/persist.luau`'s durable list could not work. Persistence moved to the **bridge**: `install persist=true` stores `{placeId, dm, name, code}` in memory per session and in `<home>/persist/<placeId>.json`, `uninstall` removes it, and every hub hello (including after a bundle push / runtime restart) receives `persist_sync {controllers:[{dm,name,code}]}` which replaces the hub's in-memory list; the hub keeps installing persisted controllers on every peer hello. `playtest list` shows them with `source: "bridge"`; `hub/persist.luau` is an in-memory registry and the selftest no longer touches settings.
2. **L2 — `push` duplicated.** The server held two `PushProbe` models after two pushes. `push` now takes `replace` (default `true`): `push_apply` un-parents an existing same-named sibling under the target parent before parenting the new root and reports `replaced: n`; `replace: false` keeps both.
3. **L3 — one queued write per frame.** 33 queued writes took ≈ 530 ms. The dispatcher now drains consecutive queued writes in the same frame while the 8 ms cooperative slice allows, then yields.
4. **L4 — engine-internal instances in change counts.** Descendants of `CoreGui`, `CorePackages`, `RobloxReplicatedStorage`, `VoiceChatInternal`, `PluginGuiService`, `RobloxPluginGuiService`, `Stats`, and anything whose name starts with `RobloxReplicated` are ignored by the run change journal and by the throttled `change` events.

The [multi-agent build report](multi-agent-build-report.md) added F1–F10 (file-based code arguments and the "Malformed string" hint, undoable `S.destroy`, startup logs with real seqs, `observe logs dm:"all"`, script line ranges, `ctx.pathTo`, unwritable-property tolerance, explicit `observe tree` roots, `S.ensure` + the multi-agent contract) and the `studio-live twin` launcher; all are documented in the agent guide and marked (v1.1) until the next live pass.

### Coin Rush — six agents, one Studio

Five Claude Code subagents (map, coins, rounds, hud, atmosphere) built a playable "Coin Rush" **concurrently** in the same edit DataModel through `POST /rpc` — 250-part arena with platforms and 36 `CoinSpot` markers, a 20-coin spawner, a 10/45/5 s round loop with leaderstats, a HUD with pickup flash, sunset atmosphere and decor — in ~6 minutes of wall clock, every program one undo step (`undo: committed`), **no `busy`, no `queued behind N`**, every DataModel call under 150 ms. A tester agent then ran a play playtest with a `coinbot` controller on `client:1` (2 × 40 s), `run_until` on the server and `observe logs`; round 1 failed on one blocking bug (a coin touch scored ~8 times because the debounce was cleared after `Destroy()`, and coins respawned under the idle player), a fixer patched the live script in one undo step, round 2 passed every assertion (`coins_cap_20` 36/36, `score_delta_is_one` 44/44, `coincollected_fires_once` 44/44, `respawn_clearance` 45/45, zero warn/error lines). Total ≈ 22 minutes from the first builder program to PASS; fix rounds: 1. The friction was entirely in how agents got Luau into the tools (shell escaping, F1), `dry_run` losing `:Destroy()`ed instances (F2), invisible startup prints (F4) and 8 KB script reads (F6) — none of it bridge latency. Details, timeline and every friction point: [multi-agent-build-report.md](multi-agent-build-report.md).

## Fix pass 3 — to verify live (offline state: `npm run selftest` 51/51, `npm test` 259/259, `luau:check` clean, rbxmx 18515 chars)

The bridge side of L1/L2/F1/F5/F6/T is unit- and selftest-covered against `scripts/fake-hub.mjs`, which now mirrors the hub's `persist_sync` semantics; the runtime side is lint-only until Studio runs it. In order of risk:

1. **Hub `selftest`** after the first connect: every new check must pass — `dispatcher.drain` (40 queued writes in ≤ 8 Heartbeats), `run.flushSubFrame` (six change-making runs in ≤ 2 Heartbeats; `flush` should read `deferred`, `frame` means the sentinel trick does not hold on this build), `S.destroy.restoreOnCancel`, `observe.scriptBudget`, `S.set.unwritable`, `S.ensure`, `run.escapes`.
2. **L1 end to end:** `install persist=true` → `<home>/persist/<placeId>.json` written → `playtest list` shows `source: "bridge"` → `playtest stop` / `start` re-installs → bridge restart (`persist_sync` on hello) → `STUDIO_LIVE_DEV=1` bundle push mid-test: the agents re-hello before the new hub runtime gets its sync, so the sync must install the controller on the already-connected peers (`installs_issued` ≥ 1 in the bridge debug log, one `controller installed` event per peer, none duplicated).
3. **L2:** `playtest push` of `PushProbe` twice → one `PushProbe` on the server, `replaced: 1`, the client sees the replacement; `replace: false` → two.
4. **L3:** 33 queued edit-DM writes should drain in a handful of frames (previously ≈ 530 ms); `observe status → writeQueue` never shows `busy`.
5. **L4:** a `run` on `client:1` that creates nothing reports `changes.added: 0` (no `VoiceChatInternal`).
6. **F4/F5:** `[CoinSpawner]`-style server-start prints come back from `observe logs {dm: "server", since: <seq at start>}` with `history: true`; `dm: "all"` shows the server line once (the client's mirrored copy deduped).
7. **F7:** `ctx.pathTo` on a client with a target on a deck above the bot: `reached: true`, or a `reason` from the documented list.
8. **F8:** `S.set(game.Lighting, { Technology = … })` → `unwritable: [{path: "Lighting", prop: "Technology", reason}]`, program not rolled back.
9. **F1 hint:** a `run` with a raw newline inside a quoted literal → `syntax_error … Malformed string — your transport turned \n into a newline …` (loadstring on edit / server; the ModuleScript path on a client must still classify it as `syntax_error`).
10. **T:** `studio-live twin C:\…\copy.rbxl` → a second Studio, its session in `GET /status` within 90 s, writes then require `session`; two Studios on the same `placeId` share one persist file (last writer wins on disk).

## Fix pass 4 — to verify live (offline state: `npm run selftest` 52/52, `npm test` 263/263, `luau:check` clean, rbxmx 18515 chars)

A review of the fix-pass-3 tree found 23 defects; all were fixed offline (protocol Notes "(fix pass 4, …)"). The bridge side is unit- and selftest-covered; the runtime side needs Studio. In order of risk:

1. **Removals are counted (Deferred signals).** `run { code = "S.destroy('Workspace.Old')" }` on the edit DM must answer `changes.removed ≥ 1` with `paths: ["Workspace.Old"]` (previously `removed: 0` — the handler ran after `Parent` was nil). Same for a `:Destroy()` in a program, for `push` with `replace` (`replaced: 1` and the server run's `change` journal), and for a human pressing Delete (`observe diff` lists it). Hub `selftest` must pass `journal.removedAfterDetach` and `run.changesRemoved`. Watch `change` events for noise from Studio's own UI: instances that existed before the runtime started and are removed later are counted under their own name (expected rare).
2. **Startup prints, repeated.** A server script printing the same line 20× at start → `observe logs {dm:"server", since:N}` shows 20 lines; in Play Solo `dm:"all"` shows the client's mirrored copies dropped (or, if the client seeded first, twice — never fewer). In a multiplayer test no client line is ever dropped.
3. **`S.ensure("Workspace.X")` without a class** on an existing Model returns it (`created: false`); with `"Folder"` it still errors.
4. **`unwritable` warnings.** `S.set(part, { Colour = … })` → `unwritable: [{prop: "Colour"}]` plus `warnings: ["1 property could not be written … Part.Colour"]`; the program is not rolled back.
5. **Push replace by class.** Push a Folder named like an existing Script → `skipped: [{path, reason: "class Script ≠ Folder"}]`, `replaced: 0`; in a multiplayer test push `ServerStorage.Rigs.Player1` to `Workspace` → the live character `Workspace.Player1` survives (`skipped` says `player character`).
6. **Failed persisted install is not re-issued on every sync.** Persist a controller whose `load` throws, then `install`/`uninstall` an unrelated controller a few times: exactly one `controller state=error` event per peer hello, none per sync; `playtest status → persisted[0].error` names the failure; the next `playtest start` retries once.
7. **Write-queue slice.** 33 queued writes that each do ~5 ms of work with an `S.yield()` inside: frame time stays near 8–10 ms per frame of the drain (previously up to 16 ms+).
8. **`observe script`** on a one-line minified ModuleScript: `line_cut: true`, `next_from` = the same line, `note` present; `response_format: "detailed"` returns more of it.
9. **`observe tree {root, classes}`** on a Folder root with `classes: ["BasePart"]`: the root node comes back first.
10. **`ctx.pathTo`** to a goal 4 studs off the navmesh → `false, "unreachable:<d>"` quickly (not `stuck` after three recomputes); kill the character mid-walk → `no_character`; after any return the character stops walking.
11. **Persistence bookkeeping.** `install persist:true wait_ms:0` on a slow client → `{status:"running", persist_pending:true}`; once the job finishes `playtest list` shows the entry and `<home>/persist/<placeId>.json` has it (tagged `session`). `uninstall dm:"client:1"` with no playtest running → `{uninstalled:false, persisted_removed:true}` and the file entry gone (previously the raw `no_peer`). Read-only `STUDIO_LIVE_HOME` → `persist_note` instead of `persist_file`.
12. **Twin on the same placeId.** Original installs `walker`, twin installs `probe`, twin uninstalls `probe`: the file keeps `walker`; bridge restart → the original still gets `walker`. `studio-live twin copy.rbxl --exe <path>` and a per-machine Studio under `%ProgramFiles(x86)%\Roblox\Versions` are found; a bogus `--exe` fails at once with exit 1.
13. **CLI exit.** `node -e "require('child_process').execFile('studio-live', ['call','observe'], (e,o)=>console.log(e?.code, o))"` returns (previously hung on the piped stdin); `studio-live twin place.rbxl --timeout 120s` is refused up front.

## Final live verification — v1.2 (2026-09-11, evening)

All on the installed plugin (bootstrap unchanged since install) with runtime bundles hot-loaded across four bridge restarts, one of them mid-playtest.

| Check | Result |
|---|---|
| Hub `selftest` | **47/47** (queue drain, persist registry/sync, journal filters, `dm: all` logs, history dedupe, explicit tree root, script ranges, escapes, sub-frame change flush, `S.destroy` restore-on-Cancel, `S.set` tolerance, `S.ensure`) |
| Write queue | 30 concurrent callers: 0 errors, writes p50 109 ms; 100 concurrent: 0 errors, wall 611 ms (was 9/10 and 31/33 `busy` before) |
| Multiplayer via the tool | `start mode=multiplayer players=2` 24 s → `server`, `client:1` (Player1), `client:2` (Player2); `run` on `client:2`; `add_players 1` +11 s → `client:3`; `stop` 0.45 s |
| Push into a live playtest | 72 ms serialize, 0.7 ms apply, replicated to the client; with `replace` (default) the live copy is replaced (`replaced: 1`, 10/10 recoloured parts, one model) |
| Persistence | `install persist:true` → `~/.studio-live/persist/<placeId>.json`; runtime restart mid-playtest (new bundle) → hub + both play DMs restarted in one frame and the controller was **re-installed automatically** (`persist_probe_loaded` again); `uninstall` removes the entry and the empty file |
| `ctx.pathTo` | bot walked from the floor onto the 18-stud PlatformHigh deck in **5.5 s** (PathfindingService); `run_until` on the client confirmed y > 17 in 4.4 s |
| File-based code | `run {code_file}` and `studio-live call run --code-file` compile Luau containing `\n`, `\t` and `[^\n]+` untouched (the shell-escaping detour from the multi-agent test is gone) |
| Undo-safe destroy | `dry_run` `S.destroy` of a pre-existing instance (`Workspace.SpawnLocation`) → present again after Cancel; raw `:Destroy(` produces a `warnings` entry |
| Rojo-lite sync | pull 3 scripts → edit a file → `sync --once` pushed the change in 115 ms as one undo step (`updated 1, unchanged 2`); reverted the same way |
| Merged logs / script ranges | `observe logs dm=all` merges peers with `src`; `observe script from/to` returns line ranges with `total_lines` |
| Tools without credentials | `cloud info` → `no_api_key` naming the three key locations and the Creator Hub URL; `look` → captures the frame, then names the missing Anthropic credential; `tools/list` over stdio: 9 tools, all descriptions < 2 KB |
| Multi-agent build | Coin Rush: 5 builders concurrently, ~6 min wall, 1 fix round, PASS — docs/multi-agent-build-report.md |

Engine facts learned tonight (Studio 0.738): `plugin:GetSetting` returns nil for every key (persistence moved to the bridge); assigning a non-numeric string to a number property silently coerces to 0 (no error); `ChangeHistoryService` can only restore instances it tracks — present at place load or created inside a recording; a bare `Instance.new` outside any recording is invisible to a later Cancel (every agent `run` is a recording, so this only affects plugin-internal code).

Known cosmetic gap: `changes.paths` for a removed instance the journal never saw added (created before the runtime started) shows the bare name (`"SpawnLocation"`) instead of the full path.

## Geometry guard + vision via Claude Code — live (2026-09-11, late)

| Check | Result |
|---|---|
| Hub `selftest` | 56/56 (adds geometry.overlaps/nested, S.placeOn, S.fits, run.geometryWarn/Reject, observe.geometry) |
| `observe what=geometry` on the Coin Rush arena (267 parts) | **27 overlaps, 0 nested** in 1.3 ms: every wall's gold trim sunk 1 stud into its wall, trims overlapping at corners, beacon posts sunk 0.6 studs into bases — the "parts in parts" the user described |
| `run` with an overlapping build (default `warn`) | `geometry` report + `warnings` returned; `PlaceOn = c` put the new part exactly on top (y = 10); `S.fits` true on free space, false where blocked |
| `run` with `geometry_policy: "reject"` | `geometry_violation`, `undo: "cancelled"`, nothing left in the place |
| Fix loop | two `run`s using `S.placeOn` + `S.overlaps` (12 parts re-seated, trims shortened, markers raised): **27 → 3**; the 3 left are invisible `CoinSpot` marker parts inside wedge ramps, flagged `approximate` + `decor` (bounding-box check on wedges) |
| `look` (no API key) | answered through the user's Claude Code login: `provider: claude-cli`, model `sonnet`, 6.8 s model / 8.0 s wall, sensible one-sentence description |
| `cloud info group` with a group-owned key | `unauthorized` + `key_type_limit: true` with the explanation (Roblox Groups/Users endpoints accept user keys only); universe-scoped calls all work |
| Marker parts | Invisible + non-colliding parts (spawn spots, waypoints, triggers) are now skipped by the check; final arena audit: **0 overlaps, 0 nested** across 267 parts (230 geometry, 37 markers) in 1.1 ms |

## Cloud surface — live results so far, and what is still open (offline state: `npm test` 374/374 in 30 files, `npm run selftest` 57/57, `luau:check` only the advisory `version()` lint, rbxmx 18515 chars)

Every path, verb and body field was checked against Roblox's OpenAPI spec and guides, and the request shapes are pinned by `tests/cloud/surfaces.test.ts` and `probe.test.ts` against a fake Open Cloud. Read-only checks against the real service (2026-09-14, no Studio session connected):

| Check | Result |
|---|---|
| MCP handshake of the built server (stdio, launched the way Claude Code launches it, on a spare port) | 9 tools; `cloud` lists 12 actions and 10 `info` targets; server instructions 2017 bytes, `cloud` description 1994 bytes, every tool description under 2048; stdout carries MCP only |
| `info what:"key"` with the real key | `method: "introspect"` in 284 ms — the key-in-body contract works. Every scope string in the capability table matched the key's own list, including `universe-places:write` (hyphenated) and `memory-store.queue:dequeue` |
| Introspection shape | resource ids arrive as string arrays: `universeIds` on most scopes, `universeDatastores` as `{universeId}` entries (no `datastoreName` when a scope covers every store), `groupIds` on `asset`. `authorizedUserId` is a number. A key without an expiry sends no expiry field, so which documented spelling Roblox uses is still open |
| Memory store scope spelling | the bare OpenAPI form (`memory-store.sorted-map:read`, `memory-store.queue:add`, …); tables and `403` messages now name it |
| Corrected from the live shape | `user.user-notification` is universe-bound on a real key, so `notify` is now judged against the universe like the other universe-scoped calls |

Then with Studio connected to a throwaway test place in the key's universe, writes approved by the owner (2026-09-14). Everything created was deleted, lifted or archived afterwards where Roblox allows it (a Model asset cannot be archived, so the test one stays in the group's inventory, unused), and the place itself was left unchanged:

| Check | Result |
|---|---|
| `info what:"key"` with the session | `bound_to_this_universe: true`; every universe-scoped capability judged against the key's universe list |
| `memory` sorted map | `map_set` (duration `ttl`, numeric sort key) → `map_list` → `map_get` → `map_delete` all correct; the last page carries `nextPageToken: null` |
| `memory` queue | `queue_add` → `queue_read` → `queue_discard` work, but the live read answers `queueItems` and `id` instead of the spec's `items` / `readId`. The tool's fallback read both, and `:discard` accepts that id as `readId` |
| `asset_upload` | a PNG Decal and a hand-written ASCII `.fbx` Model both approved (1.4 s and 11 s) |
| `asset update` | a new `.fbx` put revision 2 behind the same Model id. A Decal answered `400 Updating Decal is not supported yet`, so the tool now refuses non-FBX files locally. A metadata-only update came back as an operation with the version unchanged, and the result no longer claims a new version |
| `asset versions` / `rollback` / `archive` / `restore` | versions newest first; rollback from v2 to v1 created v3, and Roblox accepted the JSON body (`sent_as: "json"`). The Decal archived (`Archived`) and restored (`Active`); the Model answered `400 … is not an archivable asset type` |
| `instance children` / `update` | reads settle in ~0.8–0.9 s. The root's ~90 children overflowed the 20 KB cap in the verbose form (50 shown, 41 cut, and `maxPageSize` is not implemented); children are now compact and all fit in ~11 KB. An update aimed at a Part as a Folder failed inside the operation with `Incorrect Class Type: Instance is of type Part`, so the write route works |
| `restriction` | `list` / `get` / `logs` correct; a 60 s universe-level `ban` on the owner's own account and the `unban` both applied, and `logs` showed both. A 60 s `level: "place"` ban went through the place path and was lifted the same way. User id 1 answered `429 too many requests for user 1` on every attempt, retries included, so ban / unban are no longer retried |
| `notify` | auth and body accepted; Roblox refused the recipient with `400 FAILED_PRECONDITION … not opted in`, which the error now says (`not_opted_in: true`) |
| `info memberships` / `inventory` | both `401` for a group-owned key. Inventory words it `Authentication type provided was invalid!`, which the tool had blamed on the key; it now reports `key_type_limit`, and the key report marks `info inventory` unknown |
| Saving the place from Studio | not possible from a plugin: `game:SavePlace` → "can only be called from a server script"; `SerializationService` refuses services; the only plugin save calls are dialogs for a selection |

Still to verify live:

1. **`publish`** of a place file saved from Studio → `version_number` increments. Note whether the place being open in Studio causes the documented busy-place `409`.
2. **`instance update`** succeeding on a script in the published place (needs a published place that has one), read back with `cloud luau`.
3. **`notify`** delivered: needs an opted-in player and a real notification string.
