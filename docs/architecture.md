# Studio Live — architecture (v1.1)

A real-time Roblox Studio connector for AI agents. Decision record; the wire contract is in [protocol.md](protocol.md), measurements in [live-measurements.md](live-measurements.md), live verification in [live-test-results.md](live-test-results.md), research in [research-brief.md](research-brief.md). The v1.1 state below is what the code implements; items marked **(v1.1)** in the other docs were specified from the live findings of 2026-09-11 and the [multi-agent build report](multi-agent-build-report.md) and are awaiting their next live check.

## Why the existing MCPs feel slow (and what we can and cannot fix)

| Cost per agent action | Community MCP today | Official StudioMCP | Studio Live |
|---|---|---|---|
| Transport wait | 0–500 ms poll (mean 250 ms) per hop, 2 req/s dispatch, 1 Hz stop mailbox | WebSocket (already push) | 1 frame (16 ms) push both ways |
| Observation | one screenshot or one tree read per LLM turn | same | events are **pushed** (Monitor ws); structured diffs; screenshots 30 ms via Win32; `look` answers visual questions in text |
| Playtest | stop → edit → start = ~3 s + 2 turns | same | playtest **stays alive**; code is hot-patched in ≤17 ms; edit-DM trees are `push`ed into it |
| LLM turn | 2–10 s **per micro-tool** | same | one turn ships a whole Luau *program* or *controller*; several agents share one Studio through a FIFO write queue |
| Tool count | 81 tools | 27 | 9 tools, each < 2 KB description |

The LLM turn itself cannot be removed. The design therefore (1) moves closed loops **into Studio** (controllers run at Heartbeat, `run_until` predicates, in-engine assertions), (2) makes every turn do more (programs against a resident `S` API, skills, file-based code arguments), and (3) streams observations to the agent instead of making it ask.

## Components

```
Claude Code ──stdio MCP──► bridge (Node 24, 127.0.0.1:47800)
Claude Code ◄──Monitor ws── ├─ /events   (fan-out: batched, seq-numbered, ≤4 KB frames; `vision` events join here)
                            ├─ /studio   (ONE WebSocket per Studio process, from its edit DataModel)
                            ├─ /rpc      (secondary MCP processes, `studio-live call`, `studio-live sync` proxy through it)
                            ├─ journal   (event ring + backfill), jobs, skills (disk; 8 builtins in the package)
                            ├─ persist   (persisted controllers: memory per session + <home>/persist/<placeId>.json;
                            │             re-sent to the hub as `persist_sync` on every hello)            (v1.1)
                            ├─ capture   (PowerShell worker: PrintWindow → resize → JPEG/PNG)
                            ├─ cloud     (`cloud`: Open Cloud client, apis.roblox.com; ids from the session, key from disk)
                            ├─ vision    (`look`: capture → Claude vision → text answer / `vision` events on /events)
                            └─ twin      (`studio-live twin <place.rbxl>`: launches a second Studio on a local place,
                                          waits for its session in GET /status)                             (v1.1)

Studio (one process per session; a twin is a second process = a second session)
  EDIT DM      bootstrap plugin (StudioLive.rbxmx, tiny, installed once — never changes)
               └─ runtime "hub" (delivered by the bridge as source modules on connect)
                   owns: WS link, request dispatch + FIFO write queue, ChangeHistory, event journal,
                         PluginConnection star to every play DM, playtest control (play / run / multiplayer),
                         push (SerializationService), the in-memory persisted-controller list (fed by the bridge)
  PLAY-SERVER  bootstrap → runtime "agent" (bundle arrives over PluginConnection)
  PLAY-CLIENT  bootstrap → runtime "agent"  (controllers, VirtualInput, run_until, pathfinding)
  PLAY-CLIENT:N (multiplayer: separate Studio processes, each with its own agent runtime)
```

Key verified facts that shape this (see live-measurements.md):
- One `CreateWebStreamClient` WebSocket from the edit DM; Studio's pool is 4 process-wide, so play DMs never open sockets — they talk to the hub over `PluginConnectionService` (edit ↔ each test DM, reliable, ordered, buffered before bind).
- Plugin identity for PluginConnection is per plugin thread, so runtime code delivered as `ModuleScript`s and `require`d by the bootstrap keeps full plugin rights. The bootstrap is the only file on disk; the runtime ships inside the npm package and is pushed on every connect → **Studio restarts once at install, never again**.
- **`plugin:GetSetting` returns `nil` for every key in Studio 0.738** (measured live: right after `SetSetting`, a second later, and for another plugin's keys). Nothing durable can live in plugin settings, so persisted controllers are stored by the **bridge** (memory per session + `<STUDIO_LIVE_HOME>/persist/<placeId>.json`) and handed to the hub on every hello as `persist_sync`; the hub only keeps an in-memory registry and re-installs on every peer hello **(v1.1)**.
- Play-client DM: no `loadstring`, no HTTP. Agent programs there run as `ModuleScript` wrappers. Server/edit use `loadstring` (better syntax errors).
- Hot patch: write `Script.Source`, toggle `Disabled` → new code runs next frame. Controllers are modules with `load(ctx)`/`unload()`; reinstall = fresh ModuleScript instance.
- Vision: Win32 `PrintWindow` on the Studio HWND from the bridge (30–45 ms, works occluded, not minimized — the bridge un-minimizes without stealing focus). `StudioCaptureService` is gated off in Studio 0.738; legacy `CaptureService` is a slow fallback only (not built).
- Input: `UserInputService:CreateVirtualInput()` in the play-client plugin VM: keys, mouse buttons (+GuiInset), absolute mouse position, relative look (needs `MouseBehavior=LockCenter`; the default camera script ignores virtual deltas), text. `VirtualInputManager` is blocked. `SendPointerAction` produces no MouseWheel events → **no scroll**.
- Undo: edit-DM programs run inside one `ChangeHistoryService` recording; any error → `Cancel` = full rollback. `Instance:Destroy()` locks `Parent`, so a destroyed instance can be neither rolled back nor undone — `S.destroy` therefore sets `Parent = nil` in the edit DM and keeps the reference until the recording finishes **(v1.1)**; raw `:Destroy()` in a program is reported as a `warnings` entry. Play-DM writes are `ephemeral` (discarded on stop, no undo).
- Push: Claude Code's Monitor tool accepts `ws://127.0.0.1` and delivers each text frame to the model. Frames are batched (≤10 Hz), small (≤4 KB), carry `seq` and `dropped`; a gap is recoverable with the `events` tool.
- Concurrency: edit-DM writes are exclusive per DM but **queue** (FIFO, 500 deep) instead of answering `busy`; queued writes drain back-to-back inside the 8 ms cooperative slice — shared by every program launched in that frame through `ctl.sliceStart`, so a late launch yields at its first `S.yield()` — then yield a frame **(v1.1)**. Five builders wrote to one place concurrently in the Coin Rush test without a single `busy`.
- Engine-internal trees (`CoreGui`, `CorePackages`, `RobloxReplicatedStorage`, `VoiceChatInternal`, `PluginGuiService`, `RobloxPluginGuiService`, `Stats`, anything named `RobloxReplicated*`) are excluded from change counts and `change` events **(v1.1)** — a client run no longer reports `VoiceChatInternal` as its own addition. Removals are counted even under Deferred signal behaviour (the handler runs after `Parent` is nil): the journal remembers each instance's last parent and reports the path it had.

## Tool surface (9)

| Tool | Purpose |
|---|---|
| `run` | Execute a Luau program against the resident `S` API in `edit` (undoable) or `server`/`client:N` (ephemeral). `code` or `code_file` (absolute path, read by the bridge — no shell/JSON escaping touches Luau) **(v1.1)**. Returns value, captured output, change counts, duration, plus `warnings` (`:Destroy(` in an edit-DM program) and `unwritable` (properties the plugin VM cannot set) **(v1.1)**. |
| `observe` | Read-only: `status`, `tree` (an explicit `root` is always returned, `n: 0` when empty), `props`, `find`, `diff` (since cursor), `logs` (`dm: "all"` merges every DM; play-DM startup output has real seqs), `script` (`{path, from, to}` line ranges, exempt from the 8 KB string cap), `stats`, `selection`, `player`, `screenshot`, `windows`, `selftest` **(v1.1 additions marked in the guide)**. |
| `playtest` | `start` (`play` / `run` / `multiplayer` with `players` client Studios) / `stop` / `status` / `add_players`; `run_until` (predicate in-engine, `predicate_file`); `install`/`uninstall`/`list` controllers (`code_file`; `persist` is stored by the bridge, `list` shows `source: "bridge"`); `hotpatch` a script's source in a live DM (`source_file`); `push` edit-DM instances into the live test (`replace` default true: a same-named, same-class sibling at the target parent is removed first, `replaced: n`; Terrain, the camera and player characters are `skipped`). |
| `input` | Human-like input sequences in the play client (keys, clicks, move, look, text, wait, focus; no scroll — engine limit). |
| `events` | Long-poll backfill of the event journal (`since`, `kinds`, `timeout_ms ≤ 50000`) — the portable fallback to Monitor push. |
| `skills` | Agent-authored Luau program library on disk: `list`/`get`/`save` (`source_file`)/`delete`/`run`, plus eight read-only builtins. |
| `job` | `status`/`cancel`/`wait`/`list` for long operations that returned a handle. |
| `cloud` | Roblox Open Cloud for the open place: data stores, ordered stores, MessagingService publish, universe/place/owner info, asset upload, server-side Luau execution. Ids default from the session's `hello`/`hb` identity (`game.GameId` / `PlaceId` / `CreatorType` / `CreatorId`); the key lives on disk, never in the bridge ([cloud.md](cloud.md)). |
| `look` | Vision sidecar: `question` → one capture → Claude vision → text answer (no image in the agent's context); `watch` → capture every `interval_s`, skip unchanged frames, stream `vision` events on `/events`; `list` / `stop` ([vision.md](vision.md)). |

Annotations: `observe`, `events` and `look` are `readOnlyHint: true` so Claude Code runs them in parallel with other calls; `job` is not, because `cancel` rolls back an edit-DM recording. `cloud` and `look` are `openWorldHint: true` — the only tools that talk to something other than the local Studio (apis.roblox.com, the Claude API).

Outside MCP the same tools are reachable through `POST /rpc`: `studio-live call <tool> [json | -] [--args-file f] [--code-file f] [--source-file f] [--predicate-file f] [--raw]` (exit 1 on `isError`) **(file flags v1.1)**, `studio-live sync <dir>` ([sync.md](sync.md)) and `studio-live twin <place.rbxl>` **(v1.1)**.

## How the pieces fit in v1.1

- **Multiplayer playtests.** `mode: "multiplayer"` runs `StudioTestService:ExecuteMultiplayerTestAsync(players, {})`; each client is a separate Studio process that hellos over its own PluginConnection as `client:N` (`Player1..N`, negative user ids). `add_players` grows a running test. Live: start 24 s for two clients, `add_players` 11 s, `stop` 0.45 s. Tests started from Studio's own buttons or by other tools are detected and adopted (mode inferred from the peers).
- **Push.** `playtest push {paths, dm, parent?, replace?}` serialises edit-DM instances with `SerializationService` on the hub, ships them base64 over L2 (chunked) and deserialises them in the play DM; a server push replicates to every client. Live: 72 ms serialise + replication for a probe model. `replace` (default true) removes an existing same-named, same-class sibling under the target parent first **(v1.1)**; engine- and player-owned siblings are never touched (`skipped`).
- **Persistence in the bridge (v1.1).** `install {persist: true}` → the bridge records `{placeId, dm, name, code}` in memory for the session and in `<home>/persist/<placeId>.json` (the union of every session on that place, so a twin never erases the original's entries; memory-only for an unsaved place); `uninstall` removes it. The bookkeeping hangs on the job, so an install that outlives `wait_ms` is still stored (`persist_pending: true` in the handle), and a persisted controller whose re-install fails on a peer is retried on that peer's next hello, not on every sync. On every hub hello (fresh connect, reconnect, bundle push / runtime restart) the bridge sends `persist_sync {controllers:[{dm, name, code}]}`, which **replaces** the hub's in-memory list; the hub re-installs the entries for a DM whenever that DM's runtime says hello (playtest start of any mode, Studio's own Play button, late multiplayer joiners), and a sync that arrives after a peer's hello (the agents restart before the hub runtime after a bundle push) installs only what that peer lacks — never restarting a controller it already runs. The hub answers `{persisted, rejected, installs_issued}`; the bridge reads only `ok`. Survives bridge restarts (file) and Studio restarts (keyed by place); `playtest list` shows the entries with `source: "bridge"`. `hub/persist.luau` is an in-memory registry only.
- **Script sync.** `studio-live sync <dir>` is a `/rpc` client (push disk → Studio as one undo step per batch, hot-patching server scripts into a live test; pull Studio → disk polled every 2 s by checksum). Scripts and Folders only; no deletions — [sync.md](sync.md).
- **Vision sidecar.** `look` captures the Studio window and asks a Claude vision model; answers are text, watches stream `vision` events on `/events` only (never the journal). Needs a Claude credential in the bridge environment — [vision.md](vision.md).
- **Open Cloud.** `cloud` uses the identity the hub reports in its heartbeats (`universeId`, `creatorType`, `creatorId`; `placeId` from `hello`), so an agent needs no ids for the open place — [cloud.md](cloud.md).
- **Twin launcher (v1.1).** `studio-live twin <place.rbxl> [--port N] [--timeout ms] [--exe path]` finds `RobloxStudioBeta.exe` under `%LOCALAPPDATA%\Roblox\Versions\version-*\` (newest folder that has it; then `%ProgramFiles(x86)%\Roblox\Versions`; `--exe` / `STUDIO_LIVE_STUDIO_EXE` override), spawns it detached with the place file as argument (a spawn failure or an early exit is reported at once), and waits up to 90 s for a new session in `GET /status`, printing its session id and place. Two sessions are then connected: tools take `session` (GUID or unique prefix); writes refuse to guess. A twin is a full Studio, not a headless engine — it is the way to run regression on a copy of the place while the human keeps the original.
- **Multi-agent use.** Several subagents drive one Studio through `POST /rpc` / `studio-live call`; the write queue serialises their edit-DM programs, `S.ensure(path, class, props?)` **(v1.1)** gives create-if-missing shared roots, and file-based code arguments keep Luau out of shell quoting. The contract agents follow is the "Multi-agent contract" section of the [agent guide](agent-guide.md); the measured run is the [multi-agent build report](multi-agent-build-report.md).

## Acceptance tests (replace "agent reacts to every frame")

- **T1** one `playtest install` call ships a controller that plays for 60 s and reports assertions/milestones as events while the human keeps editing.
- **T2** one `run`/`playtest hotpatch` call changes behaviour in the live playtest without restarting it.
- **T3** an assertion failing in-game reaches the agent's context via Monitor without the agent asking.
- **T4** one `run` call builds a 2000-part structure in the open place as one undo waypoint.
- **T5 (v1.1)** five agents build one game concurrently in the same place, a sixth tests and fixes it in a live playtest, with no `busy` and no restart — passed as Coin Rush (report linked above).
- SLOs: Studio event → bridge ≤ 50 ms; bridge → model (idle) ≤ 250 ms; model decision → in-engine effect ≤ 1 s; playtest kept alive across ≥ 20 actions.

All of T1–T5 passed live on Studio 0.738 ([live-test-results.md](live-test-results.md)).

## Phasing

| Phase | Status | Contents |
|---|---|---|
| **v1** | done, live-verified | bridge + bootstrap + runtime hub/agent + 7 tools + Monitor fan-out + PrintWindow capture + skills + docs/install |
| **v1.1** | this build; live-verified 2026-09-11 | multiplayer playtests (`mode: "multiplayer"`, `add_players`), `SerializationService` `push`, FIFO edit-DM write queue, script sync (`studio-live sync`), 8 builtin skills, the `cloud` Open Cloud tool, the `look` vision sidecar, `studio-live call`, place identity in heartbeats — nine tools |
| **v1.1 fix pass 3** | specified from the live findings + multi-agent report; implemented in this tree, live check pending | persistence moved into the bridge (`persist_sync`) after `GetSetting` proved dead (L1); `push replace` (L2); write queue drains several writes per frame (L3); engine-internal trees ignored in change counts (L4); `code_file` / `source_file` / `predicate_file` + `call --code-file` + "Malformed string" hint + escape selftest (F1); undoable `S.destroy`, `:Destroy(` warnings (F2); play-DM startup logs with real seqs (F4); `observe logs dm:"all"` (F5); script line ranges + `observe script` (F6); `ctx.pathTo` / `S.pathTo` (F7); unwritable-property tolerance in `S.set` (F8); explicit `observe tree` root always returned (F9); `S.ensure` + multi-agent contract (F10); `studio-live twin` (T) |
| **v1.1 fix pass 4** | review of the fix-pass-3 tree, 23 findings fixed offline; live check pending | removals counted under Deferred signals (journal remembers parents); history dedupe only client-vs-server; `S.ensure` without a class; `unwritable` mirrored into `warnings`; `push replace` by name + class with `skipped`; failed persisted installs not retried per sync; write slice shared per frame (`ctl.sliceStart`); `observe script` single-line cut / `observe tree` root vs `classes`; `pathTo` `unreachable` / stop-on-exit; bridge: persistence on the job (`persist_pending`), `uninstall` keyed on the caller's dm, honest `persist_file`, place file = union of sessions, 4 MB program-file cap, file-aware `Malformed string` hint, CLI stdin release / `--timeout` validation / `twin --exe` + ProgramFiles scan + spawn errors; docs reconciled |
| **v2** | not started | in-engine `CaptureService` capture fallback (non-Windows), PluginConnection payload-cap auto-probe, headless twin for logic regression (the v1.1 twin is a full Studio), sync deletions / renames / properties / models, `observe diff` noticing `Source` edits |

### Still not done, by design or by engine limit

- **Scroll input** — `SendPointerAction` produces no MouseWheel events; scroll a `ScrollingFrame` from a `run`. **Camera turn by virtual mouse delta** — the default camera script ignores it; set `CurrentCamera` from a `run`.
- **Undo of play-DM writes** — the engine has no ChangeHistory in test DMs; everything there is ephemeral. **Undo of raw `:Destroy()`** — `Parent` is locked; only `S.destroy` (Parent = nil) is recoverable.
- **Plugin settings** — `GetSetting` is dead in this build; nothing in the runtime may rely on it (the selftest keeps its persist checks in memory).
- **Properties the plugin VM cannot touch** (`Lighting.Technology`, `Workspace.SignalBehavior`, …) — reported, not worked around; the human sets them in the Properties panel.
- **Sync** — scripts and Folders only, no deletions in either direction.
- **`look` and `cloud`** need credentials on disk / in the environment; they are the only network-facing pieces.
- **Screenshots** are Windows-only (`PrintWindow`); the twin launcher is Windows-only (`%LOCALAPPDATA%\Roblox\Versions`).
- **L2 payload cap** above 1 MB is unverified; chunks stay at 16 KB.
