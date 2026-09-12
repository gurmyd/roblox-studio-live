# Multi-agent build test — Coin Rush on Studio Live (2026-09-11)

Six Claude Code subagents drove one live Roblox Studio (place PIRATES, Team Create) through the Studio Live bridge: five builders (map, coins, rounds, hud, atmosphere) ran **concurrently** against the same edit DataModel, then a tester/fixer loop ran playtests until the game passed. Every agent talked to the bridge over `POST /rpc` (Node helpers in the session scratchpad), not through MCP tool calls.

**Outcome:** a playable Coin Rush (arena, 20 live coins, 10/45/5 s round loop, HUD, sunset atmosphere) built in ~6 minutes of wall clock, one blocking gameplay bug found by the first playtest, fixed in one round, PASS on the second playtest. Total ≈ 22 minutes from the first builder program to the PASS verdict. No bridge call failed for bridge reasons; the friction was in *how agents get Luau into the tools* and in a few silent semantics (`dry_run` vs `Destroy()`, invisible startup prints, 8 KB script reads).

## 1. What got built

| Agent | Undo step | Result (edit DM) |
|---|---|---|
| map | `agent:map: build CoinRush map` | `Workspace.CoinRush.Map` — 250 parts: 168-tile two-tone floor + SpawnPad, 4 walls with gold trim, 3 platforms (decks at y 6/12/18, legs, wedge ramps, raycast-verified), 6 pillars, 36 invisible `CoinSpot` markers (tag + `Height`/`Index` attributes), a neutral `SpawnLocation`. Idempotent rebuild. |
| coins | `agent:coin: build CoinRush coin system` | `ServerScriptService.CoinRush.CoinSpawner` (Script, 7.6 KB): 20 neon cylinder coins on `CoinSpot`s, spin/bob Heartbeat loop, Touched → leaderstats `Coins` += 1, `CoinCollected:FireClient`, respawn after 3 s; `Workspace.CoinRush.Coins` folder. Dry-run tested with shimmed services before commit. |
| rounds | `agent:rounds: install RoundManager + shared CoinRush folders/remotes` | `ServerScriptService.CoinRush.RoundManager` (5.1 KB): lobby 10 s → running 45 s → ended 5 s; `State`/`TimeLeft` attributes on `ReplicatedStorage.CoinRush`; `RoundState` remote once per second and on change; winner in `ended`; scores zeroed at round start via `ResetScores` BindableEvent. Run twice, second run `created: []`. |
| hud | `agent:hud: build CoinRushHud + CoinRushClient` | `StarterGui.CoinRushHud` (state/time panel, score label, `+1` pickup flash) + `StarterPlayerScripts.CoinRushClient` LocalScript (5.3 KB, timeouts on every `WaitForChild`, re-hooks leaderstats). |
| atmosphere | `agent:atmosphere: lighting + decor + CoinSparkle` | Lighting properties + `CoinRushSky`/`Atmosphere`/`Bloom`/`ColorCorrection`; `Workspace.CoinRush.Decor` (28 parts: tilted "COIN RUSH" SurfaceGui sign with neon frame, 4 amber beacon posts placed by raycasting the map's deck corners); `ReplicatedStorage.CoinRush.CoinSparkle` ParticleEmitter template. Re-run three times, idempotent. |

Shared contract (`Workspace.CoinRush`, `ReplicatedStorage.CoinRush` + two RemoteEvents, `ServerScriptService.CoinRush` + `ResetScores`) was created by whichever agent got there first (atmosphere created `Workspace.CoinRush`, rounds created the ReplicatedStorage side); everyone else used create-if-missing. All five builders reported `undo: committed`; no playtest was running during the build so no `undo: unavailable`.

Screenshots: `%TEMP%\studio-live\frames\frame-20260911T153330587-0002.jpg` (map), `…T153554430-0003.jpg` (atmosphere), `…T153855853-0004.jpg` / `…T154217420-0005.jpg` (round 1), `…T155108844-0006.jpg` / `…T155129791-0007.jpg` (round 2, "GO! 0:32", "Coins: 7").

## 2. Did the game work? Playtest assertions

### Round 1 — FAIL (one blocking bug in CoinSpawner)

Tester: `playtest start play` (1.5 s, server + `client:1 roblox_user_100000001`) → `coinbot` controller installed on client:1 twice (40 s each) → `run_until` server → `events` → 2 screenshots → `playtest stop` (1.0 s).

Passed, quoted from the verdict:

> `hud_exists`, `character_spawned`, `coins_folder_exists`, `coins_present`: 2/2 ok each. `score_increases`: 146 ok / 2 failed (both failures are test artifacts). Pickup works: coin destroyed, `CoinCollected` fired, leaderstats updated.
> `run_until` (server, a player has leaderstats.Coins >= 3): satisfied instantly (`coins:48`).
> RoundManager: telemetry every 5 s showed lobby(10 s) -> running(45 s) -> ended(5 s) cycling … in all 60 telemetry samples ScoreLabel text == leaderstats.Coins and TimeLabel == TimeLeft attribute.

Failed:

> **FAILURE 1 (blocking)** — one coin touch is counted many times, and the alive-coin cap breaks. Server instrumentation (6 s window): 12 coin removals vs **95** leaderstats.Coins changes (~8 per coin); client saw `CoinCollected` fire 5-9 times in the same millisecond … Bot asserts: `attempt 20: before=36 after=46` (10 points for one coin), 64 of 94 successful pickups in run 2 had delta > 1. `coins_in_world` climbed 18 -> 26 -> 29 -> 34 -> 35/36 and stayed there although `MAX_COINS = 20`.
> **FAILURE 2 (design)** — coins respawn under a standing player: all 11 respawns in 6 s landed **1.1 studs** from the idle player … score 0 -> 89 in 5.5 s with no movement.

Root cause (found by the tester from the source): the `collected[coin]` debounce was cleared right after `coin:Destroy()`, so the queued `Touched` invocations from the other limbs each scored, fired the remote, decremented `activeCount` (going negative) and scheduled another respawn.

### Fix — one round

Fixer patched the live script in one undo step (`agent:fixer: CoinSpawner multi-touch + respawn clearance`, 251 → 273 lines, `loadstring` check before write and on read-back): the `active[coin]` record became the only guard and is claimed before any side effect; new `PLAYER_CLEARANCE = 8` / `nearPlayer()` skips spots near a player and retries in 1 s when every free spot is blocked. The coin agent's `build.json` was regenerated so re-running the builder reproduces the fix. No playtest was started by the fixer.

### Round 2 — PASS

> **Re-test criteria from the fixer — all met**: `coins_cap_20`: 36/36 ok (telemetry 18–20; server `max_coins_in_folder=20`) · `score_delta_is_one`: 44/44 ok · `coincollected_fires_once`: 44/44 ok (`remote_fires_total` 24 and 21 == pickups) · `respawn_clearance`: 45/45 ok (server `min_respawn_dist=51.2`).
> `hud_exists`, `coincollected_remote_exists`, `character_spawned`, `coins_folder_exists`, `coins_present`: 2/2 ok each. `run_until` server "a player has leaderstats.Coins >= 3": `result:true, value:{player:roblox_user_100000001, coins:24}`.
> Logs since playtest start (seq > 1172): … **zero warn/error lines** from CoinSpawner, RoundManager or CoinRushClient.

One assertion still failed and was correctly classified as a test artifact:

> seq 1533, client:1, `score_increases`: `attempt 22: coin at -39, 19.84, -39, moveTo reached=false, hrp now -38.99, 3.12, -39.06, dist 16.7 …` — the coin sits on the PlatformHigh deck (y≈18) directly above the bot; `ctx.moveTo` has no pathfinding so it timed out under the deck.

**Fix rounds: 1** (two playtest rounds, one fixer pass). The only remaining open item is a design choice, not a bug: coins are collectable during `lobby`/`ended` (matches the contract as written).

## 3. Wall-clock feel — did agents wait on each other?

Reconstructed from scratchpad file mtimes and screenshot timestamps:

| Time | What |
|---|---|
| 15:30:34 | rounds builder written and run (first committed write) |
| 15:31:16–15:31:40 | hud built (including the `dry_run` mishap, §4 F2) |
| 15:32:51–15:33:44 | coins dry-run test, build, spot check; map built and screenshotted (15:33:30) |
| 15:35:36–15:35:54 | atmosphere built and screenshotted (last builder) |
| 15:38:02–15:43:07 | tester round 1: playtest, 2 × 40 s bot runs, instrumentation, verdict FAIL |
| 15:45:45–15:46:16 | fixer: source patched, written, read back |
| 15:48:30–15:52 | tester round 2: playtest, 2 × 40 s bot runs, 8 s server sampler, verdict PASS |

- **Builders did not wait on each other.** Five agents wrote to the same edit DM inside a 5.5-minute window; the stagger is LLM thinking time, not queueing. No agent saw `busy`, and none reported a `queued behind N` progress note; the per-DM FIFO write queue (runtime v1.1) serialized them invisibly. The map agent measured every `run`/`observe` under 150 ms; the tester logged HTTP 200 throughout.
- **The only dependency edges were by contract, not by tool:** the coin spawner waits up to 10 s for `Workspace.CoinRush.Map` *at runtime*; the atmosphere agent raycasts the decks (and falls back if absent). Nobody blocked at build time.
- **The serial part was the test loop**, and inside it the tester waited on its own controllers (2 × 40 s bot runs per round ≈ 1.5 min of the ~5 min round), not on the bridge: `playtest start` 1.5–1.7 s, `stop` ≈ 1 s, `install` and `run_until` instant.
- Lost time that *was* tool-induced: the coins agent's and fixer's escaping detours (writing Node wrappers, retrying), the HUD agent's re-run after `dry_run` deleted its instances, and the fixer reading a 273-line script in ranges. Each cost a few LLM turns rather than seconds of engine time.

## 4. Tool friction — every point, with a recommendation

Severity: **H** = cost real work or lost data, **M** = cost turns, **L** = cosmetic/docs.

### F1 (H) Luau inside JSON inside a shell heredoc — three agents, one misdiagnosis
- **Seen by:** coins (`'[^\\n]+'` in a pattern → `syntax_error: StudioLiveProgram:3: Malformed string`), fixer (twice; concluded "the bridge appears to unescape `\n` into a real newline before compiling"), tester round 2 (repeated the claim as a note for other agents). Each wrote a Node helper to inject file contents into the request (`mk.mjs`, `build.mjs`, `tester_call.mjs … code=<file.luau>`) and switched to `string.char(10)` in Luau.
- **Root cause — verified today, not a bridge bug:** a probe through the same `POST /rpc` path with a correctly formed JSON body (a probe script run from the session scratchpad) returned `value: 3` for `return #"a\nb"`, `return #"a\tb"`, and `1` for `("x\ny"):find("[^\n]+")`, all `ok` in 16–33 ms. The failures came from the shell layer (bash/PowerShell heredocs collapse `\\n` to `\n` before JSON parsing), which puts a raw newline inside a short Luau string.
- **Recommendation:** (a) add `code_file` / `source_file` / `predicate_file` alternatives to `code` / `source` / `predicate` on `run`, `playtest install|hotpatch|run_until` and `skills save` — the bridge reads the file, no shell or JSON escaping ever touches Luau; (b) `studio-live call run --code-file build.luau --args-file args.json`; (c) when a `syntax_error` says "Malformed string" and the received code contains a raw newline inside a quoted literal, append a hint ("your transport turned `\n` into a newline — pass code from a file"); (d) an agent-guide box: never pass Luau through a heredoc; and (e) a `selftest` case for escapes so the next agent does not re-diagnose a non-bug. Also correct the fixer's/tester's note wherever it was copied.

### F2 (H) `dry_run` rollback (and Ctrl+Z) silently lose `Destroy()`ed instances
- **Seen by:** hud. A `dry_run` of a program that destroys-then-recreates `StarterGui.CoinRushHud` and `CoinRushClient` returned `undo: "cancelled"`, removed the recreated copies, and did **not** restore the originals — both paths were nil afterwards. The agent had to re-run the real build.
- **Root cause:** `Instance:Destroy()` locks `Parent`, so `ChangeHistoryService` cannot re-parent on Cancel or Undo. `S.destroy` itself calls `inst:Destroy()` (`plugin/runtime/shared/S.luau:219`), and agent code naturally writes `:Destroy()` too. This means every idempotent "destroy old, rebuild" builder in this test produced undo steps whose Undo cannot bring the previous version back — the agent guide's promise that "an error rolls the whole program back" is false for deletes.
- **Recommendation:** in the edit DM make `S.destroy` set `Parent = nil` and keep the reference until the recording is finished (Destroy after Commit if desired) so Cancel/Undo restore it; document that raw `:Destroy()` inside an edit-DM `run` is not undoable and not rolled back by `dry_run`; optionally scan edit-DM program text for `:Destroy(` and return `warnings: [...]` in the run response.

### F3 (M) No first-class path from a subagent to the tools — everyone reinvented an RPC client
- **Seen by:** all six. None used MCP tool calls; each wrote or copied a `POST /rpc` helper (`rpc.mjs` stdin JSON, `mk.mjs` Luau→JSON wrapper, `tester_call.mjs` field=file injection) plus per-program `.json` wrappers. F1 is a direct consequence.
- **Recommendation:** ship one supported helper in the package (`studio-live call <tool> [--args-file f] [--code-file f] [--source-file f]`, exit 1 on `isError`) and put it in the agent guide's "Scripts and shells" section as *the* way for scripted/subagent use; or register the MCP server for spawned agents so they call `run`/`observe`/`playtest` directly.

### F4 (M) Server-start `print` never shows in `observe logs`
- **Seen by:** tester, both rounds. `[CoinSpawner] N coins spawned …` (printed once at server start) never appeared; the tester had to confirm the script ran from folder attributes and wrote "print output at server start may not be captured".
- **Likely cause:** the server agent runtime hellos after game scripts have already run, and lines seeded from `LogService:GetLogHistory()` carry `seq: 0` and are only returned for `since ≤ 0` (protocol note); the tester was paging with `since: <cursor>`.
- **Recommendation:** at agent start seed the play-DM journal from `GetLogHistory()` and give those lines real seqs (or a `history: true` flag on `observe logs`), and say in the guide how to read startup output. Startup prints are the most common thing a tester wants.

### F5 (L) `observe logs` rejects `dm: "all"`
- **Seen by:** tester (both rounds queried edit/server/client:1 separately).
- **Recommendation:** accept `dm: "all"` (the hub already holds the merged journal; every line already carries `src`).

### F6 (M) `S.script.get` results truncated at 8 KB
- **Seen by:** fixer — a 273-line script came back `…[+N]` and had to be read in line ranges.
- **Recommendation:** `S.script.get(path, {from, to})` line ranges and/or `observe { what: "script", path, from, to }` with paging; exempt script sources from the §7 8 KB string cap up to the 60 K result budget (sync already slices sources for the same reason).

### F7 (M) `ctx.moveTo` is straight-line only
- **Seen by:** tester, both rounds (`moveTo reached=false … dist 16.7`, coin on a deck above the bot). The test had to tolerate a known false failure.
- **Recommendation:** add `ctx.pathTo(pos, timeout)` built on `PathfindingService` (waypoints + jump) and label `moveTo` as straight-line in §6.4.

### F8 (L) Engine capability limits surface as raw errors
- **Seen by:** atmosphere (`Lighting.Technology` → "lacking capability RobloxScript", read and write), tester (`Workspace.SignalBehavior` → "not a valid member of Workspace" from `run`).
- **Recommendation:** a "known unreadable/unwritable from the plugin VM" list in the agent guide; `S.set`/`S.props` could return `{unreadable: [...]}` for those names instead of throwing mid-program.

### F9 (L) `observe tree` on an empty service returns no nodes at all
- **Seen by:** coins — a service root with zero children returned no root node, whereas `Workspace` returned its root. Documented ("services with 0 children omitted") but surprising for a named root.
- **Recommendation:** when `root` is given explicitly, always return that root node with `n: 0`.

### F10 (L) Shared-root races between concurrent builders
- **Seen by:** all builders. `Workspace.CoinRush` and `ReplicatedStorage.CoinRush` were created by whoever ran first; every agent hand-wrote `ensure()`; pre-existing `Workspace.SpawnLocation`/`Baseplate` had no owner and stayed as a second neutral spawn. No tool failed, but the pattern is fragile (a mid-build `dry_run` by one agent could roll back a root another agent depends on — see F2).
- **Recommendation:** `S.ensure(path, class, props?)` (create-if-missing, returns existing, participates in the recording) and a multi-agent section in the agent guide: contract paths, create-if-missing, never destroy shared roots, one owner for Workspace-level cleanup.

### Not tool problems, noted for completeness
- Two `score_increases` failures in round 1 and the reset-window pickup in round 2 were the RoundManager zeroing scores inside the bot's 2 s window — a test-design issue (gate on `State == "running"`).
- The only journal error was an unrelated user plugin (`MCPPlugin … Cannot create a toolbar button at this time`).

### What produced no friction
`run` (edit and play), `observe status/tree/find/props/screenshot/player`, `playtest start/stop/install/run_until/status`, `events` paging (journal 0 → 1560, `dropped: 0`), undo commit/cancel semantics for creates, persisted-controller cleanup (`controllers: []`, `persisted: []` after stop), screenshots (file + base64, readable with `Read`). Nothing was slow: sub-150 ms for every DataModel call, ~1.5 s to start and ~1 s to stop a playtest.

## 5. Recommended changes, in priority order

1. File-based code arguments (`code_file`/`source_file`/`predicate_file`) plus `studio-live call --code-file`, and the "never heredoc Luau" docs box with the escape selftest (F1, F3).
2. `S.destroy` → `Parent = nil` in edit-DM recordings; document that `:Destroy()` is not undoable / not dry-run-safe; optional `warnings` lint (F2).
3. Seed play-DM log journals with startup history and expose it through `observe logs` (F4); accept `dm: "all"` (F5).
4. Line-range script reads (F6).
5. `ctx.pathTo` with PathfindingService (F7).
6. Docs: plugin-VM unreadable properties (F8), empty-root tree shape (F9), multi-agent contract pattern and `S.ensure` (F10).

Artifacts from the run: builder programs and JSON wrappers, `coinbot.lua` / `coinbot2.lua`, `fix.json`, `t2_server_instr.luau`, and the RPC helpers all live in the session scratchpad.
